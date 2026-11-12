import { createWorkersApplication, type WorkersEnvironment } from "./bootstrap/createWorkersApplication.ts";
import { HumanAuthConfigError } from "./auth/humanAuthConfig.ts";

/** 配信文書とrevisionはbuild時に固定する。bindingは各requestから受け取る。 */
export const createWorker = (documents: Readonly<Record<string, string>>, revision: string | null) => ({
  async fetch(request: Request, env: WorkersEnvironment): Promise<Response> {
    try {
      // D1の接続やsessionをrequest間で共有せず、認証・整合性の境界を維持する。
      const app = await createWorkersApplication(env, documents, revision);
      return await app.fetch(request);
    } catch (error) {
      console.error(error instanceof HumanAuthConfigError ? `Configuration error: ${error.message}` : "Compass request initialization failed");
      return Response.json({ error: { code: "SERVICE_UNAVAILABLE", message: "Compass is not ready" } }, { status: 503 });
    }
  },
});
