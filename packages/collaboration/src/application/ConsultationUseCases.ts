import { randomUUID } from "node:crypto";
import { ConflictError, inputHash, NotFoundError, ValidationError } from "@compass/shared";
import {
  checkAgentCancel,
  checkAgentResponse,
  checkHumanClosing,
  checkHumanMessage,
  checkLeaseAcquisition,
  checkSupersedes,
  consultationLeaseTtlMs,
  hasHumanBasis,
  statusAfterMessage,
  type Consultation,
  type ConsultationActor,
  type ConsultationLease,
  type ConsultationMessage,
  type ConsultationResolution,
  type ConsultationViolation,
} from "../domain/Consultation.ts";
import {
  parseAcquireLeaseInput,
  parseAgentMessageInput,
  parseAgentResolutionInput,
  parseCancelConsultationInput,
  parseConsultationListQuery,
  parseCreateConsultationInput,
  parseHumanDecisionInput,
  parseHumanMessageInput,
} from "./consultationSchema.ts";
import type { ConsultationScopeReader, ConsultationStore, ConsultationUnitOfWork } from "./port/ConsultationStore.ts";

type Clock = () => number;

/** 現在応答中のAgent（有効なlease）。lease IDは保持者以外に返さない。 */
export type ConsultationResponder = { principalId: string; role: string; inputRevision: number; expiresAt: number };

export type ConsultationDetail = {
  consultation: Consultation;
  messages: ConsultationMessage[];
  resolution: ConsultationResolution | null;
  responder: ConsultationResponder | null;
};

const violationMessages: Record<ConsultationViolation, string> = {
  CONSULTATION_CLOSED: "The Consultation is already resolved or canceled; start a new Consultation that supersedes it",
  NOT_WAITING_AGENT: "The Consultation is not waiting for an Agent response",
  STALE_REVISION: "The Consultation has changed since the given revision; read it again",
  LEASE_HELD: "Another Agent holds the response lease for this revision",
  LEASE_NOT_HELD: "The response lease is not held by the caller or was already used",
  LEASE_EXPIRED: "The response lease has expired; acquire a new lease",
  SUPERSEDED_NOT_CLOSED: "Only a resolved or canceled Consultation can be superseded; continue the open Consultation instead",
};

const violation = (code: ConsultationViolation, consultation: Pick<Consultation, "id" | "revision" | "status">) =>
  new ConflictError(violationMessages[code], {
    conflict: code,
    consultationId: consultation.id,
    currentRevision: String(consultation.revision),
    consultationStatus: consultation.status,
  });

const consultationNotFound = (consultationId: string) => new NotFoundError(`Consultation ${consultationId} was not found`);

/** 書込の前提。Projectの存在（無ければ404）とarchived（409）を、書込と同じtransactionで確かめる。 */
const requireWritableProject = async (scopes: ConsultationScopeReader, projectId: string) => {
  const project = await scopes.findProject(projectId);
  if (!project) throw new NotFoundError(`Project ${projectId} was not found`);
  if (project.archived) {
    throw new ConflictError(`Project ${projectId} is archived and can no longer be changed`, { projectStatus: "archived" });
  }
  return project;
};

const requireConsultation = async (store: ConsultationStore, projectId: string, consultationId: string) => {
  const consultation = await store.findConsultation(projectId, consultationId);
  if (!consultation) throw consultationNotFound(consultationId);
  return consultation;
};

/**
 * `requestId`の受付記録。同じ主体・操作・`requestId`の再送は、状態がその後変わっていても保存済みの結果を返し、
 * 別の内容での再利用は`CONFLICT`にする。照合は状態の検査より先に行い、通信断後の再送で重複・誤拒否を起こさない。
 */
const withReceipt = async <T>(
  store: ConsultationStore,
  actor: ConsultationActor,
  operation: string,
  requestId: string,
  input: unknown,
  clock: Clock,
  run: () => Promise<T>,
): Promise<T> => {
  const hash = inputHash({ input, role: actor.role });
  const saved = await store.findReceipt(actor.principalId, operation, requestId);
  if (saved) {
    if (saved.inputHash !== hash) {
      throw new ConflictError(`requestId ${requestId} was already used for a different ${operation} request`, { conflict: "IDEMPOTENCY_CONFLICT" });
    }
    return saved.result as T;
  }
  const result = await run();
  await store.insertReceipt({ principalId: actor.principalId, operation, requestId, inputHash: hash, result, createdAt: clock() });
  return result;
};

/**
 * 相談の作成（Agentの設計質問）。作成時はHumanの判断待ち（`waiting_human`）。参照・方針変更元は同じProjectのものだけを受け付ける。
 * 認可は入口（`AgentConsultationUseCases`）が行い、ここは認可済みの記録主体を受け取る。
 */
export class CreateConsultationUseCase {
  constructor(
    private readonly unitOfWork: ConsultationUnitOfWork,
    private readonly clock: Clock = Date.now,
    private readonly newId: () => string = randomUUID,
  ) {}

  execute(projectId: string, actor: ConsultationActor, input: unknown): Promise<{ consultation: Consultation }> {
    const { requestId, ...content } = parseCreateConsultationInput(input);
    return this.unitOfWork.execute((store, scopes) =>
      withReceipt(store, actor, "create_consultation", requestId, { projectId, ...content }, this.clock, async () => {
        const project = await requireWritableProject(scopes, projectId);
        const issues: { path: string; message: string }[] = [];
        for (const [index, ref] of content.refs.entries()) {
          const path = `refs.${index}`;
          if (ref.kind === "project_resource" && !project.resourceIds.includes(ref.resourceId)) {
            issues.push({ path: `${path}.resourceId`, message: `Project Resource ${ref.resourceId} is not registered in this Project` });
          }
          if ((ref.kind === "task" || ref.kind === "story") && !(await scopes.workItemExists(projectId, ref.kind, ref.id))) {
            issues.push({ path: `${path}.id`, message: `${ref.kind === "task" ? "Task" : "Story"} ${ref.id} was not found in this Project` });
          }
          if (ref.kind === "consultation" && !(await store.findConsultation(projectId, ref.id))) {
            issues.push({ path: `${path}.id`, message: `Consultation ${ref.id} was not found in this Project` });
          }
        }
        if (issues.length) throw new ValidationError("Consultation input is invalid", issues);
        if (content.supersedesConsultationId !== undefined) {
          const superseded = await store.findConsultation(projectId, content.supersedesConsultationId);
          if (!superseded) throw consultationNotFound(content.supersedesConsultationId);
          const rejected = checkSupersedes(superseded);
          if (rejected) throw violation(rejected, superseded);
        }
        const now = this.clock();
        const consultation: Consultation = {
          id: this.newId(),
          workspaceId: project.workspaceId,
          projectId,
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

/** Projectの相談一覧（更新の新しい順。`status`で絞る）。認可は呼び出し側の入口で行う。 */
export class ListConsultationsUseCase {
  constructor(private readonly unitOfWork: ConsultationUnitOfWork) {}

  /** `query`は未検証の入力（Web APIのquery・MCPの入力）で、ここで検証する。 */
  execute(projectId: string, query: unknown = {}): Promise<{ consultations: Consultation[] }> {
    const parsed = parseConsultationListQuery(query);
    return this.unitOfWork.execute(async (store, scopes) => {
      if (!(await scopes.findProject(projectId))) throw new NotFoundError(`Project ${projectId} was not found`);
      return { consultations: await store.listConsultations(projectId, parsed) };
    });
  }
}

/** 相談の詳細（質問・会話・結論と、現在応答中のAgent）。別Projectの相談IDは存在しないものとして扱う。 */
export class GetConsultationUseCase {
  constructor(private readonly unitOfWork: ConsultationUnitOfWork, private readonly clock: Clock = Date.now) {}

  execute(projectId: string, consultationId: string): Promise<ConsultationDetail> {
    return this.unitOfWork.execute(async (store, scopes) => {
      if (!(await scopes.findProject(projectId))) throw new NotFoundError(`Project ${projectId} was not found`);
      const consultation = await requireConsultation(store, projectId, consultationId);
      const lease = await store.findActiveLease(consultation.id, consultation.revision, this.clock());
      return {
        consultation,
        messages: await store.listMessages(consultation.id),
        resolution: await store.findResolution(consultation.id),
        responder: lease && { principalId: lease.principalId, role: lease.role, inputRevision: lease.inputRevision, expiresAt: lease.expiresAt },
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

  execute(projectId: string, consultationId: string, actor: ConsultationActor, input: unknown): Promise<{ lease: ConsultationLease }> {
    const { requestId, inputRevision } = parseAcquireLeaseInput(input);
    return this.unitOfWork.execute((store, scopes) =>
      withReceipt(store, actor, "acquire_consultation_lease", requestId, { projectId, consultationId, inputRevision }, this.clock, async () => {
        await requireWritableProject(scopes, projectId);
        const consultation = await requireConsultation(store, projectId, consultationId);
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

  execute(projectId: string, consultationId: string, actor: ConsultationActor, input: unknown): Promise<{ consultation: Consultation; message: ConsultationMessage }> {
    const agent = actor.kind === "agent" ? parseAgentMessageInput(input) : null;
    const { requestId, ...content } = agent ?? parseHumanMessageInput(input);
    return this.unitOfWork.execute((store, scopes) =>
      withReceipt(store, actor, "reply_consultation", requestId, { projectId, consultationId, ...content }, this.clock, async () => {
        await requireWritableProject(scopes, projectId);
        const consultation = await requireConsultation(store, projectId, consultationId);
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
 * Managerは応答leaseのもとで、Humanの発言を含む根拠の発言を指定して結論を整理する（`agent_summary`）。
 * 由来は記録主体の種類から決め、入力では指定させない。明確なHumanの回答に対して再承認は求めない。
 */
export class ResolveConsultationUseCase {
  constructor(
    private readonly unitOfWork: ConsultationUnitOfWork,
    private readonly clock: Clock = Date.now,
    private readonly newId: () => string = randomUUID,
  ) {}

  execute(projectId: string, consultationId: string, actor: ConsultationActor, input: unknown): Promise<{ consultation: Consultation; resolution: ConsultationResolution }> {
    const agent = actor.kind === "agent" ? parseAgentResolutionInput(input) : null;
    const { requestId, ...content } = agent ?? parseHumanDecisionInput(input);
    return this.unitOfWork.execute((store, scopes) =>
      withReceipt(store, actor, "resolve_consultation", requestId, { projectId, consultationId, ...content }, this.clock, async () => {
        await requireWritableProject(scopes, projectId);
        const consultation = await requireConsultation(store, projectId, consultationId);
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

/** 理由付きの取消（Humanのadministrator以上・Agentのmanager）。閲覧した版を照合し、応答中のleaseも解放する。 */
export class CancelConsultationUseCase {
  constructor(private readonly unitOfWork: ConsultationUnitOfWork, private readonly clock: Clock = Date.now) {}

  execute(projectId: string, consultationId: string, actor: ConsultationActor, input: unknown): Promise<{ consultation: Consultation }> {
    const { requestId, ...content } = parseCancelConsultationInput(input);
    return this.unitOfWork.execute((store, scopes) =>
      withReceipt(store, actor, "cancel_consultation", requestId, { projectId, consultationId, ...content }, this.clock, async () => {
        await requireWritableProject(scopes, projectId);
        const consultation = await requireConsultation(store, projectId, consultationId);
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
