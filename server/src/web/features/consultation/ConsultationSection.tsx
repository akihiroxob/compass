import { useEffect, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { classifyError, loadFailureMessage, request } from "../../api";
import { ErrorState, Loading, StateCard } from "../../components/StateCard";
import { Button, ViewSwitch } from "../../components/ui";
import { ConsultationList } from "./ConsultationList";
import {
  consultationDetailPath,
  consultationFilterLabels,
  consultationFilters,
  consultationFilterSearch,
  consultationScopeLabels,
  consultationsApiPath,
  inboxPath,
  parseConsultationFilter,
  type Consultation,
  type ConsultationFilter,
  type ConsultationScope,
} from "./consultation";

const emptyMessages: Record<ConsultationFilter, string> = {
  waiting_human: "Humanの判断を待っている相談はありません。",
  waiting_agent: "Agentの応答を待っている相談はありません。",
  resolved: "解決済みの相談はありません。",
  canceled: "取り消した相談はありません。",
  all: "相談はまだありません。Agentが既存の要件・方針で決められない設計・要件の問題を相談として登録すると、ここに表示されます。",
};

/** scopeが判断対象を所有する相談の説明。Projectは要件・設計、WorkspaceはDirection（Intent・Outcome・優先順位）。 */
const scopeNotes: Record<ConsultationScope["kind"], string> = {
  project: "Agentが既存の要件・方針では決められないProjectの設計・要件の問題を相談として登録します。",
  workspace: "AgentがMission・Principles・既存のIntentからは決められないWorkspaceの方向（Outcomeの優先順位など）を相談として登録します。所属Projectの相談はProjectごとの「判断待ち」にあります。",
};

/**
 * Project・Workspaceの「判断待ち」。AgentがMCPで登録したscopeの相談を状態で絞り込み（既定はHumanの判断待ち）、詳細で質問・会話・結論を読む。
 * 一覧は再読込で最新にする（Agentの応答は非同期）。返信・決定は詳細画面で行う。閲覧できる全scopeの横断一覧は`/consultations`。
 */
export const ConsultationSection = ({ scope }: { scope: ConsultationScope }) => {
  const [searchParams] = useSearchParams();
  const filter = parseConsultationFilter(searchParams.get("status"));
  const scopeId = scope.kind === "project" ? scope.projectId : scope.workspaceId;
  const key = `${scope.kind}/${scopeId}/${filter}`;
  type ListState = { key: string; consultations: Consultation[] | null; error: string | null };
  const [state, setState] = useState<ListState | null>(null);
  const [reloading, setReloading] = useState(false);
  const fetchList = (): Promise<ListState> =>
    request<{ consultations: Consultation[] }>(consultationsApiPath(scope, filter)).then(
      ({ consultations }) => ({ key, consultations, error: null }),
      (reason: unknown) => {
        const label = consultationScopeLabels[scope.kind];
        return { key, consultations: null, error: loadFailureMessage(classifyError(reason), `${label}が見つからないか、この${label}を閲覧する権限がありません。`) };
      },
    );
  useEffect(() => {
    let current = true;
    void fetchList().then((next) => { if (current) setState(next); });
    return () => { current = false; };
  }, [key]);
  const reload = async () => {
    setReloading(true);
    setState(await fetchList());
    setReloading(false);
  };
  const settled = state?.key === key ? state : null;
  return (
    <section className="detail-section" aria-labelledby="consultations-heading">
      <h2 id="consultations-heading">判断待ち</h2>
      <p className="section-note">{scopeNotes[scope.kind]}質問・選択肢・推奨・影響を読み、返信または決定してください。通常の作業の許可はここに来ません。</p>
      <div className="list-toolbar">
        <ViewSwitch
          label="相談の絞り込み"
          size="sm"
          items={consultationFilters.map((item) => ({ key: item, to: { search: consultationFilterSearch(searchParams, item) }, label: consultationFilterLabels[item], current: item === filter }))}
        />
        <Button variant="secondary" size="sm" pending={reloading} onClick={() => void reload()}>{reloading ? "読み込み中..." : "最新の状態を読み込む"}</Button>
      </div>
      {!settled ? (
        <Loading />
      ) : settled.error ? (
        <ErrorState message={settled.error} />
      ) : settled.consultations?.length ? (
        <ConsultationList consultations={settled.consultations} pathOf={(consultation) => consultationDetailPath(scope, consultation.id)} />
      ) : (
        <StateCard role="status">{emptyMessages[filter]}</StateCard>
      )}
      <p className="section-note"><Link to={inboxPath({ status: filter, scope: scope.kind, projectId: scope.kind === "project" ? scope.projectId : null, workspaceId: scope.kind === "workspace" ? scope.workspaceId : null })} className="text-link">閲覧できるすべてのProject・Workspaceの判断待ち →</Link></p>
    </section>
  );
};
