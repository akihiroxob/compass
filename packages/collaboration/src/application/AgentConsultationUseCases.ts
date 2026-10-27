import { ValidationError } from "@compass/shared";
import type { ConsultationActor, ConsultationScope } from "../domain/Consultation.ts";
import type {
  AcquireConsultationLeaseUseCase,
  AddConsultationMessageUseCase,
  CancelConsultationUseCase,
  CreateConsultationUseCase,
  GetConsultationUseCase,
  ListConsultationsUseCase,
  ResolveConsultationUseCase,
} from "./ConsultationUseCases.ts";
import type { RecordConsultationArtifactUseCase, RequestConsultationFollowupUseCase } from "./ConsultationFollowupUseCases.ts";
import type { ConsultationAgentAuthorization } from "./port/ConsultationStore.ts";

type ConsultationUseCases = {
  create: CreateConsultationUseCase;
  list: ListConsultationsUseCase;
  get: GetConsultationUseCase;
  acquireLease: AcquireConsultationLeaseUseCase;
  addMessage: AddConsultationMessageUseCase;
  resolve: ResolveConsultationUseCase;
  cancel: CancelConsultationUseCase;
  requestFollowup: RequestConsultationFollowupUseCase;
  recordArtifact: RecordConsultationArtifactUseCase;
};

/**
 * Agent（MCP）向けの入口。相談のscopeのRole Grantで認可してから共通のuse caseへ委譲する。認可は対象の存在確認より先に行い、
 * Grantを持たないPrincipalへscope・相談の存在を漏らさない。Project scopeは参照・作成・回答をmanager / worker / reviewer、
 * 結論整理・取消をmanagerだけ、Workspace scopeは参照・作成・回答をstrategist / researcher / evaluator、結論整理・取消をstrategistだけに許す。
 * Humanの明示決定はこの入口に無く、Agentの結論は常に`agent_summary`として記録される。
 * 結論からの文書反映の依頼と受入済み成果物参照の登録は、結論整理と同じ応答Role（Project相談のmanager）が行う。
 */
export class AgentConsultationUseCases {
  constructor(
    private readonly authorization: ConsultationAgentAuthorization,
    private readonly useCases: ConsultationUseCases,
  ) {}

  private async actor(principal: string | null, scope: ConsultationScope, role: string | undefined): Promise<ConsultationActor> {
    const actor = await this.authorization.resolveActor(principal, scope, role);
    if (actor === null) {
      throw new ValidationError("Consultation input is invalid", [
        { path: "role", message: "role is required when the operation context has no active role" },
      ]);
    }
    return actor;
  }

  async create(principal: string | null, scope: ConsultationScope, role: string | undefined, input: unknown) {
    return this.useCases.create.execute(scope, await this.actor(principal, scope, role), input);
  }

  async list(principal: string | null, scope: ConsultationScope, query: unknown = {}) {
    await this.authorization.requireReader(principal, scope);
    return this.useCases.list.execute(scope, query);
  }

  async get(principal: string | null, scope: ConsultationScope, consultationId: string) {
    await this.authorization.requireReader(principal, scope);
    return this.useCases.get.execute(scope, consultationId);
  }

  async acquireLease(principal: string | null, scope: ConsultationScope, consultationId: string, role: string | undefined, input: unknown) {
    return this.useCases.acquireLease.execute(scope, consultationId, await this.actor(principal, scope, role), input);
  }

  async reply(principal: string | null, scope: ConsultationScope, consultationId: string, role: string | undefined, input: unknown) {
    return this.useCases.addMessage.execute(scope, consultationId, await this.actor(principal, scope, role), input);
  }

  async resolve(principal: string | null, scope: ConsultationScope, consultationId: string, input: unknown) {
    return this.useCases.resolve.execute(scope, consultationId, await this.authorization.requireResponder(principal, scope), input);
  }

  async cancel(principal: string | null, scope: ConsultationScope, consultationId: string, input: unknown) {
    return this.useCases.cancel.execute(scope, consultationId, await this.authorization.requireResponder(principal, scope), input);
  }

  async requestFollowup(principal: string | null, scope: ConsultationScope, consultationId: string, input: unknown) {
    return this.useCases.requestFollowup.execute(scope, consultationId, await this.authorization.requireResponder(principal, scope), input);
  }

  async recordArtifact(principal: string | null, scope: ConsultationScope, consultationId: string, input: unknown) {
    return this.useCases.recordArtifact.execute(scope, consultationId, await this.authorization.requireResponder(principal, scope), input);
  }
}
