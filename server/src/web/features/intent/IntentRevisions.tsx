import { useState } from "react";
import { classifyError, loadFailureMessage, request } from "../../api";
import { ErrorState, Loading } from "../../components/StateCard";
import { workspaceApiPath } from "../../paths";
import { statusBadgeClass } from "../../statusTone";
import type { IntentRevision } from "./intent";

const principalLabel = (revision: IntentRevision) => (revision.changedBy.startsWith("human:") ? "Human" : revision.changedBy);

/**
 * 目標の版の履歴。開いたときに読み、変更した主体・時刻・理由と、意味（実現したい状態・達成条件）が変わった版を示す。各版のタイトル・実現したい状態・達成条件をそのまま読める。
 * 評価・判断・Outcomeが参照する「目標 vN」の内容はここで確認できる。
 */
export const IntentRevisions = ({ workspaceId, intentId, version }: { workspaceId: string; intentId: string; version: number }) => {
  const [state, setState] = useState<{ revisions: IntentRevision[] | null; error: string | null }>({ revisions: null, error: null });
  const load = (open: boolean) => {
    if (!open) return;
    setState({ revisions: null, error: null });
    request<{ revisions: IntentRevision[] }>(workspaceApiPath(workspaceId, `/intents/${intentId}/revisions`))
      .then(({ revisions }) => setState({ revisions, error: null }))
      .catch((reason: unknown) => setState({ revisions: null, error: loadFailureMessage(classifyError(reason), "目標が見つかりません。") }));
  };
  return (
    <details className="past-intents intent-revisions" onToggle={(event) => load(event.currentTarget.open)}>
      <summary>変更履歴（現在 v{version}）</summary>
      {state.error ? <ErrorState message={`変更履歴の読み込みに失敗しました: ${state.error}`} /> : state.revisions === null ? <Loading /> : (
        <ol className="revision-list">
          {state.revisions.map((revision) => (
            <li key={revision.version}>
              <p><strong>v{revision.version}</strong> {revision.meaningChanged && <span className={statusBadgeClass("attention")}>意味を変更</span>} <small>{new Date(revision.createdAt).toLocaleString("ja-JP")} ・ {principalLabel(revision)}（{revision.changedByRole}）</small></p>
              <p>{revision.reason ?? <span className="unset">理由は記録されていません</span>}</p>
              <p className="section-note"><strong>{revision.title}</strong></p>
              <p className="section-note">実現したい状態：{revision.desiredState}</p>
              <p className="section-note">達成条件：{revision.completionDefinition ?? <span className="unset">未設定</span>}</p>
            </li>
          ))}
        </ol>
      )}
    </details>
  );
};
