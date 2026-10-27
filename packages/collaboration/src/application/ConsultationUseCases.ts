import { randomUUID } from "node:crypto";
import { NotFoundError, ValidationError } from "@compass/shared";
import {
  checkAgentCancel,
  checkAgentResponse,
  checkHumanClosing,
  checkHumanMessage,
  checkLeaseAcquisition,
  checkSupersedes,
  consultationLeaseTtlMs,
  consultationReferenceKinds,
  hasHumanBasis,
  statusAfterMessage,
  type Consultation,
  type ConsultationActor,
  type ConsultationLease,
  type ConsultationMessage,
  type ConsultationResolution,
  type ConsultationScope,
} from "../domain/Consultation.ts";
import {
  parseAcquireLeaseInput,
  parseAgentMessageInput,
  parseAccessibleConsultationListQuery,
  parseAgentResolutionInput,
  parseCancelConsultationInput,
  parseConsultationListQuery,
  parseCreateConsultationInput,
  parseHumanDecisionInput,
  parseHumanMessageInput,
} from "./consultationSchema.ts";
import { consultationNotFound, requireConsultation, requireScope, requireWritableScope, violation, withReceipt, type Clock } from "./consultationOperation.ts";
import { describeFollowups, type ConsultationFollowupView } from "./ConsultationFollowupUseCases.ts";
import type { ConsultationUnitOfWork, ConsultationWaitingTask } from "./port/ConsultationStore.ts";

/** 横断一覧で閲覧できるscope（Accessが呼出し主体のMembershipから求める）。 */
export type ConsultationAccess = { projectIds: readonly string[]; workspaceIds: readonly string[] };

/** 横断一覧の結果。`nextCursor`は続きがあるときだけ返す。 */
export type AccessibleConsultationList = { consultations: Consultation[]; nextCursor: string | null };

/** 現在応答中のAgent（有効なlease）。lease IDは保持者以外に返さない。 */
export type ConsultationResponder = { principalId: string; role: string; inputRevision: number; expiresAt: number };

export type ConsultationDetail = {
  consultation: Consultation;
  messages: ConsultationMessage[];
  resolution: ConsultationResolution | null;
  responder: ConsultationResponder | null;
  /** 結論からの文書反映の依頼と反映状況（Project相談だけ）。 */
  followups: ConsultationFollowupView[];
  /** この相談を待つTask（元Task）の状態（Project相談だけ）。 */
  waitingTasks: ConsultationWaitingTask[];
};

/**
 * 相談の作成（Agentの設計質問）。作成時はHumanの判断待ち（`waiting_human`）。参照・方針変更元は同じscopeのものだけを受け付ける。
 * 認可は入口（`AgentConsultationUseCases`）が行い、ここは認可済みの記録主体を受け取る。
 */
export class CreateConsultationUseCase {
  constructor(
    private readonly unitOfWork: ConsultationUnitOfWork,
    private readonly clock: Clock = Date.now,
    private readonly newId: () => string = randomUUID,
  ) {}

  execute(scope: ConsultationScope, actor: ConsultationActor, input: unknown): Promise<{ consultation: Consultation }> {
    const { requestId, ...content } = parseCreateConsultationInput(input);
    return this.unitOfWork.execute((store, scopes) =>
      withReceipt(store, actor, "create_consultation", requestId, { ...scope, ...content }, this.clock, async () => {
        const state = await requireWritableScope(scopes, scope);
        const label = scope.kind === "project" ? "Project" : "Workspace";
        const issues: { path: string; message: string }[] = [];
        for (const [index, ref] of content.refs.entries()) {
          const path = `refs.${index}`;
          if (!consultationReferenceKinds[scope.kind].includes(ref.kind)) {
            issues.push({ path: `${path}.kind`, message: `${ref.kind} cannot be referenced from a ${label} Consultation` });
            continue;
          }
          if (ref.kind === "project_resource" && !state.resourceIds.includes(ref.resourceId)) {
            issues.push({ path: `${path}.resourceId`, message: `Project Resource ${ref.resourceId} is not registered in this Project` });
          }
          if ((ref.kind === "task" || ref.kind === "story") && scope.kind === "project" && !(await scopes.workItemExists(scope.projectId, ref.kind, ref.id))) {
            issues.push({ path: `${path}.id`, message: `${ref.kind === "task" ? "Task" : "Story"} ${ref.id} was not found in this Project` });
          }
          if ((ref.kind === "intent" || ref.kind === "outcome") && !(await scopes.directionItemExists(state.workspaceId, ref))) {
            issues.push({ path: `${path}.id`, message: `${ref.kind === "intent" ? "Intent" : "Outcome"} ${ref.id} was not found in this Workspace` });
          }
          if (ref.kind === "consultation" && !(await store.findConsultation(scope, ref.id))) {
            issues.push({ path: `${path}.id`, message: `Consultation ${ref.id} was not found in this ${label}` });
          }
        }
        if (issues.length) throw new ValidationError("Consultation input is invalid", issues);
        if (content.supersedesConsultationId !== undefined) {
          const superseded = await store.findConsultation(scope, content.supersedesConsultationId);
          if (!superseded) throw consultationNotFound(content.supersedesConsultationId);
          const rejected = checkSupersedes(superseded);
          if (rejected) throw violation(rejected, superseded);
        }
        const now = this.clock();
        const consultation: Consultation = {
          id: this.newId(),
          scope: scope.kind,
          workspaceId: state.workspaceId,
          projectId: scope.kind === "project" ? scope.projectId : null,
          title: content.title,
          question: content.question,
          blockingReason: content.blockingReason,
          options: content.options,
          recommendation: content.recommendation,
          impact: content.impact,
          refs: content.refs,
          status: "waiting_human",
          revision: 1,
          supersedesConsultationId: content.supersedesConsultationId ?? null,
          createdBy: actor,
          createdAt: now,
          updatedAt: now,
          cancellation: null,
        };
        await store.insertConsultation(consultation);
        return { consultation };
      }),
    );
  }
}

/** scopeの相談一覧（更新の新しい順。`status`で絞る）。認可は呼び出し側の入口で行う。 */
export class ListConsultationsUseCase {
  constructor(private readonly unitOfWork: ConsultationUnitOfWork) {}

  /** `query`は未検証の入力（Web APIのquery・MCPの入力）で、ここで検証する。 */
  execute(scope: ConsultationScope, query: unknown = {}): Promise<{ consultations: Consultation[] }> {
    const parsed = parseConsultationListQuery(query);
    return this.unitOfWork.execute(async (store, scopes) => {
      await requireScope(scopes, scope);
      return { consultations: await store.listConsultations(scope, parsed) };
    });
  }
}

const encodeCursor = (consultation: Pick<Consultation, "updatedAt" | "id">) => `${consultation.updatedAt}.${consultation.id}`;

/**
 * 閲覧できるscopeを横断した相談一覧（Humanの判断待ち）。閲覧できるProject・Workspaceの集合は入口がMembershipから求めて渡し、
 * scope・Project・Workspace・状態の絞り込みとページングはその認可済みの集合に対して行う。閲覧できないProject・Workspaceを指定しても
 * 拒否せず空にし、存在・件数を区別させない。Project Membershipから同じWorkspaceの相談を、Workspace Membershipから未所属Projectの相談を返さない。
 */
export class ListAccessibleConsultationsUseCase {
  constructor(private readonly unitOfWork: ConsultationUnitOfWork) {}

  execute(access: ConsultationAccess, query: unknown = {}): Promise<AccessibleConsultationList> {
    const parsed = parseAccessibleConsultationListQuery(query);
    const projectIds = parsed.scope === "workspace" ? [] : access.projectIds.filter((id) => parsed.projectId === undefined || id === parsed.projectId);
    // Projectを指定した絞り込みはそのProjectの相談だけで、Workspace scopeの相談を含めない。
    const workspaceIds = parsed.scope === "project" || parsed.projectId !== undefined ? [] : access.workspaceIds;
    if (!projectIds.length && !workspaceIds.length) return Promise.resolve({ consultations: [], nextCursor: null });
    return this.unitOfWork.execute(async (store) => {
      const page = await store.listAccessibleConsultations({
        projectIds,
        workspaceIds,
        ...(parsed.status === "all" ? {} : { status: parsed.status }),
        ...(parsed.workspaceId === undefined ? {} : { workspaceId: parsed.workspaceId }),
        ...(parsed.projectId === undefined ? {} : { projectId: parsed.projectId }),
        ...(parsed.cursor === undefined ? {} : { after: parsed.cursor }),
        limit: parsed.limit + 1,
      });
      const consultations = page.slice(0, parsed.limit);
      return { consultations, nextCursor: page.length > parsed.limit ? encodeCursor(consultations[consultations.length - 1]!) : null };
    });
  }
}

/** 相談の詳細（質問・会話・結論と、現在応答中のAgent）。別scopeの相談IDは存在しないものとして扱う。 */
export class GetConsultationUseCase {
  constructor(private readonly unitOfWork: ConsultationUnitOfWork, private readonly clock: Clock = Date.now) {}

  execute(scope: ConsultationScope, consultationId: string): Promise<ConsultationDetail> {
    return this.unitOfWork.execute(async (store, scopes, links) => {
      await requireScope(scopes, scope);
      const consultation = await requireConsultation(store, scope, consultationId);
      const lease = await store.findActiveLease(consultation.id, consultation.revision, this.clock());
      return {
        consultation,
        messages: await store.listMessages(consultation.id),
        resolution: await store.findResolution(consultation.id),
        responder: lease && { principalId: lease.principalId, role: lease.role, inputRevision: lease.inputRevision, expiresAt: lease.expiresAt },
        followups: await describeFollowups(store, links, consultation.id),
        waitingTasks: scope.kind === "project" ? await links.listWaitingTasks(scope.projectId, consultation.id) : [],
      };
    });
  }
}

/**
 * Agentの応答leaseの取得。Humanの新しい入力（`waiting_agent`）の現在の版に対して1件だけ発行し、他のAgentの同時応答を拒否する。
 * 同じPrincipalが有効なleaseを持っていれば、期限を延ばして同じleaseを返す。
 */
export class AcquireConsultationLeaseUseCase {
  constructor(
    private readonly unitOfWork: ConsultationUnitOfWork,
    private readonly clock: Clock = Date.now,
    private readonly newId: () => string = randomUUID,
    private readonly ttlMs = consultationLeaseTtlMs,
  ) {}

  execute(scope: ConsultationScope, consultationId: string, actor: ConsultationActor, input: unknown): Promise<{ lease: ConsultationLease }> {
    const { requestId, inputRevision } = parseAcquireLeaseInput(input);
    return this.unitOfWork.execute((store, scopes) =>
      withReceipt(store, actor, "acquire_consultation_lease", requestId, { ...scope, consultationId, inputRevision }, this.clock, async () => {
        await requireWritableScope(scopes, scope);
        const consultation = await requireConsultation(store, scope, consultationId);
        const now = this.clock();
        const active = await store.findActiveLease(consultation.id, consultation.revision, now);
        const rejected = checkLeaseAcquisition(consultation, inputRevision, active, actor.principalId);
        if (rejected) throw violation(rejected, consultation);
        const expiresAt = now + this.ttlMs;
        if (active) {
          await store.extendLease(active.id, expiresAt);
          return { lease: { ...active, expiresAt } };
        }
        const lease: ConsultationLease = {
          id: this.newId(),
          consultationId: consultation.id,
          inputRevision,
          principalId: actor.principalId,
          role: actor.role,
          acquiredAt: now,
          expiresAt,
          releasedAt: null,
        };
        await store.insertLease(lease);
        return { lease };
      }),
    );
  }
}

/** 版を進めた相談。状態・更新日時も合わせて変える。 */
const advanced = (consultation: Consultation, changes: Partial<Consultation>, now: number): Consultation => ({
  ...consultation,
  ...changes,
  revision: consultation.revision + 1,
  updatedAt: now,
});

/**
 * 会話への発言。Humanの返信はAgentの応答待ちへ、Agentの回答・追加質問（応答lease・現在の版が必要）はHumanの判断待ちへ進める。
 * 発言は追記だけで、訂正は自分の発言を`correctsMessageId`で指す新しい発言とする（他の主体の発言は訂正できない）。
 */
export class AddConsultationMessageUseCase {
  constructor(
    private readonly unitOfWork: ConsultationUnitOfWork,
    private readonly clock: Clock = Date.now,
    private readonly newId: () => string = randomUUID,
  ) {}

  execute(scope: ConsultationScope, consultationId: string, actor: ConsultationActor, input: unknown): Promise<{ consultation: Consultation; message: ConsultationMessage }> {
    const agent = actor.kind === "agent" ? parseAgentMessageInput(input) : null;
    const { requestId, ...content } = agent ?? parseHumanMessageInput(input);
    return this.unitOfWork.execute((store, scopes) =>
      withReceipt(store, actor, "reply_consultation", requestId, { ...scope, consultationId, ...content }, this.clock, async () => {
        await requireWritableScope(scopes, scope);
        const consultation = await requireConsultation(store, scope, consultationId);
        const now = this.clock();
        if (agent) {
          const lease = await store.findLease(consultation.id, agent.leaseId);
          const rejected = checkAgentResponse(consultation, agent.expectedRevision, lease, actor.principalId, now);
          if (rejected) throw violation(rejected, consultation);
        } else {
          const rejected = checkHumanMessage(consultation);
          if (rejected) throw violation(rejected, consultation);
        }
        const messages = await store.listMessages(consultation.id);
        if (content.correctsMessageId !== undefined) {
          const corrected = messages.find((message) => message.id === content.correctsMessageId);
          if (!corrected) throw new NotFoundError(`Message ${content.correctsMessageId} was not found in this Consultation`);
          if (corrected.author.principalId !== actor.principalId) {
            throw new ValidationError("Consultation message input is invalid", [
              { path: "correctsMessageId", message: "only your own message can be corrected" },
            ]);
          }
        }
        const updated = advanced(consultation, { status: statusAfterMessage(actor.kind) }, now);
        const message: ConsultationMessage = {
          id: this.newId(),
          consultationId: consultation.id,
          sequence: messages.length + 1,
          author: actor,
          body: content.body,
          correctsMessageId: content.correctsMessageId ?? null,
          revision: updated.revision,
          createdAt: now,
        };
        await store.appendMessage(message);
        await store.updateConsultation(updated);
        // 応答を終えたAgentのleaseは解放する。Humanの返信は版を進めるため、応答中のleaseは版の照合で無効になる。
        if (actor.kind === "agent") await store.releaseLeases(consultation.id, now);
        return { consultation: updated, message };
      }),
    );
  }
}

/**
 * 結論の保存と解決（同じtransaction）。Humanは閲覧した版を指定して明示決定を記録する（`human_decision`）。
 * 応答Role（ProjectはManager、WorkspaceはStrategist）は応答leaseのもとで、Humanの発言を含む根拠の発言を指定して結論を整理する（`agent_summary`）。
 * 由来は記録主体の種類から決め、入力では指定させない。明確なHumanの回答に対して再承認は求めない。
 */
export class ResolveConsultationUseCase {
  constructor(
    private readonly unitOfWork: ConsultationUnitOfWork,
    private readonly clock: Clock = Date.now,
    private readonly newId: () => string = randomUUID,
  ) {}

  execute(scope: ConsultationScope, consultationId: string, actor: ConsultationActor, input: unknown): Promise<{ consultation: Consultation; resolution: ConsultationResolution }> {
    const agent = actor.kind === "agent" ? parseAgentResolutionInput(input) : null;
    const { requestId, ...content } = agent ?? parseHumanDecisionInput(input);
    return this.unitOfWork.execute((store, scopes) =>
      withReceipt(store, actor, "resolve_consultation", requestId, { ...scope, consultationId, ...content }, this.clock, async () => {
        await requireWritableScope(scopes, scope);
        const consultation = await requireConsultation(store, scope, consultationId);
        const now = this.clock();
        const rejected = agent
          ? checkAgentResponse(consultation, agent.expectedRevision, await store.findLease(consultation.id, agent.leaseId), actor.principalId, now)
          : checkHumanClosing(consultation, content.expectedRevision);
        if (rejected) throw violation(rejected, consultation);
        const messages = await store.listMessages(consultation.id);
        const basisIds = [...new Set(content.basisMessageIds)];
        const basis = basisIds.map((id) => messages.find((message) => message.id === id));
        const issues = basis.flatMap((message, index) => (message ? [] : [{ path: `basisMessageIds.${index}`, message: `Message ${basisIds[index]} was not found in this Consultation` }]));
        if (content.selectedOption !== undefined && content.selectedOption !== null && content.selectedOption >= consultation.options.length) {
          issues.push({ path: "selectedOption", message: "selectedOption must be the index of one of the Consultation options" });
        }
        if (actor.kind === "agent" && issues.length === 0 && !hasHumanBasis(basis.filter((message) => message !== undefined))) {
          issues.push({ path: "basisMessageIds", message: "basisMessageIds must include at least one Human message" });
        }
        if (issues.length) throw new ValidationError("Consultation resolution input is invalid", issues);
        const updated = advanced(consultation, { status: "resolved" }, now);
        const resolution: ConsultationResolution = {
          id: this.newId(),
          consultationId: consultation.id,
          source: actor.kind === "human" ? "human_decision" : "agent_summary",
          conclusion: content.conclusion,
          rationale: content.rationale,
          applicability: content.applicability,
          selectedOption: content.selectedOption ?? null,
          basisMessageIds: basisIds,
          basisRevision: consultation.revision,
          recordedBy: actor,
          createdAt: now,
        };
        await store.insertResolution(resolution);
        await store.updateConsultation(updated);
        await store.releaseLeases(consultation.id, now);
        return { consultation: updated, resolution };
      }),
    );
  }
}

/** 理由付きの取消（Humanのadministrator以上・Agentの応答Role）。閲覧した版を照合し、応答中のleaseも解放する。 */
export class CancelConsultationUseCase {
  constructor(private readonly unitOfWork: ConsultationUnitOfWork, private readonly clock: Clock = Date.now) {}

  execute(scope: ConsultationScope, consultationId: string, actor: ConsultationActor, input: unknown): Promise<{ consultation: Consultation }> {
    const { requestId, ...content } = parseCancelConsultationInput(input);
    return this.unitOfWork.execute((store, scopes) =>
      withReceipt(store, actor, "cancel_consultation", requestId, { ...scope, consultationId, ...content }, this.clock, async () => {
        await requireWritableScope(scopes, scope);
        const consultation = await requireConsultation(store, scope, consultationId);
        const rejected = actor.kind === "human"
          ? checkHumanClosing(consultation, content.expectedRevision)
          : checkAgentCancel(consultation, content.expectedRevision);
        if (rejected) throw violation(rejected, consultation);
        const now = this.clock();
        const updated = advanced(consultation, { status: "canceled", cancellation: { reason: content.reason, by: actor, at: now } }, now);
        await store.updateConsultation(updated);
        await store.releaseLeases(consultation.id, now);
        return { consultation: updated };
      }),
    );
  }
}
