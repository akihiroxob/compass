import type { Consultation, ConsultationStore } from "@compass/collaboration";
import type { OutcomeProblemFact, OutcomeProblemFacts, OutcomeProblemPort, OutcomeProjectRef } from "@compass/direction";
import type { WorkStore } from "@compass/work";

const openStatuses = ["waiting_human", "waiting_agent"] as const;

const toFact = (consultation: Consultation, projectIds: string[], taskIds: string[]): OutcomeProblemFact => ({
  consultationId: consultation.id,
  kind: consultation.status === "waiting_human" ? "waiting_human" : "waiting_agent",
  scope: consultation.scope,
  title: consultation.title,
  reason: consultation.blockingReason,
  projectIds,
  taskIds,
  updatedAt: consultation.updatedAt,
});

/**
 * Outcomeを止めている問題を、構造化された関連から導く。題名・理由の文章は照合に使わない。
 * - Target ProjectのOutcome相関StoryのTaskが待つ相談（`task_consultation_wait`）
 * - そのStory・Taskを参照するProject相談
 * - OutcomeをIntentとともに参照するWorkspace相談
 * 解決・取消済みの相談は含めない。読取りに失敗した場合は例外を投げ、呼び出し側が「未取得」として扱う。
 */
export class OutcomeProblemReader implements OutcomeProblemPort {
  constructor(
    private readonly workStore: Pick<WorkStore, "listStoriesByOutcomeProjects" | "listTasksOfStories" | "listConsultationWaits">,
    private readonly consultationStore: Pick<ConsultationStore, "listConsultations">,
  ) {}

  async listOutcomeProblems(workspaceId: string, outcomeIds: string[], refs: OutcomeProjectRef[]): Promise<OutcomeProblemFacts[]> {
    const byOutcome = new Map<string, Map<string, { consultation: Consultation; projects: Set<string>; tasks: Set<string> }>>(
      outcomeIds.map((id) => [id, new Map()]),
    );
    const add = (outcomeId: string, consultation: Consultation, projectId: string | null, taskId: string | null) => {
      const found = byOutcome.get(outcomeId);
      if (!found || !openStatuses.includes(consultation.status as (typeof openStatuses)[number])) return;
      const entry = found.get(consultation.id) ?? { consultation, projects: new Set<string>(), tasks: new Set<string>() };
      if (projectId) entry.projects.add(projectId);
      if (taskId) entry.tasks.add(taskId);
      found.set(consultation.id, entry);
    };

    if (refs.length > 0) {
      const stories = await this.workStore.listStoriesByOutcomeProjects(refs);
      for (const projectId of new Set(refs.map((ref) => ref.projectId))) {
        const projectStories = stories.filter((story) => story.project_id === projectId && story.outcome_ref);
        if (projectStories.length === 0) continue;
        const outcomeOfStory = new Map(projectStories.map((story) => [story.id, story.outcome_ref as string]));
        const tasks = await this.workStore.listTasksOfStories(projectId, projectStories.map((story) => story.id));
        const outcomeOfTask = new Map(tasks.flatMap((task) => (task.story_id && outcomeOfStory.has(task.story_id) ? [[task.id, outcomeOfStory.get(task.story_id) as string] as const] : [])));
        const scope = { kind: "project", projectId } as const;
        const open = (await Promise.all(openStatuses.map((status) => this.consultationStore.listConsultations(scope, { status })))).flat();
        const byId = new Map(open.map((consultation) => [consultation.id, consultation]));
        for (const wait of await this.workStore.listConsultationWaits(projectId)) {
          const outcomeId = outcomeOfTask.get(wait.task_id);
          if (!outcomeId || wait.state !== "waiting") continue;
          for (const reference of JSON.parse(wait.consultations) as { id: string }[]) {
            const consultation = byId.get(reference.id);
            if (consultation) add(outcomeId, consultation, projectId, wait.task_id);
          }
        }
        for (const consultation of open) {
          for (const reference of consultation.refs) {
            if (reference.kind === "task" && outcomeOfTask.has(reference.id)) add(outcomeOfTask.get(reference.id) as string, consultation, projectId, reference.id);
            if (reference.kind === "story" && outcomeOfStory.has(reference.id)) add(outcomeOfStory.get(reference.id) as string, consultation, projectId, null);
          }
        }
      }
    }

    const workspaceScope = { kind: "workspace", workspaceId } as const;
    const workspaceOpen = (await Promise.all(openStatuses.map((status) => this.consultationStore.listConsultations(workspaceScope, { status })))).flat();
    for (const consultation of workspaceOpen) {
      for (const reference of consultation.refs) if (reference.kind === "outcome") add(reference.id, consultation, null, null);
    }

    return outcomeIds.map((outcomeId) => ({
      outcomeId,
      problems: [...(byOutcome.get(outcomeId)?.values() ?? [])].map(({ consultation, projects, tasks }) => toFact(consultation, [...projects], [...tasks])),
    }));
  }
}
