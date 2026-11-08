import type { OutcomeDeliveryChange, OutcomeDeliveryPort, OutcomeProjectDelivery, OutcomeProjectRef } from "@compass/direction";

type ProjectReleases = {
  changes: {
    task: { id: string };
    story: { outcomeId: string | null } | null;
    publication: Pick<OutcomeDeliveryChange, "status" | "reason">;
  }[];
};

/**
 * OutcomeのTarget Projectごとに、Workの公開確認（リリース履歴）から変更の公開状況を読む。
 * Projectの公開確認を読めなければ、そのProjectの`changes`は`null`（未取得）で、変更なしにも公開なしにもしない。
 */
export class OutcomeDeliveryReader implements OutcomeDeliveryPort {
  constructor(private readonly releases: (projectId: string) => Promise<ProjectReleases>) {}

  async listOutcomeDeliveries(refs: OutcomeProjectRef[]): Promise<OutcomeProjectDelivery[]> {
    const projectIds = [...new Set(refs.map(({ projectId }) => projectId))];
    const loaded = new Map(await Promise.all(projectIds.map(async (projectId) => {
      try {
        return [projectId, await this.releases(projectId)] as const;
      } catch {
        return [projectId, null] as const;
      }
    })));
    return refs.map(({ outcomeId, projectId }) => {
      const releases = loaded.get(projectId) ?? null;
      return {
        outcomeId,
        projectId,
        changes: releases === null ? null : releases.changes
          .filter((change) => change.story?.outcomeId === outcomeId)
          .map((change) => ({ taskId: change.task.id, status: change.publication.status, reason: change.publication.reason })),
      };
    });
  }
}
