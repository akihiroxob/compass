import { DirectionReferenceLookupService } from "@compass/direction";

import {
  AcquireConsultationLeaseUseCase,
  AddConsultationMessageUseCase,
  CancelConsultationUseCase,
  CreateConsultationUseCase,
  GetConsultationUseCase,
  GetConsultationHandoffContextUseCase,
  HandOffConsultationUseCase,
  KyselyConsultationStore,
  ListAccessibleConsultationsUseCase,
  ListConsultationsUseCase,
  RecordConsultationArtifactUseCase,
  RequestConsultationFollowupUseCase,
  ResolveConsultationUseCase,
  type ConsultationUnitOfWork,
} from "@compass/collaboration";
import type { Kysely } from "kysely";
import { asCollaborationDatabase } from "../infrastructure/database/contextDatabase.ts";
import type { Database } from "../infrastructure/database/schema.ts";
import { consultationFollowupLinks, consultationScopeReader } from "../infrastructure/repository/contextAdapters.ts";

export const createConsultationServices = (applicationDatabase: Kysely<Database>, directionReferenceLookup: DirectionReferenceLookupService, clock: () => number) => {
  const consultationUnitOfWork: ConsultationUnitOfWork = {
    execute: (work) => applicationDatabase.transaction().execute((transaction) =>
      work(
        new KyselyConsultationStore(asCollaborationDatabase(transaction)),
        consultationScopeReader(transaction),
        consultationFollowupLinks(transaction, { directionReferences: directionReferenceLookup, clock }),
      ),
    ),
  };
  const consultations = {
    create: new CreateConsultationUseCase(consultationUnitOfWork, clock),
    list: new ListConsultationsUseCase(consultationUnitOfWork),
    listAccessible: new ListAccessibleConsultationsUseCase(consultationUnitOfWork),
    get: new GetConsultationUseCase(consultationUnitOfWork, clock),
    acquireLease: new AcquireConsultationLeaseUseCase(consultationUnitOfWork, clock),
    addMessage: new AddConsultationMessageUseCase(consultationUnitOfWork, clock),
    resolve: new ResolveConsultationUseCase(consultationUnitOfWork, clock),
    cancel: new CancelConsultationUseCase(consultationUnitOfWork, clock),
    handOff: new HandOffConsultationUseCase(consultationUnitOfWork, clock),
    getHandoffContext: new GetConsultationHandoffContextUseCase(consultationUnitOfWork),
    requestFollowup: new RequestConsultationFollowupUseCase(consultationUnitOfWork, clock),
    recordArtifact: new RecordConsultationArtifactUseCase(consultationUnitOfWork, clock),
  };
  return { consultationUnitOfWork, consultations };
};
