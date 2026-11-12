import type { D1Database } from "@cloudflare/workers-types";
import { GitHubPullRequestGateway } from "@compass/work";
import { AgentContextService } from "../application/agentContext/AgentContextService.ts";
import { GoogleOidcIdentityProvider } from "../auth/GoogleOidcIdentityProvider.ts";
import { assertBootstrapConfigured, loadHumanAuthConfig } from "../auth/humanAuthConfig.ts";
import { activityActorContext } from "../infrastructure/activity/NodeActivityActorContext.ts";
import { BundledAgentAssetRepository } from "../infrastructure/agentAssets/BundledAgentAssetRepository.ts";
import { asAccessDatabase } from "../infrastructure/database/contextDatabase.ts";
import { createD1Database } from "../infrastructure/database/d1/D1Dialect.ts";
import { createApp } from "../presentation/http/createApp.ts";
import { createApplicationServices } from "./createApplicationServices.ts";
import { createD1AccessInfrastructure } from "./d1AccessInfrastructure.ts";
import { createD1ActivityInfrastructure } from "./d1ActivityInfrastructure.ts";
import { createD1ConsultationInfrastructure } from "./d1ConsultationInfrastructure.ts";
import { createD1DirectionInfrastructure } from "./d1DirectionInfrastructure.ts";
import { createD1OrganizationInfrastructure } from "./d1OrganizationInfrastructure.ts";
import { createD1WorkInfrastructure } from "./d1WorkInfrastructure.ts";

export type WorkersEnvironment = {
  DB: D1Database;
  ASSETS: { fetch(request: Request): Promise<Response> };
  COMPASS_PUBLIC_ORIGIN: string;
  COMPASS_GOOGLE_CLIENT_ID: string;
  COMPASS_GOOGLE_CLIENT_SECRET: string;
  COMPASS_INITIAL_OWNER_EMAIL?: string;
  COMPASS_GITHUB_TOKEN?: string;
};

/** Nodeの起動処理と分離し、全Contextの永続化をD1へ配線する。migrationは実行しない。 */
export const createWorkersApplication = async (env: WorkersEnvironment, documents: Readonly<Record<string, string>>, revision: string | null) => {
  const auth = loadHumanAuthConfig({ NODE_ENV: "production", COMPASS_AUTH_MODE: "remote",
    COMPASS_PUBLIC_ORIGIN: env.COMPASS_PUBLIC_ORIGIN, COMPASS_GOOGLE_CLIENT_ID: env.COMPASS_GOOGLE_CLIENT_ID,
    COMPASS_GOOGLE_CLIENT_SECRET: env.COMPASS_GOOGLE_CLIENT_SECRET, COMPASS_INITIAL_OWNER_EMAIL: env.COMPASS_INITIAL_OWNER_EMAIL }, { port: 443 });
  const database = createD1Database(env.DB);
  const github = new GitHubPullRequestGateway({ token: env.COMPASS_GITHUB_TOKEN ?? null });
  const services = createApplicationServices(database,
    new AgentContextService(new BundledAgentAssetRepository(documents, revision)), Date.now,
    { initialOwnerEmail: auth.initialOwnerEmail, identityProvider: new GoogleOidcIdentityProvider(auth.google!) },
    { pullRequests: github, revisions: github },
    createD1OrganizationInfrastructure(database, env.DB, activityActorContext), {
      access: createD1AccessInfrastructure(asAccessDatabase(database), env.DB, Date.now),
      direction: createD1DirectionInfrastructure(database, env.DB, activityActorContext),
      work: createD1WorkInfrastructure(database, env.DB), activity: createD1ActivityInfrastructure(env.DB),
      consultation: (references) => createD1ConsultationInfrastructure(env.DB, references, Date.now),
    });
  await assertBootstrapConfigured(auth, await services.getHumanAuthBootstrapStatusUseCase.execute());
  return createApp(services, { humanAuth: { mode: auth.mode, publicOrigin: auth.publicOrigin }, staticAssets: {
    files: async (context, next) => {
      if (context.req.method !== "GET" && context.req.method !== "HEAD") return next();
      const response = await env.ASSETS.fetch(context.req.raw);
      if (response.status !== 404) return response;
      return next();
    },
    index: (context) => env.ASSETS.fetch(new Request(new URL("/index.html", context.req.url), context.req.raw)),
  } });
};
