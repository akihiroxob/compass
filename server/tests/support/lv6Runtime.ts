import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";

/**
 * Task 38: 外部Runtimeと各Agentの最小test harness。Compassの外側のプロセスとして振る舞うため、
 * `src/`を一切importせず、統一`/mcp`（実MCP SDK client）とBearerのCredentialだけでCompassを操作する。
 * DBへ直接触れず、Compass内部のuse caseも呼ばない（`test/lv6ClosedLoop.test.ts`がimportを静的に検査する）。
 *
 * Agentの判断は決定的な規則で書いたscriptであり、LLMではない。ここで確認できるのはCompass側の契約
 * （イベント・ack・冪等性・状態遷移）で閉ループが完走することで、LLM Agentによる自律運転の実証ではない。
 */

export type Json = Record<string, any>;

/** MCP toolが`isError`で返した明示的なエラー。`code`はCompassのエラーコード、`reason`はCONFLICT等の理由。 */
export class ToolError extends Error {
  constructor(
    readonly tool: string,
    readonly code: string,
    readonly detail: Json,
  ) {
    super(`${tool}: ${code} ${detail.message ?? ""} ${detail.reason ?? ""}`);
    this.name = "ToolError";
  }

  get reason(): string | undefined {
    return this.detail.reason;
  }
}

/** Agentのtimeout。Runtimeは結果不明として`retryable_failure`をackし、次の試行で起動し直す。 */
export class AgentTimeout extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AgentTimeout";
  }
}

/** Runtime（またはserver）のプロセス停止。ackせずにtickを抜け、テストが再起動を行う。 */
export class RuntimeCrash extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RuntimeCrash";
  }
}

/** 呼出しの記録。応答消失・重複起動の検証と、相関IDの追跡に使う。 */
export type CallRecord = { principal: string; tool: string; args: Json; ok: boolean; replayOfLostResponse: boolean };

export type Connection = {
  /** 呼出し時点のserver URL。server再起動でportが変わっても追従する。 */
  baseUrl: () => string;
  now: () => number;
  calls: CallRecord[];
  /** 次の1回だけ応答を失わせる（requestは届く）tool名。Agentは同じ入力（同じrequestId / requestKey / attemptId）で再送する。 */
  dropNextResponse: Set<string>;
};

/** 1回のAgent起動 = 1本のMCP session（Agent processの起動に相当）。 */
export const withMcp = async <T>(connection: Connection, principal: string, token: string, run: (call: Call) => Promise<T>) => {
  const client = new Client({ name: `lv6-${principal}`, version: "0" });
  const requestInit = { headers: { Authorization: `Bearer ${token}`, Connection: "close" } };
  await client.connect(new StreamableHTTPClientTransport(new URL(`${connection.baseUrl()}/mcp`), { requestInit }));
  const invoke = async (tool: string, args: Json, replayOfLostResponse: boolean) => {
    const result = (await client.callTool({ name: tool, arguments: args })) as { isError?: boolean; structuredContent?: Json };
    connection.calls.push({ principal, tool, args, ok: !result.isError, replayOfLostResponse });
    return result;
  };
  const call: Call = async (tool, args) => {
    let replay = false;
    if (connection.dropNextResponse.delete(tool)) {
      // requestはserverへ届き処理されるが、応答を受け取れなかった。同じ入力で再送する。
      await invoke(tool, args, false);
      replay = true;
    }
    const result = await invoke(tool, args, replay);
    if (result.isError) {
      const error = (result.structuredContent?.error ?? {}) as Json;
      throw new ToolError(tool, String(error.code ?? "UNKNOWN"), error);
    }
    return result.structuredContent ?? {};
  };
  try {
    return await run(call);
  } finally {
    await client.close();
  }
};

export type Call = (tool: string, args: Json) => Promise<Json>;

export type Tokens = {
  runtime: { principal: string; token: string };
  researcher: { principal: string; token: string };
  strategist: { principal: string; token: string };
  manager: { principal: string; token: string };
  workers: { principal: string; token: string }[];
  reviewer: { principal: string; token: string };
  evaluator: { principal: string; token: string };
};

// ---------------------------------------------------------------------------------------------
// Agents（決定的なscript）
// ---------------------------------------------------------------------------------------------

/** Researcher: Requestの問いに答え、Result・Synthesisを登録して確定する。requestKeyはRequestから決定的に作る。 */
const runResearcher = async (connection: Connection, tokens: Tokens, event: Json) => {
  const { principal, token } = tokens.researcher;
  return withMcp(connection, principal, token, async (call) => {
    const { projectId, researchRequestId: requestId } = event;
    const context = await call("get_researcher_context", { projectId, requestId });
    if (context.request.status !== "requested" && context.request.status !== "in_progress") return "request already closed";
    const now = connection.now();
    const result = await call("register_research_result", {
      projectId,
      requestId,
      requestKey: `result:${requestId}`,
      runRef: `researcher:${requestId}`,
      summary: `Answer to: ${context.request.question}`,
      budgetUsed: 10,
      evidenceRefs: [{ kind: "url", uri: `https://research.example.com/${requestId}`, retrievedAt: now - 1_000 }],
      findings: [{ statement: `Observed for: ${context.request.question}`, confidence: "high", observedAt: now - 1_000, evidenceIndexes: [0] }],
    });
    await call("register_research_synthesis", {
      projectId,
      requestId,
      requestKey: `synthesis:${requestId}`,
      runRef: `researcher:${requestId}`,
      conclusion: `Conclusion for: ${context.request.question}`,
      findingIds: result.result.findings.map((finding: Json) => finding.id),
      validAsOf: now - 1_000,
    });
    await call("complete_research_request", { projectId, requestId, conclusion: "completed" });
    return "completed";
  });
};

/**
 * 最初のOutcome: 2つ目の基準は本番dashboardでしか観測できず、このharnessのRuntimeはその証拠を持たない
 * （→ Evaluatorはinsufficient_evidenceにする）。追加Research後のOutcome: 2つ目をCIで観測できる基準に直す。
 */
export const outcomePlans = {
  first: {
    title: "Claims are exclusive",
    description: "Only one worker owns a Task at a time.",
    rationale: "Research shows leases prevent double work.",
    successCriteria: [
      { description: "Lease-based claim is merged", measurement: "A merged pull request implements the lease" },
      { description: "Double claims stop in production", measurement: "The production dashboard shows zero double claims" },
    ],
  },
  observable: {
    title: "Claims are exclusive and verified in CI",
    description: "Only one worker owns a Task, verified by an automated CI check.",
    rationale: "Additional research: the production dashboard is unavailable, so CI is the observable signal.",
    successCriteria: [
      { description: "Lease-based claim is merged", measurement: "A merged pull request implements the lease" },
      { description: "Concurrent claim test passes", measurement: "A CI run passes the concurrent claim test" },
    ],
  },
} as const;

/** Strategist: research_completedでOutcomeを決め、outcome_evaluatedで再計画かIntent完了を判断する。 */
const runStrategist = async (connection: Connection, tokens: Tokens, event: Json) => {
  const { principal, token } = tokens.strategist;
  return withMcp(connection, principal, token, async (call) => {
    const { projectId, intentId } = event;
    const context = await call("get_strategist_context", { projectId });
    if (context.activeIntent?.id !== intentId) return "intent is no longer active";
    const common = { projectId, intentId, runRef: `strategist:${event.id}` };

    if (event.type === "research_completed") {
      // 評価を経た後の追加Researchなら、観測可能な基準へ直したOutcomeにする。
      const plan = context.evaluations.length === 0 ? outcomePlans.first : outcomePlans.observable;
      const synthesis = (context.research?.syntheses ?? []).find((item: Json) => item.requestId === event.researchRequestId);
      const decided = await call("decide_next_outcome", {
        ...common,
        judgment: `Pursue: ${plan.title}`,
        reason: plan.rationale,
        requestKey: `outcome:${event.researchRequestId}`,
        ...(synthesis ? { usedSyntheses: [{ synthesisId: synthesis.synthesisId, version: synthesis.version }] } : {}),
        outcome: plan,
      });
      return `outcome ${decided.outcome.id}`;
    }

    // outcome_evaluated: 最新でないEvaluation・判断済みのEvaluationには何もしない（重複配送・順序逆転）。
    const evaluation = (context.evaluations as Json[]).find((item) => item.id === event.evaluationId);
    if (!evaluation) return "evaluation is not the latest";
    if (evaluation.decisionId) return "evaluation already decided";
    const result = evaluation.result;
    const requestKey = `decision:${event.evaluationId}`;
    if (result === "insufficient_evidence") {
      const decision = await call("create_direction_decision", {
        ...common,
        type: "additional_research",
        evaluationId: event.evaluationId,
        judgment: "Find an observable signal for double claims",
        reason: "The Evaluation could not observe the production criterion",
        requestKey,
        research: {
          question: "Which automated signal can observe double claims?",
          scope: "CI and test infrastructure of the Project repository",
          completionCondition: "An observable signal is identified",
          budgetTotal: 100,
        },
      });
      return `additional research ${decision.researchRequest?.id}`;
    }
    if (result === "achieved" && context.activeIntent.completionDefinition) {
      await call("create_direction_decision", {
        ...common,
        type: "intent_complete",
        evaluationId: event.evaluationId,
        judgment: "The Intent is complete",
        reason: "The achieved Evaluation satisfies the completion definition",
        requestKey,
      });
      return "intent complete";
    }
    throw new Error(`unsupported evaluation result for this harness: ${result}`);
  });
};

/** Manager: outcome_confirmedを受け、相関ID付きStoryと、taskKeyで収束するTaskを作る。 */
const runManager = async (connection: Connection, tokens: Tokens, event: Json, faults: Faults) => {
  const { principal, token } = tokens.manager;
  return withMcp(connection, principal, token, async (call) => {
    const { projectId, outcomeId, correlationId } = event;
    const story = await call("issue_story", {
      projectId,
      title: `Deliver outcome ${outcomeId}`,
      description: "Created from outcome_confirmed",
      outcomeId,
      correlationId,
      requestId: crypto.randomUUID(),
    });
    if (faults.managerTimeoutAfterStory?.(event)) throw new AgentTimeout("manager timed out after issue_story");
    const existing = await call("list_tasks", { projectId, filter: { storyId: story.id } });
    const keys = new Set((existing.tasks as Json[]).map((task) => task.taskKey));
    if (!keys.has("implement")) {
      const criteria = (story.successCriteria ?? []) as Json[];
      await call("issue_task", {
        projectId,
        storyId: story.id,
        title: `Implement ${outcomeId}`,
        description: criteria.map((criterion) => `- ${criterion.description}: ${criterion.measurement}`).join("\n"),
        taskKey: "implement",
        requestId: crypto.randomUUID(),
      });
    }
    return `story ${story.id}`;
  });
};

/** Worker: 着手可能なTaskを1件ずつClaimして実装し、Commentを残して完了する。差戻し後はtestを足して出し直す。 */
const runWorker = async (connection: Connection, worker: { principal: string; token: string }, faults: Faults) =>
  withMcp(connection, worker.principal, worker.token, async (call) => {
    const done: string[] = [];
    for (const projectId of faults.projectIds()) {
      const available = await call("list_tasks", { projectId, filter: { availableFor: "work" } });
      for (const task of available.tasks as Json[]) {
        const claim = await call("claim_task", { taskId: task.id, requestId: crypto.randomUUID() });
        if (faults.workerHangs?.(worker.principal, task)) {
          done.push(`${task.id}: hung`);
          continue;
        }
        const body = task.rejectReason ? `Addressed review: tests added (${task.rejectReason})` : "Implemented the lease";
        await call("add_task_comment", { taskId: task.id, claimId: claim.claimId, body, requestId: crypto.randomUUID() });
        await call("complete_task", { taskId: task.id, claimId: claim.claimId, requestId: crypto.randomUUID() });
        done.push(task.id);
      }
    }
    return done;
  });

/** Reviewer: 最新のCommentにtestの記述が無ければ差し戻し、あればreview済みにする。 */
const runReviewer = async (connection: Connection, tokens: Tokens, faults: Faults) =>
  withMcp(connection, tokens.reviewer.principal, tokens.reviewer.token, async (call) => {
    const done: string[] = [];
    for (const projectId of faults.projectIds()) {
      const available = await call("list_tasks", { projectId, filter: { availableFor: "review" } });
      for (const task of available.tasks as Json[]) {
        const claim = await call("claim_review", { taskId: task.id, requestId: crypto.randomUUID() });
        const { comments } = await call("list_task_comments", { taskId: task.id });
        const latest = (comments as Json[]).at(-1)?.body ?? "";
        if (/tests added/.test(latest)) {
          await call("reviewed_task", { taskId: task.id, claimId: claim.claimId, requestId: crypto.randomUUID() });
          done.push(`${task.id}: reviewed`);
        } else {
          await call("reject_task", { taskId: task.id, claimId: claim.claimId, reason: "Add a concurrent claim test", requestId: crypto.randomUUID() });
          done.push(`${task.id}: rejected`);
        }
      }
    }
    return done;
  });

/** Manager（受入）: review済みのTaskを受け入れる。 */
const runAcceptor = async (connection: Connection, tokens: Tokens, faults: Faults) =>
  withMcp(connection, tokens.manager.principal, tokens.manager.token, async (call) => {
    const done: string[] = [];
    for (const projectId of faults.projectIds()) {
      const available = await call("list_tasks", { projectId, filter: { availableFor: "acceptance" } });
      for (const task of available.tasks as Json[]) {
        const claim = await call("claim_acceptance", { taskId: task.id, requestId: crypto.randomUUID() });
        await call("accept_task", { taskId: task.id, claimId: claim.claimId, requestId: crypto.randomUUID() });
        done.push(task.id);
      }
    }
    return done;
  });

/** Evaluator: 各Success Criterionのmeasurementが求める種類のEvidence参照が還流済みならmet、無ければinsufficient_evidence。 */
const runEvaluator = async (connection: Connection, tokens: Tokens, projectId: string, outcomeId: string, requestKey: string) =>
  withMcp(connection, tokens.evaluator.principal, tokens.evaluator.token, async (call) => {
    const context = await call("get_evaluator_context", { projectId, outcomeId });
    const evidence = (context.execution?.evidence ?? []) as Json[];
    const kindFor = (measurement: string) => (/pull request/i.test(measurement) ? "pull_request" : /\bCI\b/.test(measurement) ? "ci" : null);
    const criteria = (context.outcome.successCriteria as Json[]).map((criterion) => {
      const kind = kindFor(criterion.measurement);
      const matched = evidence.filter((item) => item.kind === kind).map((item) => item.id as string);
      return matched.length > 0
        ? { criterionId: criterion.id, verdict: "met", rationale: `Observed ${kind} evidence`, evidenceIds: matched }
        : { criterionId: criterion.id, verdict: "insufficient_evidence", rationale: "No evidence can observe this criterion", evidenceIds: [] };
    });
    const recorded = await call("record_outcome_evaluation", { projectId, outcomeId, requestKey, runRef: `evaluator:${requestKey}`, criteria });
    return recorded.evaluation as Json;
  });

// ---------------------------------------------------------------------------------------------
// Runtime
// ---------------------------------------------------------------------------------------------

/** Runtimeが自分で永続化する状態。Runtime再起動後もこれだけを引き継ぐ（in-memoryの状態は失う）。 */
export type RuntimeStore = {
  /** `fetch_runtime_events`の`resumeCursor`。未確定のイベントを追い越さない再開位置。 */
  resumeCursor: number;
  /** `list_changes`の読了位置（change_logはackを持たないのでRuntimeが保持する）。 */
  changeCursor: number;
  /** 還流済みEvidenceのURI（Outcomeごと）。 */
  reflected: Record<string, string[]>;
};

export type Faults = {
  projectIds: () => string[];
  managerTimeoutAfterStory?: (event: Json) => boolean;
  crashBeforeAck?: (event: Json) => boolean;
  /** このイベントのAgentを並行に2回起動する（重複配送）。 */
  duplicateDispatch?: (event: Json) => boolean;
  workerHangs?: (principal: string, task: Json) => boolean;
};

export type DispatchRecord = { eventId: string; type: string; attemptId: string; outcome: string; note: string; correlationId: string | null };

export class Runtime {
  readonly dispatches: DispatchRecord[] = [];
  readonly acks: Json[] = [];
  readonly fetchedEvents: Json[] = [];
  readonly evaluations: Json[] = [];
  readonly reflections: Json[] = [];

  constructor(
    private readonly connection: Connection,
    private readonly tokens: Tokens,
    readonly store: RuntimeStore,
    private readonly faults: Faults,
  ) {}

  private runtime<T>(run: (call: Call) => Promise<T>) {
    return withMcp(this.connection, this.tokens.runtime.principal, this.tokens.runtime.token, run);
  }

  /** イベント1件のAgent起動。Agentの明示的なCONFLICT / NOT_FOUNDは状態変化で不要になったものとして`processed`で閉じる。 */
  private async dispatch(event: Json): Promise<string> {
    const launch = () => {
      switch (event.type) {
        case "research_requested":
          return runResearcher(this.connection, this.tokens, event);
        case "research_completed":
        case "outcome_evaluated":
          return runStrategist(this.connection, this.tokens, event);
        case "outcome_confirmed":
          return runManager(this.connection, this.tokens, event, this.faults);
        default:
          throw new ToolError("runtime", "UNKNOWN_EVENT_TYPE", { message: event.type });
      }
    };
    const runs = this.faults.duplicateDispatch?.(event) ? [launch(), launch()] : [launch()];
    const settled = await Promise.allSettled(runs);
    const notes: string[] = [];
    for (const item of settled) {
      if (item.status === "fulfilled") notes.push(String(item.value));
      else if (item.reason instanceof ToolError && ["CONFLICT", "NOT_FOUND"].includes(item.reason.code)) notes.push(`superseded: ${item.reason.message}`);
      else throw item.reason;
    }
    return notes.join(" | ");
  }

  private async ack(call: Call, event: Json, attemptId: string, outcome: string, reason?: string) {
    const acked = await call("ack_runtime_event", { projectId: event.projectId, eventId: event.id, attemptId, outcome, ...(reason ? { reason } : {}) });
    this.acks.push({ eventId: event.id, attemptId, outcome, recorded: acked.recorded });
    return acked;
  }

  /** 未確定のRuntime eventを取得して処理する。1周の中では`nextCursor`でページングし、永続化するのは`resumeCursor`だけ。 */
  async processEvents(): Promise<number> {
    let processed = 0;
    for (const projectId of this.faults.projectIds()) {
      const batch: Json[] = [];
      let afterCursor = this.store.resumeCursor;
      for (;;) {
        const page = await this.runtime((call) => call("fetch_runtime_events", { projectId, afterCursor, limit: 2 }));
        batch.push(...page.events);
        this.store.resumeCursor = page.resumeCursor;
        if (page.events.length === 0) break;
        afterCursor = page.nextCursor;
      }
      this.fetchedEvents.push(...batch);
      // 並列に処理した結果、完了順がcursor順と逆になる状況を再現するため、1周の中では新しいイベントから処理する。
      for (const event of batch.reverse()) {
        const attemptId = crypto.randomUUID();
        let outcome = "processed";
        let reason: string | undefined;
        let note: string;
        try {
          note = event.version === 1 ? await this.dispatch(event) : "unknown version";
          if (event.version !== 1) {
            outcome = "terminal_failure";
            reason = `unknown event version ${event.version}`;
          }
        } catch (error) {
          if (!(error instanceof AgentTimeout)) throw error;
          outcome = "retryable_failure";
          reason = error.message;
          note = "timeout";
        }
        if (outcome === "processed" && this.faults.crashBeforeAck?.(event)) {
          this.dispatches.push({ eventId: event.id, type: event.type, attemptId, outcome: "crashed", note, correlationId: event.correlationId });
          throw new RuntimeCrash(`crashed before ack of ${event.type}`);
        }
        await this.runtime((call) => this.ack(call, event, attemptId, outcome, reason));
        this.dispatches.push({ eventId: event.id, type: event.type, attemptId, outcome, note, correlationId: event.correlationId });
        processed += 1;
      }
    }
    return processed;
  }

  /** Execution Roleの起動（着手可能なTaskの有無はAgentが`availableFor`で判断する）。 */
  async launchExecutionAgents() {
    for (const worker of this.tokens.workers) await runWorker(this.connection, worker, this.faults);
    await runReviewer(this.connection, this.tokens, this.faults);
    await runAcceptor(this.connection, this.tokens, this.faults);
  }

  /**
   * Change Logを増分取得し、Outcomeに相関付く変更があれば還流する。Taskの受入後はPR、続いてCIの結果を
   * Evidence参照として還流し、還流が増えてExecutionが`accepted`ならEvaluatorを起動する。
   */
  async processChanges(): Promise<number> {
    let read = 0;
    for (const projectId of this.faults.projectIds()) {
      const outcomes = new Set<string>();
      let afterCursor = this.store.changeCursor;
      for (;;) {
        const page = await this.runtime((call) => call("list_changes", { projectId, afterCursor, limit: 50 }));
        for (const change of page.changes as Json[]) if (change.outcomeId) outcomes.add(change.outcomeId);
        read += page.changes.length;
        if (page.changes.length === 0) break;
        afterCursor = page.nextCursor;
      }
      for (const outcomeId of outcomes) {
        const reflect = (evidence: Json[]) =>
          this.runtime((call) => call("record_execution_evidence", { projectId, outcomeId, changeCursor: afterCursor, ...(evidence.length ? { evidence } : {}) }));
        // まず変更の通知だけを還流し、Compassが導出した現在の状態を得る。
        const notified = await reflect([]);
        this.reflections.push({ outcomeId, changeCursor: afterCursor, recorded: notified.recorded, state: notified.summary.state });
        if (notified.summary.state !== "accepted") continue;
        const reflected = (this.store.reflected[outcomeId] ??= []);
        for (const kind of ["pull_request", "ci"] as const) {
          const uri = kind === "pull_request" ? `https://github.com/example/compass/pull/${outcomeId}` : `https://ci.example.com/runs/${outcomeId}`;
          if (reflected.includes(uri)) continue;
          const result = await reflect([{ kind, uri, versionHash: "c".repeat(40), observedAt: this.connection.now() - 1_000 }]);
          this.reflections.push({ outcomeId, changeCursor: afterCursor, kind, recorded: result.recorded, state: result.summary.state });
          reflected.push(uri);
          const evaluation = await runEvaluator(this.connection, this.tokens, projectId, outcomeId, `evaluation:${outcomeId}:${reflected.length}`);
          this.evaluations.push(evaluation);
        }
      }
      this.store.changeCursor = afterCursor;
    }
    return read;
  }

  async tick(): Promise<number> {
    const events = await this.processEvents();
    await this.launchExecutionAgents();
    const changes = await this.processChanges();
    return events + changes;
  }

  /** 進捗が2周続けて無くなるまで回す（pollingとその間隔はRuntimeの責務）。 */
  async runUntilIdle(maxTicks = 40) {
    let idle = 0;
    for (let tick = 0; tick < maxTicks; tick += 1) {
      idle = (await this.tick()) === 0 ? idle + 1 : 0;
      if (idle >= 2) return tick;
    }
    throw new Error(`runtime did not become idle within ${maxTicks} ticks`);
  }
}
