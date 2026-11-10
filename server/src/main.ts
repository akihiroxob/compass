import { serve } from "@hono/node-server";
import { existsSync } from "node:fs";
import { loadEnvFile } from "node:process";
import { createApp } from "./bootstrap/app.ts";
import { createApplicationServices } from "./bootstrap/createApplicationServices.ts";
import { createDatabase } from "./bootstrap/database/createDatabase.ts";
import { GitHubPullRequestGateway } from "@compass/work";
import { GoogleOidcIdentityProvider } from "./auth/GoogleOidcIdentityProvider.ts";
import {
  assertBootstrapConfigured,
  HumanAuthConfigError,
  loadHumanAuthConfig,
} from "./auth/humanAuthConfig.ts";

const port = Number(process.env.PORT) || 51800;

const start = async () => {
  if (existsSync(".env")) loadEnvFile(".env");
  // 設定不正（remoteの必須値欠落・https以外・trusted-localの非loopback bind等）はDBを開く前に起動を拒否する。
  const authConfig = loadHumanAuthConfig(process.env, { port });
  const database = createDatabase();
  // GitHubの読取（読取専用）。tokenは任意で、値をログへ出さない。API URLは検証用のGitHub互換adapterへ向けるときだけ指定する。
  const github = new GitHubPullRequestGateway({
    apiBaseUrl: process.env.COMPASS_GITHUB_API_URL || undefined,
    token: process.env.COMPASS_GITHUB_TOKEN || null,
  });
  const services = createApplicationServices(database, undefined, undefined, {
    initialOwnerEmail: authConfig.initialOwnerEmail,
    identityProvider: authConfig.google
      ? new GoogleOidcIdentityProvider(authConfig.google)
      : null,
  }, {
    // PRの事実（完了・レビュー・受入の照合）と、公開記録のrevisionに変更のCommitが含まれるかの判定。
    pullRequests: github,
    revisions: github,
  });
  assertBootstrapConfigured(
    authConfig,
    await services.getHumanAuthBootstrapStatusUseCase.execute(),
  );

  const app = createApp(services, {
    humanAuth: { mode: authConfig.mode, publicOrigin: authConfig.publicOrigin },
  });
  serve({ fetch: app.fetch, port, hostname: authConfig.host }, (info) => {
    console.log(
      `Compass running at http://${info.address}:${info.port} (auth mode: ${authConfig.mode})`,
    );
  });
};

start().catch((error: unknown) => {
  // 設定エラーは環境変数の名前だけを出す（値・secretを出さない）。
  console.error(
    error instanceof HumanAuthConfigError
      ? `Configuration error: ${error.message}`
      : error,
  );
  process.exit(1);
});
