import assert from "node:assert/strict";
import test from "node:test";
import {
  basisSequences,
  consultationApiPath,
  consultationDetailPath,
  consultationFilterSearch,
  consultationListPath,
  consultationsApiPath,
  describeActor,
  describeConsultationReference,
  describeConsultationScope,
  inboxApiPath,
  inboxPath,
  messageKindLabel,
  parseConsultationFilter,
  parseInboxQuery,
} from "../src/web/features/consultation/consultation.ts";
import { parseProjectView, projectViewLabels } from "../src/web/features/project/overview.ts";
import { currentSection, parseShellLocation, workspaceSectionLabels } from "../src/web/features/workspace/workspace.ts";

/**
 * Web UIの相談（判断待ち）。Project詳細・Workspaceのview・絞り込み・Web API path、横断一覧のquery、Humanの発言とAgentの発言・要約の区別、
 * scopeごとの参照の辿り先。
 */

const project = { kind: "project", projectId: "p1" } as const;
const workspace = { kind: "workspace", workspaceId: "w1" } as const;

test("判断待ちはProject詳細のviewで、絞り込みの既定はHumanの判断待ち", () => {
  assert.equal(parseProjectView("consultations"), "consultations");
  assert.equal(projectViewLabels.consultations, "判断待ち");
  assert.equal(consultationListPath(project), "/projects/p1?view=consultations");
  assert.equal(parseConsultationFilter(null), "waiting_human");
  assert.equal(parseConsultationFilter("resolved"), "resolved");
  assert.equal(parseConsultationFilter("unknown"), "waiting_human");
  const current = new URLSearchParams("view=consultations&status=resolved");
  assert.equal(consultationFilterSearch(current, "waiting_human"), "?view=consultations");
  assert.equal(consultationFilterSearch(current, "all"), "?view=consultations&status=all");
  assert.equal(consultationsApiPath(project, "waiting_agent"), "/api/projects/p1/consultations?status=waiting_agent");
  assert.equal(consultationsApiPath(project, "all"), "/api/projects/p1/consultations");
  assert.equal(consultationApiPath(project, "c1", "/resolution"), "/api/projects/p1/consultations/c1/resolution");
});

test("Workspace相談はWorkspaceの「判断待ち」とWorkspace配下の詳細で、Web APIもWorkspaceのpath", () => {
  assert.equal(workspaceSectionLabels.consultations, "判断待ち");
  assert.equal(consultationListPath(workspace), "/workspaces/w1/consultations");
  assert.equal(consultationDetailPath(workspace, "c1"), "/workspaces/w1/consultations/c1");
  assert.equal(consultationDetailPath(project, "c1"), "/projects/p1/consultations/c1");
  assert.equal(consultationsApiPath(workspace, "waiting_human"), "/api/workspaces/w1/consultations?status=waiting_human");
  assert.equal(consultationApiPath(workspace, "c1", "/messages"), "/api/workspaces/w1/consultations/c1/messages");
  assert.equal(currentSection(parseShellLocation("/workspaces/w1/consultations")), "consultations");
  assert.equal(currentSection(parseShellLocation("/workspaces/w1/consultations/c1")), "consultations");
  assert.equal(currentSection(parseShellLocation("/workspaces/w1/consultations/c1/extra")), null);
});

test("横断一覧の絞り込みはURLのqueryで、既定はHumanの判断待ち・全scope。Projectの指定はProject scopeに限る", () => {
  const defaults = parseInboxQuery(new URLSearchParams());
  assert.deepEqual(defaults, { status: "waiting_human", scope: "all", projectId: null, workspaceId: null });
  assert.equal(inboxPath(defaults), "/consultations");
  assert.equal(inboxApiPath(defaults), "/api/consultations?status=waiting_human");
  const query = parseInboxQuery(new URLSearchParams("status=all&scope=workspace&workspaceId=w1&projectId=p1"));
  assert.deepEqual(query, { status: "all", scope: "project", projectId: "p1", workspaceId: "w1" });
  assert.equal(inboxPath(query), "/consultations?status=all&scope=project&workspaceId=w1&projectId=p1");
  assert.equal(inboxApiPath(query, "1.c"), "/api/consultations?status=all&scope=project&workspaceId=w1&projectId=p1&cursor=1.c");
  assert.equal(parseInboxQuery(new URLSearchParams("status=open&scope=global")).status, "waiting_human");
  assert.equal(parseInboxQuery(new URLSearchParams("scope=global")).scope, "all");
  const names = { projects: new Map([["p1", "Compass"]]), workspaces: new Map([["w1", "Product"]]) };
  assert.equal(describeConsultationScope({ scope: "project", workspaceId: "w1", projectId: "p1" }, names), "Project · Compass");
  assert.equal(describeConsultationScope({ scope: "workspace", workspaceId: "w1", projectId: null }, names), "Workspace · Product");
  assert.equal(describeConsultationScope({ scope: "workspace", workspaceId: "w2-unknown", projectId: null }, names), "Workspace · w2-unkno");
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
  assert.deepEqual(describeConsultationReference(project, { kind: "project_resource", resourceId: "r1", path: "docs/a.md", revision: "0123456789abcdef" }, resources), {
    label: "primary", detail: "docs/a.md @ 0123456789ab", href: "https://example.com/repo",
  });
  assert.deepEqual(describeConsultationReference(project, { kind: "project_resource", resourceId: "gone", path: null, revision: null }, resources), { label: "登録が外れたResource gone", detail: null });
  assert.deepEqual(describeConsultationReference(project, { kind: "project_resource", resourceId: "r1", path: null, revision: null }, null), { label: "Resource r1", detail: null });
  assert.equal(describeConsultationReference(project, { kind: "task", id: "t1" }, resources).to, "/projects/p1/tasks/t1");
  assert.equal(describeConsultationReference(project, { kind: "story", id: "s1" }, resources).to, "/projects/p1?view=work#execution-story-s1");
  assert.equal(describeConsultationReference(project, { kind: "consultation", id: "c0" }, resources).to, "/projects/p1/consultations/c0");
  assert.equal(describeConsultationReference(project, { kind: "url", url: "https://example.com/x" }, resources).href, "https://example.com/x");
});

test("Workspace相談の参照はIntentをWorkspaceの方向へ、OutcomeをWorkspaceのOutcome詳細へ、相談をWorkspace配下の詳細へ辿る", () => {
  assert.equal(describeConsultationReference(workspace, { kind: "intent", id: "i1" }, null).to, "/workspaces/w1/direction");
  assert.equal(describeConsultationReference(workspace, { kind: "outcome", intentId: "i1", id: "o1" }, null).to, "/workspaces/w1/direction/intents/i1/outcomes/o1");
  assert.equal(describeConsultationReference(workspace, { kind: "consultation", id: "c0" }, null).to, "/workspaces/w1/consultations/c0");
});
