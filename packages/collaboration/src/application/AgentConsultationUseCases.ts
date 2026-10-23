import { ValidationError } from "@compass/shared";
import type { ConsultationActor } from "../domain/Consultation.ts";
import type {
  AcquireConsultationLeaseUseCase,
  AddConsultationMessageUseCase,
  CancelConsultationUseCase,
  CreateConsultationUseCase,
  GetConsultationUseCase,
  ListConsultationsUseCase,
  ResolveConsultationUseCase,
} from "./ConsultationUseCases.ts";
import type { ConsultationAgentAuthorization } from "./port/ConsultationStore.ts";

type ConsultationUseCases = {
  create: CreateConsultationUseCase;
  list: ListConsultationsUseCase;
  get: GetConsultationUseCase;
  acquireLease: AcquireConsultationLeaseUseCase;
  addMessage: AddConsultationMessageUseCase;
  resolve: ResolveConsultationUseCase;
  cancel: CancelConsultationUseCase;
};

/**
 * Agent（MCP）向けの入口。Project Execution RoleのGrantで認可してから共通のuse caseへ委譲する。認可は対象の存在確認より先に行い、
 * Grantを持たないPrincipalへProject・相談の存在を漏らさない。参照・作成・回答はmanager / worker / reviewer、結論整理・取消はmanagerだけ。
 * Humanの明示決定はこの入口に無く、Agentの結論は常に`agent_summary`として記録される。
 */
export class AgentConsultationUseCases {
  constructor(
    private readonly authorization: ConsultationAgentAuthorization,
    private readonly useCases: ConsultationUseCases,
  ) {}

  private async actor(principal: string | null, projectId: string, role: string | undefined): Promise<ConsultationActor> {
    const actor = await this.authorization.resolveActor(principal, projectId, role);
    if (actor === null) {
      throw new ValidationError("Consultation input is invalid", [
        { path: "role", message: "role is required when the operation context has no active role" },
      ]);
    }
    return actor;
  }

  async create(principal: string | null, projectId: string, role: string | undefined, input: unknown) {
    return this.useCases.create.execute(projectId, await this.actor(principal, projectId, role), input);
  }

  async list(principal: string | null, projectId: string, query: unknown = {}) {
    await this.authorization.requireReader(principal, projectId);
    return this.useCases.list.execute(projectId, query);
  }

  async get(principal: string | null, projectId: string, consultationId: string) {
    await this.authorization.requireReader(principal, projectId);
    return this.useCases.get.execute(projectId, consultationId);
  }

  async acquireLease(principal: string | null, projectId: string, consultationId: string, role: string | undefined, input: unknown) {
    return this.useCases.acquireLease.execute(projectId, consultationId, await this.actor(principal, projectId, role), input);
  }

  async reply(principal: string | null, projectId: string, consultationId: string, role: string | undefined, input: unknown) {
    return this.useCases.addMessage.execute(projectId, consultationId, await this.actor(principal, projectId, role), input);
  }

  async resolve(principal: string | null, projectId: string, consultationId: string, input: unknown) {
    return this.useCases.resolve.execute(projectId, consultationId, await this.authorization.requireManager(principal, projectId), input);
  }

  async cancel(principal: string | null, projectId: string, consultationId: string, input: unknown) {
    return this.useCases.cancel.execute(projectId, consultationId, await this.authorization.requireManager(principal, projectId), input);
  }
}
