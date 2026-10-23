import assert from "node:assert/strict";
import test from "node:test";
import {
  basisSequences,
  consultationApiPath,
  consultationFilterSearch,
  consultationListPath,
  consultationsApiPath,
  describeActor,
  describeConsultationReference,
  messageKindLabel,
  parseConsultationFilter,
} from "../src/web/features/consultation/consultation.ts";
import { parseProjectView, projectViewLabels } from "../src/web/features/project/overview.ts";

/** Web UIの相談（判断待ち）。Project詳細のview・絞り込み・Web API path、Humanの発言とAgentの発言・要約の区別、参照の辿り先。 */

test("判断待ちはProject詳細のviewで、絞り込みの既定はHumanの判断待ち", () => {
  assert.equal(parseProjectView("consultations"), "consultations");
  assert.equal(projectViewLabels.consultations, "判断待ち");
  assert.equal(consultationListPath("p1"), "/projects/p1?view=consultations");
  assert.equal(parseConsultationFilter(null), "waiting_human");
  assert.equal(parseConsultationFilter("resolved"), "resolved");
  assert.equal(parseConsultationFilter("unknown"), "waiting_human");
  const current = new URLSearchParams("view=consultations&status=resolved");
  assert.equal(consultationFilterSearch(current, "waiting_human"), "?view=consultations");
  assert.equal(consultationFilterSearch(current, "all"), "?view=consultations&status=all");
  assert.equal(consultationsApiPath("p1", "waiting_agent"), "/api/projects/p1/consultations?status=waiting_agent");
  assert.equal(consultationsApiPath("p1", "all"), "/api/projects/p1/consultations");
  assert.equal(consultationApiPath("p1", "c1", "/resolution"), "/api/projects/p1/consultations/c1/resolution");
});

test("Humanの発言はMemberの表示名、AgentはPrincipalとRoleで出し、訂正を示す", () => {
  const names = new Map([["h1", "Aki"]]);
  assert.equal(describeActor({ kind: "human", principalId: "human:h1", role: "operator" }, names), "Human Aki");
  assert.equal(describeActor({ kind: "agent", principalId: "manager-a", role: "manager" }), "Agent manager-a（Manager）");
  assert.equal(messageKindLabel({ author: { kind: "human", principalId: "human:h1", role: "operator" }, correctsMessageId: null }), "Humanの返信");
  assert.equal(messageKindLabel({ author: { kind: "agent", principalId: "w", role: "worker" }, correctsMessageId: "m1" }), "Agentの回答・質問（訂正）");
  assert.deepEqual(basisSequences({ basisMessageIds: ["m3", "gone", "m1"] }, [{ id: "m1", sequence: 1 }, { id: "m3", sequence: 3 }]), [3, 1]);
});

test("参照は成果物の正本へのlink、Task・Story・相談は画面へ辿り、登録が外れたResourceはIDを出す", () => {
  const resources = [{ id: "r1", name: "primary", url: "https://example.com/repo" }];
  assert.deepEqual(describeConsultationReference("p1", { kind: "project_resource", resourceId: "r1", path: "docs/a.md", revision: "0123456789abcdef" }, resources), {
    label: "primary", detail: "docs/a.md @ 0123456789ab", href: "https://example.com/repo",
  });
  assert.deepEqual(describeConsultationReference("p1", { kind: "project_resource", resourceId: "gone", path: null, revision: null }, resources), { label: "登録が外れたResource gone", detail: null });
  assert.deepEqual(describeConsultationReference("p1", { kind: "project_resource", resourceId: "r1", path: null, revision: null }, null), { label: "Resource r1", detail: null });
  assert.equal(describeConsultationReference("p1", { kind: "task", id: "t1" }, resources).to, "/projects/p1/tasks/t1");
  assert.equal(describeConsultationReference("p1", { kind: "story", id: "s1" }, resources).to, "/projects/p1?view=work#execution-story-s1");
  assert.equal(describeConsultationReference("p1", { kind: "consultation", id: "c0" }, resources).to, "/projects/p1/consultations/c0");
  assert.equal(describeConsultationReference("p1", { kind: "url", url: "https://example.com/x" }, resources).href, "https://example.com/x");
});
