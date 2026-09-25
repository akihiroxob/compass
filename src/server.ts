import { serve } from "@hono/node-server";
import { createApp } from "./app.ts";
import { createApplicationServices } from "./createApplicationServices.ts";
import { createDatabase } from "./infrastructure/database/createDatabase.ts";
import { initializeSchema } from "./infrastructure/database/initializeSchema.ts";
import { GoogleOidcIdentityProvider } from "./infrastructure/identity/GoogleOidcIdentityProvider.ts";
import {
  assertBootstrapConfigured,
  HumanAuthConfigError,
  loadHumanAuthConfig,
} from "./presentation/http/humanAuthConfig.ts";

const port = Number(process.env.PORT) || 51800;

const start = async () => {
  // 設定不正（remoteの必須値欠落・https以外・trusted-localの非loopback bind等）はDBを開く前に起動を拒否する。
  const authConfig = loadHumanAuthConfig(process.env, { port });
  const database = createDatabase();
  await initializeSchema(database);
  const services = createApplicationServices(database, undefined, undefined, {
    initialOwnerEmail: authConfig.initialOwnerEmail,
    identityProvider: authConfig.google ? new GoogleOidcIdentityProvider(authConfig.google) : null,
  });
  assertBootstrapConfigured(authConfig, await services.getHumanAuthBootstrapStatusUseCase.execute());

  const app = createApp(services, { humanAuth: { mode: authConfig.mode, publicOrigin: authConfig.publicOrigin } });
  serve({ fetch: app.fetch, port, hostname: authConfig.host }, (info) => {
    console.log(`Compass running at http://${info.address}:${info.port} (auth mode: ${authConfig.mode})`);
  });
};

start().catch((error: unknown) => {
  // 設定エラーは環境変数の名前だけを出す（値・secretを出さない）。
  console.error(error instanceof HumanAuthConfigError ? `Configuration error: ${error.message}` : error);
  process.exit(1);
});
