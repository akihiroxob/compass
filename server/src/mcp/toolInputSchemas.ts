import { z } from "zod";
import { directionDecisionRecordTypes } from "@compass/direction";


export const nullableText = (maximum: number) => z.string().max(maximum).nullable().optional();
export const namedLink = { name: z.string(), url: z.string() };
/** RepositoryのPRレビューで成功を必須とするGitHubのcheck名。省略時は作成なら空（CI不要）、更新なら既存行の値を維持する。 */
export const repositoryLink = { ...namedLink, requiredChecks: z.array(z.string()).optional() };

export const projectInputSchema = {
  name: z.string(),
  description: nullableText(1_000),
  mission: z.string(),
  vision: nullableText(2_000),
  principles: z.array(z.string()).optional(),
  constraints: z.array(z.string()).optional(),
  repositories: z.array(z.object(repositoryLink)).optional(),
  resources: z.array(z.object({ ...namedLink, kind: nullableText(100) })).optional(),
};

export const projectUpdateSchema = {
  projectId: z.string().min(1),
  name: z.string().optional(),
  description: nullableText(1_000),
  repositories: z.array(z.object({ id: z.string().optional(), ...repositoryLink })).optional(),
  resources: z
    .array(z.object({ id: z.string().optional(), ...namedLink, kind: nullableText(100) }))
    .optional(),
};

// Intentの入力規則はdirectionのintentSchemaが持つ（Web UIと共通）。ここでは型だけを宣言し、必須・上限・日付形式はuse caseで検証する。
export const intentOptionalFields = {
  background: z.string().nullable().optional(),
  audience: z.string().nullable().optional(),
  constraints: z.string().nullable().optional(),
  completionDefinition: z.string().nullable().optional(),
  targetDate: z.string().nullable().optional(),
};

export const intentCreateSchema = {
  workspaceId: z.string().min(1),
  title: z.string(),
  desiredState: z.string(),
  ...intentOptionalFields,
};

export const intentUpdateSchema = {
  workspaceId: z.string().min(1),
  intentId: z.string().min(1),
  expectedVersion: z.number().int(),
  reason: z.string().nullable().optional(),
  title: z.string().optional(),
  desiredState: z.string().optional(),
  ...intentOptionalFields,
};

export const intentFieldsDescription =
  "Required: title (up to 100 characters) and desiredState (up to 2,000). Optional: background, audience (target / scope), " +
  "constraints and completionDefinition (each up to 2,000) and targetDate (a calendar date in YYYY-MM-DD). " +
  "The same validation as the Web UI applies (VALIDATION_ERROR otherwise).";

// Outcomeの入力規則はdirectionのoutcomeSchemaが持つ（Web UIと共通）。成功条件は作成時に固定され、更新用のschemaには含めない。
export const outcomeProblemInput = z.object({
  id: z.string().optional(),
  statement: z.string(),
  evidenceStatus: z.enum(["insufficient", "observed", "refuted"]),
  observation: z.string().nullable().optional(),
  causeHypothesis: z.string().nullable().optional(),
  solutionHypothesis: z.string().nullable().optional(),
  evaluationPlan: z
    .object({
      question: z.string(),
      method: z.enum(["cognitive_walkthrough", "quantitative_observation", "ab_test", "difference_in_differences", "other"]),
      premises: z.string().nullable().optional(),
      observationPeriod: z.string().nullable().optional(),
      decisionCriteria: z.string(),
      stopCriteria: z.string().nullable().optional(),
    })
    .nullable()
    .optional(),
  evidence: z.array(z.object({ kind: z.enum(["research_finding", "research_synthesis"]), id: z.string() })).optional(),
});

export const outcomeProblemsDescription =
  "problems lists the problems (Problem Statements) that block this Outcome, each with statement (up to 500 characters), " +
  "evidenceStatus (insufficient | observed | refuted), observation (the observed fact), causeHypothesis (a hypothesis about the cause; " +
  "an observation such as drop-off does not confirm the cause), solutionHypothesis, and evidence (research_finding / research_synthesis " +
  "ids of the same Workspace; up to 10), and an optional evaluationPlan { question, method (cognitive_walkthrough | quantitative_observation | ab_test | difference_in_differences | other), " +
  "premises (required for ab_test and difference_in_differences: how the method's assumptions are met), observationPeriod, decisionCriteria, stopCriteria }. " +
  "A plan is not a result: it stays not run until an Evaluation names the problem in problemIds while that plan is current. The server assigns a planId that changes when a plan is added or its content changes; an Evaluation names the planId it evaluated in planIds, so results of an earlier plan never mark the changed plan as run. Compass runs no statistical analysis. " +
  "observed and refuted require observation and at least one evidence reference. Up to 10 problems. " +
  "Evidence of another Workspace fails with VALIDATION_ERROR; newly linking a Synthesis superseded by a later version fails with CONFLICT. " +
  "Development blockers of Tasks are not problems.";

export const outcomeCreateSchema = {
  workspaceId: z.string().min(1),
  intentId: z.string().min(1),
  title: z.string(),
  description: z.string(),
  hypothesis: z.string().nullable().optional(),
  rationale: z.string(),
  successCriteria: z.array(
    z.object({ description: z.string(), measurement: z.string(), target: z.string().nullable().optional() }),
  ),
  intentVersion: z.number().int(),
  problems: z.array(outcomeProblemInput).optional(),
};

export const outcomeUpdateSchema = {
  workspaceId: z.string().min(1),
  intentId: z.string().min(1),
  outcomeId: z.string().min(1),
  intentVersion: z.number().int().optional(),
  title: z.string().optional(),
  hypothesis: z.string().nullable().optional(),
  problems: z.array(outcomeProblemInput).optional(),
  expectedRevision: z.number().int().optional(),
  // 固定項目は受け付けないが、schemaに無いとzodが黙って捨てるため宣言し、use caseがCONFLICTで拒否できるようにする。
  description: z.unknown().optional(),
  rationale: z.unknown().optional(),
  successCriteria: z.unknown().optional(),
};

// Researchの入力規則はshared/researchSchemaが持つ。ここでは型だけを宣言する。
// principalIdは入力に持たない。来歴のPrincipalはBearerから解決した値だけを使う。
export const researchRequestRef = { workspaceId: z.string().min(1), requestId: z.string().min(1) };
export const researchProvenance = { requestKey: z.string(), runRef: z.string() };
export const researchTextList = z.array(z.string()).optional();

export const researchResultSchema = {
  ...researchRequestRef,
  ...researchProvenance,
  summary: z.string(),
  budgetUsed: z.number().optional(),
  evidenceRefs: z
    .array(
      z.object({
        kind: z.string(),
        uri: z.string(),
        retrievedAt: z.number(),
        versionHash: z.string().nullable().optional(),
      }),
    )
    .optional(),
  findings: z
    .array(
      z.object({
        statement: z.string(),
        confidence: z.string(),
        observedAt: z.number(),
        expiresAt: z.number().nullable().optional(),
        evidenceIndexes: z.array(z.number()),
        conflictsWithFindingIds: z.array(z.string()).optional(),
      }),
    )
    .optional(),
  unknowns: researchTextList,
  options: researchTextList,
  risks: researchTextList,
};

// Direction Decisionの入力規則もshared/directionDecisionSchemaが持つ。ここでは型だけを宣言する。
// principalIdは入力に持たない。来歴のPrincipalはBearerから解決した値だけを使う。
export const usedSynthesisRefSchema = z.object({ synthesisId: z.string().min(1), version: z.number().int().min(1) });

export const directionDecisionCommonSchema = {
  workspaceId: z.string().min(1),
  intentId: z.string().min(1),
  intentVersion: z.number().int(),
  judgment: z.string(),
  reason: z.string(),
  options: z.array(z.string()).optional(),
  usedSyntheses: z.array(usedSynthesisRefSchema).optional(),
  usedFindingIds: z.array(z.string()).optional(),
  requestKey: z.string(),
  runRef: z.string(),
  evaluationId: z.string().optional(),
};

// additional_researchだけが`research`（Strategistが決める調査計画）を必須とする。規則はshared/directionDecisionSchemaが持つ。
export const additionalResearchPlanMcpSchema = z.object({
  question: z.string(),
  scope: z.string(),
  completionCondition: z.string(),
  budgetTotal: z.number().int(),
  deadlineAt: z.number().int().nullable().optional(),
});

export const createDirectionDecisionMcpSchema = {
  ...directionDecisionCommonSchema,
  type: z.enum(directionDecisionRecordTypes),
  research: additionalResearchPlanMcpSchema.optional(),
};

export const decideNextOutcomeMcpSchema = {
  ...directionDecisionCommonSchema,
  outcome: z.object(outcomeCreateSchema).omit({ workspaceId: true, intentId: true, intentVersion: true }),
};

// ADR Handoffの入力規則もshared/adrHandoffSchemaが持つ。ここでは型だけを宣言する。
export const adrHandoffRequestMcpSchema = {
  workspaceId: z.string().min(1),
  projectId: z.string().min(1),
  decisionId: z.string().min(1),
  repositoryId: z.string().min(1),
  correlationId: z.string().min(1),
  requestKey: z.string().min(1),
};

export const adrReferenceMcpSchema = {
  workspaceId: z.string().min(1),
  projectId: z.string().min(1),
  decisionId: z.string().min(1),
  repositoryId: z.string().min(1),
  path: z.string().min(1),
  commitSha: z.string().min(1),
  pullRequestUrl: z.string().nullable().optional(),
  correlationId: z.string().min(1),
  requestKey: z.string().min(1),
};

export const researchSynthesisSchema = {
  ...researchRequestRef,
  ...researchProvenance,
  conclusion: z.string(),
  findingIds: z.array(z.string()),
  risks: researchTextList,
  options: researchTextList,
  unknowns: researchTextList,
  validAsOf: z.number(),
  supersedesId: z.string().nullable().optional(),
};

// Outcome Evaluationの入力規則はshared/outcomeEvaluationSchemaが持つ。ここでは型だけを宣言する。
// 総合結果は入力に持たない（Criterionの判定から導出する）。principalIdも入力に持たない。
export const outcomeEvaluationSchema = {
  workspaceId: z.string().min(1),
  outcomeId: z.string().min(1),
  requestKey: z.string(),
  runRef: z.string(),
  method: z.string(),
  targetVersion: z.string(),
  limitations: z.string(),
  problemIds: z.array(z.string()).optional(),
  planIds: z.record(z.string(), z.string()).optional(),
  criteria: z.array(
    z.object({
      criterionId: z.string(),
      verdict: z.string(),
      rationale: z.string(),
      evidenceIds: z.array(z.string()).optional(),
    }),
  ),
};
