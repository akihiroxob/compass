import { useCallback, useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { classifyError, loadFailureMessage, request } from "../../api";
import { ErrorState, Loading } from "../../components/StateCard";
import { taskPath } from "../../paths";
import { statusBadgeClass } from "../../statusTone";
import {
  describePrincipal,
  earliestClaimExpiry,
  executionPath,
  formatClaimExpiry,
  formatTime,
  summarizeClaimHolders,
  taskStatusLabels,
  type ExecutionOverview,
  taskStatusTones,
} from "./execution";

type Loaded = { overview: ExecutionOverview; fetchedAt: number };

/**
 * Project詳細の「Claim保持中」（Task 02）。既存の`execution`のWork Claimだけから、誰がどのTaskを保持しているかを出す。
 * ClaimはTask操作権の期限付き保持で、Agentプロセスの稼働を示さない。Role割当・Credentialからは推測しない。
 */
export const ClaimHolderSection = ({ projectId }: { projectId: string }) => {
  const [loaded, setLoaded] = useState<Loaded | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  // 判定の基準時刻。取得時刻から始め、表示中に最も早い期限を過ぎたときだけ進める（カウントダウンはしない）。
  const [now, setNow] = useState(0);
  const load = useCallback((isCurrent: () => boolean = () => true) => {
    setPending(true);
    setError(null);
    return request<ExecutionOverview>(executionPath(projectId))
      .then((overview) => { if (isCurrent()) { const fetchedAt = Date.now(); setLoaded({ overview, fetchedAt }); setNow(fetchedAt); } })
      .catch((reason: unknown) => { if (isCurrent()) setError(loadFailureMessage(classifyError(reason), "Projectが見つかりません。")); })
      .finally(() => { if (isCurrent()) setPending(false); });
  }, [projectId]);
  useEffect(() => {
    let current = true;
    setLoaded(null);
    void load(() => current);
    return () => { current = false; };
  }, [load]);
  const holders = loaded ? summarizeClaimHolders(loaded.overview.tasks, now) : null;
  const earliest = holders ? earliestClaimExpiry(holders) : null;
  const expiredSinceFetch = loaded !== null && now > loaded.fetchedAt;
  useEffect(() => {
    if (earliest === null) return;
    const timer = setTimeout(() => setNow(Date.now()), Math.min(Math.max(earliest - Date.now() + 1, 0), 2 ** 31 - 1));
    return () => clearTimeout(timer);
  }, [earliest, now]);
  return (
    <section className="detail-section" aria-labelledby="claim-holders-heading">
      <h2 id="claim-holders-heading">Claim保持中</h2>
      <p className="section-note">
        期限内のClaimを持つAgentとTaskです。Claimは作業権の期限付き保持で、Agentプロセスの稼働を示しません。
        Strategist・Researcher・EvaluatorはClaimを持たないため、ここでは状態を観測できません。
      </p>
      <div className="claim-holder-toolbar">
        <span>{loaded ? `${formatTime(loaded.fetchedAt)} 取得` : "未取得"}</span>
        <button type="button" className="secondary-button compact" disabled={pending} onClick={() => void load()}>
          {pending ? "読み込み中..." : "再読込"}
        </button>
      </div>
      {error ? (
        <ErrorState message={`Claimの読み込みに失敗しました: ${error}`} />
      ) : !loaded || !holders ? (
        <Loading />
      ) : (
        <>
          {expiredSinceFetch && <p role="status" className="claim-holder-stale">取得後に期限を過ぎたClaimを保持中から外しました。再読込して最新の状態を確認してください。</p>}
          {holders.groups.length ? (
            holders.groups.map((group) => (
              <div key={group.status} className="claim-holder-group">
                <h3 id={`claim-holders-${group.status}`}>
                  <span className={statusBadgeClass(taskStatusTones[group.status])}>{taskStatusLabels[group.status]}</span> {group.tasks.length}件
                </h3>
                <ul className="outcome-list" aria-labelledby={`claim-holders-${group.status}`}>
                  {group.tasks.map((task) => (
                    <li key={task.id}>
                      <Link to={taskPath(task.projectId, task.id)}>
                        <span className="claim-holder-agent">{describePrincipal(task.activeClaim.principalId)}</span> {task.title}
                        <small>
                          {taskStatusLabels[task.status]} ・ 期限 {formatClaimExpiry(task.activeClaim.expiresAt, now)}（{formatTime(task.activeClaim.expiresAt)}）
                        </small>
                      </Link>
                    </li>
                  ))}
                </ul>
              </div>
            ))
          ) : (
            <p className="unset">Claimを保持しているTaskはありません</p>
          )}
          {holders.reclaimableCount > 0 && (
            <p className="claim-holder-reclaimable">
              <span className={statusBadgeClass("warning")}>再取得待ち</span> {holders.reclaimableCount}件 — Claimの期限が切れ、Workerの再取得待ちです（担当中ではありません）
            </p>
          )}
        </>
      )}
    </section>
  );
};
