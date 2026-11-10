import {
  ActivityScope,
  GetActivityUseCase,
  KyselyActivityStore,
  ListActivitiesUseCase,
  ListWorkspaceActivityStreamUseCase,
  type ActivityUnitOfWork,
} from "@compass/activity";

import type { Kysely } from "kysely";
import { asActivityDatabase } from "../infrastructure/database/contextDatabase.ts";
import type { Database } from "../infrastructure/database/schema.ts";
import { activityScopeReader } from "../infrastructure/repository/contextAdapters.ts";

export const createActivityServices = (applicationDatabase: Kysely<Database>) => {
  // Activity（意味のある履歴）。Change Log・Operational Logとは別のtableで、Project・Workspaceの状態はOrganizationのreaderで読む。
  // Project ActivityとWorkspace Activityは別のuse case instanceで、互いのscopeを返さない。
  const activityStore = new KyselyActivityStore(asActivityDatabase(applicationDatabase));
  const activityScopes = activityScopeReader(applicationDatabase);
  const listActivitiesUseCase = new ListActivitiesUseCase(ActivityScope.PROJECT, activityScopes, activityStore);
  const getActivityUseCase = new GetActivityUseCase(ActivityScope.PROJECT, activityScopes, activityStore);
  const listWorkspaceActivitiesUseCase = new ListActivitiesUseCase(ActivityScope.WORKSPACE, activityScopes, activityStore);
  const getWorkspaceActivityUseCase = new GetActivityUseCase(ActivityScope.WORKSPACE, activityScopes, activityStore);
  // Workspace共通と所属全Projectを横断して読むHuman向けの一覧。Agentの入口には公開しない（Agentのscope認可は広げない）。
  const listWorkspaceActivityStreamUseCase = new ListWorkspaceActivityStreamUseCase(activityScopes, activityStore);
  const activityUnitOfWork: ActivityUnitOfWork = {
    execute: (work) => applicationDatabase.transaction().execute((transaction) =>
      work(new KyselyActivityStore(asActivityDatabase(transaction)), activityScopeReader(transaction)),
    ),
  };
  return {
    activityStore,
    activityScopes,
    listActivitiesUseCase,
    getActivityUseCase,
    listWorkspaceActivitiesUseCase,
    getWorkspaceActivityUseCase,
    listWorkspaceActivityStreamUseCase,
    activityUnitOfWork,
  };
};
