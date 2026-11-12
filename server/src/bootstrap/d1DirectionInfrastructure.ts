import type { D1Database } from "@cloudflare/workers-types";
import type { Kysely } from "kysely";
import type { Database } from "../infrastructure/database/schema.ts";
import type { ActivityActorContext } from "../application/activityActor.ts";
import type { DirectionRepositoryOverrides } from "./directionFoundation.ts";
import { asActivityDatabase, asDirectionDatabase } from "../infrastructure/database/contextDatabase.ts";
import { planD1DirectionActivity } from "../infrastructure/repository/d1/planD1DirectionActivity.ts";
import { D1IntentRepository } from "../infrastructure/repository/d1/D1IntentRepository.ts";
import { D1OutcomeRepository } from "../infrastructure/repository/d1/D1OutcomeRepository.ts";
import { D1OutcomeTargetProjectRepository } from "../infrastructure/repository/d1/D1OutcomeTargetProjectRepository.ts";
import { D1ResearchRepository } from "../infrastructure/repository/d1/D1ResearchRepository.ts";
import { D1DirectionDecisionRepository } from "../infrastructure/repository/d1/D1DirectionDecisionRepository.ts";
import { D1AdrHandoffRepository } from "../infrastructure/repository/d1/D1AdrHandoffRepository.ts";
import { D1RuntimeEventRepository } from "../infrastructure/repository/d1/D1RuntimeEventRepository.ts";
import { D1OutcomeExecutionRepository } from "../infrastructure/repository/d1/D1OutcomeExecutionRepository.ts";
import { D1OutcomeEvaluationRepository } from "../infrastructure/repository/d1/D1OutcomeEvaluationRepository.ts";
import { D1IntentMetricRepository } from "../infrastructure/repository/d1/D1IntentMetricRepository.ts";
import { D1IntentExplanationRepository } from "../infrastructure/repository/d1/D1IntentExplanationRepository.ts";

/** Directionの全RepositoryをD1へ配線し、callback transactionを使うSQLite実装へのfallbackを残さない。 */
export const createD1DirectionInfrastructure = (application: Kysely<Database>, binding: D1Database,
  actors: ActivityActorContext, clock: () => number = Date.now): Required<DirectionRepositoryOverrides> => {
  const database = asDirectionDatabase(application);
  const activity = planD1DirectionActivity(asActivityDatabase(application), actors);
  return {
    intentRepository: new D1IntentRepository(database, binding, activity, clock),
    outcomeRepository: new D1OutcomeRepository(database, binding, activity, clock),
    outcomeTargetProjectRepository: new D1OutcomeTargetProjectRepository(database, binding, clock),
    researchRepository: new D1ResearchRepository(database, binding, activity, clock),
    directionDecisionRepository: new D1DirectionDecisionRepository(database, binding, activity, clock),
    adrHandoffRepository: new D1AdrHandoffRepository(database, binding, clock),
    runtimeEventRepository: new D1RuntimeEventRepository(database, binding),
    outcomeExecutionRepository: new D1OutcomeExecutionRepository(database, binding),
    outcomeEvaluationRepository: new D1OutcomeEvaluationRepository(database, binding, activity),
    intentMetricRepository: new D1IntentMetricRepository(database, binding),
    intentExplanationRepository: new D1IntentExplanationRepository(database, binding),
  };
};
