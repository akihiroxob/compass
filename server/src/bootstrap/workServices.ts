import { DirectionReferenceLookupService } from "@compass/direction";

import {
  ExecutionSummaryService,
  KyselyWorkStore,
  ListProjectReleasesUseCase,
  RecordPublicationUseCase,
  TaskCoordinationService,
  type PullRequestGateway,
  type RevisionGateway,
  type WorkStore,
} from "@compass/work";
import { createPublicationAvailabilityReader } from "../application/executionReadAdapters.ts";

import type { Kysely } from "kysely";
import { asWorkDatabase } from "../infrastructure/database/contextDatabase.ts";
import type { Database } from "../infrastructure/database/schema.ts";
import { workChangeActivityObserver, workExternalReaders } from "../infrastructure/repository/contextAdapters.ts";
import type { AccessCredentialRepository } from "@compass/access";

export const createWorkServices = (applicationDatabase: Kysely<Database>, directionReferenceLookup: DirectionReferenceLookupService, accessCredentialRepository: AccessCredentialRepository, clock: () => number, integrations: { pullRequests?: PullRequestGateway | null; revisions?: RevisionGateway | null }, infrastructure?: WorkStore) => {
  // Execution（旧Wachaから移植）。同じDB・同じプロセスの中で動き、Directionの参照は読取専用ポートだけを通す。
  // 重要な状態変更は、同じtransactionでcanonical Activityへ投影する。
  const workStore = infrastructure ?? new KyselyWorkStore(asWorkDatabase(applicationDatabase), workExternalReaders, workChangeActivityObserver);
  const taskCoordinationService = new TaskCoordinationService(
    workStore,
    directionReferenceLookup,
    clock,
    undefined,
    integrations.pullRequests ?? null,
  );
  // 公開確認（Runtimeの原記録）とリリース履歴の読取。開発の受入・PRのmergeとは別の事実として、Workの記録から導出する。
  const recordPublicationUseCase = new RecordPublicationUseCase(workStore, integrations.revisions ?? null, clock);
  const listProjectReleasesUseCase = new ListProjectReleasesUseCase(
    workStore,
    createPublicationAvailabilityReader(accessCredentialRepository, clock),
  );
  // Direction → Executionは読取専用ポート（Execution自身のtableだけを読む）を通す。Direction側の還流先は自身のRepository。
  const executionSummaryService = new ExecutionSummaryService(workStore);
  return { workStore, taskCoordinationService, recordPublicationUseCase, listProjectReleasesUseCase, executionSummaryService };
};
