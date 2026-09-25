import assert from "node:assert/strict";
import test from "node:test";
import {
  ApiError,
  classifyError,
  fieldId,
  formatIssuePath,
  request,
} from "../src/frontend/api.ts";

const jsonResponse = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

const rejectionOf = async (fetchImpl: () => Promise<Response>) => {
  try {
    await request("/api/projects", undefined, fetchImpl);
  } catch (error) {
    return error;
  }
  assert.fail("request should reject");
};

test("issue pathを入力ラベルとfield idへ対応づける", () => {
  assert.equal(formatIssuePath("name"), "Project名");
  assert.equal(formatIssuePath("principles.0"), "Principles 1");
  assert.equal(formatIssuePath("repositories.1.url"), "Repositories 2のURL");
  assert.equal(formatIssuePath("resources.0.kind"), "Resources 1の種類");
  assert.equal(formatIssuePath(""), "入力全体");
  assert.equal(fieldId("repositories.1.url"), "field-repositories-1-url");
});

test("400 VALIDATION_ERRORはissues付きの入力エラーとして分類する", async () => {
  const error = await rejectionOf(async () =>
    jsonResponse(400, {
      error: {
        code: "VALIDATION_ERROR",
        message: "Project input is invalid",
        issues: [
          { path: "principles.0", message: "principle is required" },
          { path: "repositories.0.url", message: "must be a valid URL" },
        ],
      },
    }),
  );
  assert.deepEqual(classifyError(error), {
    kind: "validation",
    issues: [
      { fieldId: "field-principles-0", label: "Principles 1", message: "principle is required" },
      {
        fieldId: "field-repositories-0-url",
        label: "Repositories 1のURL",
        message: "must be a valid URL",
      },
    ],
  });
});

test("issuesがないVALIDATION_ERRORとbody全体のissueはfieldに紐づけない", async () => {
  const withoutIssues = await rejectionOf(async () =>
    jsonResponse(400, { error: { code: "VALIDATION_ERROR", message: "invalid" } }),
  );
  assert.deepEqual(classifyError(withoutIssues), {
    kind: "validation",
    issues: [{ fieldId: null, label: "入力全体", message: "invalid" }],
  });

  const invalidJson = await rejectionOf(async () =>
    jsonResponse(400, {
      error: {
        code: "VALIDATION_ERROR",
        message: "Project input is invalid",
        issues: [{ path: "", message: "request body must be valid JSON" }],
      },
    }),
  );
  const classified = classifyError(invalidJson);
  assert.equal(classified.kind, "validation");
  assert.equal(classified.kind === "validation" && classified.issues[0]?.fieldId, null);
});

test("404 NOT_FOUNDは入力エラーでも一般の失敗でもなくnot_foundと分類する", async () => {
  const error = await rejectionOf(async () =>
    jsonResponse(404, { error: { code: "NOT_FOUND", message: "Project not found" } }),
  );
  assert.deepEqual(classifyError(error), { kind: "not_found" });
});

test("500・非JSON応答・接続失敗は入力エラーにせずotherと分類する", async () => {
  const serverError = await rejectionOf(async () =>
    jsonResponse(500, { error: { code: "INTERNAL_ERROR", message: "Internal Server Error" } }),
  );
  assert.equal(classifyError(serverError).kind, "other");

  const htmlError = await rejectionOf(async () => new Response("<html>Bad Gateway</html>", { status: 502 }));
  assert.ok(htmlError instanceof ApiError);
  assert.equal(htmlError.status, 502);
  assert.equal(htmlError.code, "HTTP_ERROR");
  assert.equal(classifyError(htmlError).kind, "other");

  const notJsonOk = await rejectionOf(async () => new Response("ok", { status: 200 }));
  assert.ok(notJsonOk instanceof ApiError);
  assert.equal(notJsonOk.code, "INVALID_RESPONSE");

  const networkError = await rejectionOf(async () => {
    throw new TypeError("fetch failed");
  });
  assert.ok(networkError instanceof ApiError);
  assert.equal(networkError.code, "NETWORK_ERROR");
  assert.equal(classifyError(networkError).kind, "other");
});

test("400でもVALIDATION_ERROR以外のcodeは入力エラーにしない", async () => {
  const error = await rejectionOf(async () =>
    jsonResponse(400, { error: { code: "BAD_REQUEST", message: "bad" } }),
  );
  assert.equal(classifyError(error).kind, "other");
});

test("成功応答はJSONをそのまま返す", async () => {
  const body = await request<{ projects: unknown[] }>("/api/projects", undefined, async () =>
    jsonResponse(200, { projects: [] }),
  );
  assert.deepEqual(body, { projects: [] });
});
