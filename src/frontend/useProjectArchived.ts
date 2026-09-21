import { useEffect, useState } from "react";
import { request } from "./api";
import type { Project } from "./projectForm";

/**
 * Projectがarchivedかどうか。取得できるまで・取得に失敗した場合は`null`で、呼び出し側は変更の導線を出さない
 * （導線の非表示は表示上の配慮であり、拒否はサーバーが行う）。
 */
export const useProjectArchived = (projectId: string): boolean | null => {
  const [archived, setArchived] = useState<boolean | null>(null);
  useEffect(() => {
    let current = true;
    request<{ project: Project }>(`/api/projects/${projectId}`)
      .then(({ project }) => current && setArchived(project.status === "archived"))
      .catch(() => current && setArchived(null));
    return () => { current = false; };
  }, [projectId]);
  return archived;
};
