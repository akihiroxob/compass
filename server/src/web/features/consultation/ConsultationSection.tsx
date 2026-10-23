import { useEffect, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { classifyError, loadFailureMessage, request } from "../../api";
import { ErrorState, Loading, StateCard } from "../../components/StateCard";
import { Button, ViewSwitch } from "../../components/ui";
import { consultationPath } from "../../paths";
import { statusBadgeClass } from "../../statusTone";
import { formatTime } from "../execution";
import {
  consultationFilterLabels,
  consultationFilters,
  consultationFilterSearch,
  consultationsApiPath,
  consultationStatusLabels,
  consultationStatusTones,
  describeActor,
  parseConsultationFilter,
  type Consultation,
  type ConsultationFilter,
} from "./consultation";

const emptyMessages: Record<ConsultationFilter, string> = {
  waiting_human: "Humanの判断を待っている相談はありません。",
  waiting_agent: "Agentの応答を待っている相談はありません。",
  resolved: "解決済みの相談はありません。",
  canceled: "取り消した相談はありません。",
  all: "相談はまだありません。Agentが既存の要件・方針で決められない設計・要件の問題を相談として登録すると、ここに表示されます。",
};

/**
 * Projectの「判断待ち」。AgentがMCPで登録した相談を状態で絞り込み（既定はHumanの判断待ち）、詳細で質問・会話・結論を読む。
 * 一覧は再読込で最新にする（Agentの応答は非同期）。返信・決定は詳細画面で行う。
 */
export const ConsultationSection = ({ projectId }: { projectId: string }) => {
  const [searchParams] = useSearchParams();
  const filter = parseConsultationFilter(searchParams.get("status"));
  const key = `${projectId}/${filter}`;
  type ListState = { key: string; consultations: Consultation[] | null; error: string | null };
  const [state, setState] = useState<ListState | null>(null);
  const [reloading, setReloading] = useState(false);
  const fetchList = (): Promise<ListState> =>
    request<{ consultations: Consultation[] }>(consultationsApiPath(projectId, filter)).then(
      ({ consultations }) => ({ key, consultations, error: null }),
      (reason: unknown) => ({ key, consultations: null, error: loadFailureMessage(classifyError(reason), "Projectが見つからないか、このProjectを閲覧する権限がありません。") }),
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
      <p className="section-note">Agentが既存の要件・方針では決められない設計・要件の問題を相談として登録します。質問・選択肢・推奨・影響を読み、返信または決定してください。通常の作業の許可はここに来ません。</p>
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
        <ul className="consultation-list">
          {settled.consultations.map((consultation) => (
            <li key={consultation.id}>
              <Link to={consultationPath(projectId, consultation.id)}>
                <span className={statusBadgeClass(consultationStatusTones[consultation.status])}>{consultationStatusLabels[consultation.status]}</span>{" "}
                <strong>{consultation.title}</strong>
                <small>{consultation.question}</small>
                <small>{describeActor(consultation.createdBy)} ・ {formatTime(consultation.updatedAt)} 更新</small>
              </Link>
            </li>
          ))}
        </ul>
      ) : (
        <StateCard role="status">{emptyMessages[filter]}</StateCard>
      )}
    </section>
  );
};
