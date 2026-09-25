import { randomUUID } from "node:crypto";
import type { Kysely } from "kysely";
import { createApp } from "../../src/app.ts";
import { deriveCsrfToken, generateSecretToken, hashSecretToken } from "../../src/application/service/secretToken.ts";
import type { HumanRole } from "../../src/domain/model/HumanAuth.ts";
import { sessionAbsoluteTtlMs } from "../../src/domain/model/HumanAuth.ts";
import type { Database } from "../../src/infrastructure/database/schema.ts";

type App = ReturnType<typeof createApp>;

/** `createApp`の既定（humanAuth未指定）と同じtrusted-localのCookie名・origin。 */
export const testSessionCookie = "compass_session";
export const testOrigin = "http://localhost";

export type TestHuman = { humanUserId: string; sessionToken: string; email: string };

/** テストの時刻源（固定・前進するclock）に依らず有効なSessionにするための最大時刻。 */
const farFuture = 8_640_000_000_000_000;

/**
 * テスト用のHuman・Session fixture。OIDCを通さず、DBへHuman・Sessionを直接作る
 * （docs/step-6-human-auth-design.md「既存テスト」。本番経路の検証は省かない）。
 * `now`を省くと、servicesのclockに依らず期限切れにならないSessionを作る。
 */
export const createTestHuman = async (
  database: Kysely<Database>,
  options: { email?: string; now?: number } = {},
): Promise<TestHuman> => {
  const now = options.now ?? Date.now();
  const sessionTime = options.now ?? farFuture;
  // 同じemailのHumanが既にあれば（再起動を模したテスト）、そのHumanへ新しいSessionだけを発行する。
  const existing = options.email
    ? await database.selectFrom("human_user").select("id").where("email", "=", options.email).executeTakeFirst()
    : undefined;
  const humanUserId = existing?.id ?? randomUUID();
  const email = options.email ?? `human-${humanUserId.slice(0, 8)}@example.com`;
  if (!existing) {
    await database
      .insertInto("human_user")
      .values({
        id: humanUserId,
        display_name: email,
        email,
        platform_role: "member",
        status: "active",
        created_at: now,
        updated_at: now,
      })
      .execute();
  }
  const sessionToken = generateSecretToken();
  await database
    .insertInto("web_session")
    .values({
      id: randomUUID(),
      token_hash: hashSecretToken(sessionToken),
      human_user_id: humanUserId,
      created_at: now,
      last_seen_at: sessionTime,
      expires_at: options.now === undefined ? farFuture : now + sessionAbsoluteTtlMs,
      revoked_at: null,
      revoke_reason: null,
    })
    .execute();
  return { humanUserId, sessionToken, email };
};

/** 有効なMembershipを直接作る（MCP・use caseで作られたowner不在のProjectをテストで使うため）。 */
export const addTestMembership = async (
  database: Kysely<Database>,
  projectId: string,
  human: Pick<TestHuman, "humanUserId">,
  role: HumanRole = "owner",
  now = Date.now(),
) => {
  const id = randomUUID();
  await database
    .insertInto("project_membership")
    .values({
      id,
      project_id: projectId,
      human_user_id: human.humanUserId,
      role,
      created_at: now,
      updated_at: now,
      created_by_human_user_id: null,
      revoked_at: null,
      revoked_by_human_user_id: null,
    })
    .execute();
  return id;
};

/** Session Cookie・CSRF token・Originを付けたrequest headers。 */
export const humanHeaders = (human: Pick<TestHuman, "sessionToken">, headers?: HeadersInit) => {
  const merged = new Headers(headers);
  merged.set("Cookie", `${testSessionCookie}=${human.sessionToken}`);
  merged.set("X-Compass-CSRF", deriveCsrfToken(human.sessionToken));
  merged.set("Origin", testOrigin);
  return merged;
};

/** Humanとして`app.request`を呼ぶ関数。 */
export const requestAs =
  (app: App, human: Pick<TestHuman, "sessionToken">) => (path: string, init: RequestInit = {}) =>
    app.request(path, { ...init, headers: humanHeaders(human, init.headers) });

/**
 * 有効なowner Membershipを持たないProject（MCP・use caseで作られたProject）へ、指定Humanのowner Membershipを補う。
 * platform ownerのログイン時のorphan補完と同じ結果をテストで再現する。
 */
export const adoptOrphanProjects = async (database: Kysely<Database>, human: Pick<TestHuman, "humanUserId">) => {
  const orphans = await database
    .selectFrom("project")
    .select("id")
    .where(({ not, exists, selectFrom }) =>
      not(
        exists(
          selectFrom("project_membership")
            .select("project_membership.id")
            .whereRef("project_membership.project_id", "=", "project.id")
            .where("project_membership.revoked_at", "is", null),
        ),
      ),
    )
    .execute();
  for (const { id } of orphans) await addTestMembership(database, id, human, "owner");
};

/**
 * 既存の匿名Web APIテストをSession付きへ移すためのapp。Humanを1人作り、`app.request`へSession Cookie・CSRFを付け、
 * 各requestの前にowner不在のProjectをそのHumanのowner Membershipにする（platform ownerのorphan補完に相当）。
 */
export const createSignedInApp = async (
  database: Kysely<Database>,
  services?: Parameters<typeof createApp>[0],
  options: { email?: string } = {},
) => {
  const app = createApp(services);
  const human = await createTestHuman(database, { email: options.email ?? "tester@example.com" });
  const original = app.request.bind(app);
  // 並行requestでも同じProjectへ二重に補完しないよう、補完だけを直列にする。
  let adoption = Promise.resolve();
  const signedIn = (async (input: string | Request | URL, init?: RequestInit, ...rest: unknown[]) => {
    adoption = adoption.then(() => adoptOrphanProjects(database, human));
    await adoption;
    const call = original as (...args: unknown[]) => Response | Promise<Response>;
    if (typeof input !== "string") return call(input, init, ...rest);
    return call(input, { ...init, headers: humanHeaders(human, init?.headers) }, ...rest);
  }) as App["request"];
  return Object.assign(app, { request: signedIn, human });
};
