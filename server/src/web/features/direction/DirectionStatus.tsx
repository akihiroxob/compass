import type { StatusTone } from "../../statusTone";
import type { EvaluationStage, TargetWork } from "./overview";

/** Outcomeの評価の段階の表示。Workspaceの概要・方向とProjectの概要で同じ文言・toneを使う。 */
export const stageLabels: Record<EvaluationStage, { label: string; tone: StatusTone }> = {
  decided: { label: "判断済み", tone: "done" },
  decision_pending: { label: "評価済み・判断待ち", tone: "attention" },
  evaluation_pending: { label: "評価待ち", tone: "waiting" },
  no_targets: { label: "Target未設定", tone: "attention" },
  replan_required: { label: "再計画待ち", tone: "warning" },
  awaiting_execution: { label: "実行・還流待ち", tone: "progress" },
};

const workCountLabels = { todo: "未着手", doing: "作業中", in_review: "レビュー待ち", wait_accept: "受入待ち", rejected: "差戻し", accepted: "受入済み" } as const;

/** Target 1件のStory件数と、状態別のTask件数（0件の状態は出さない）。 */
export const WorkCounts = ({ work }: { work: TargetWork["work"] }) => {
  const counts = work ? (Object.keys(workCountLabels) as (keyof typeof workCountLabels)[]).filter((key) => work.taskCounts[key] > 0) : [];
  return (
    <small>
      {work === null
        ? "Storyはまだありません"
        : counts.length === 0 && work.taskCounts.canceled === 0
        ? <>Story {work.storyCount}件 ・ Taskはまだありません</>
        : <>Story {work.storyCount}件{counts.map((key) => <span key={key}> ・ {workCountLabels[key]} {work.taskCounts[key]}</span>)}</>}
    </small>
  );
};

/** 所属WorkspaceのMissionとVision。ページの方向として本文より先に置く（Workspaceの概要・方向、Projectの方向）。 */
export const DirectionPanel = ({ mission, vision }: { mission: string; vision: string | null }) => (
  <section className="direction-panel" aria-label="MissionとVision">
    <div><p className="section-label">Mission</p><p>{mission}</p></div>
    <div><p className="section-label">Vision</p><p>{vision ?? <span className="unset">未設定</span>}</p></div>
  </section>
);
