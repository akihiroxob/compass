import { Link } from "react-router-dom";
import { statusBadgeClass } from "../../statusTone";
import { formatTime } from "../execution";
import { consultationStatusLabels, consultationStatusTones, describeActor, describeDue, isOpenConsultation, type Consultation } from "./consultation";

/**
 * 相談の一覧の行。行全体が相談詳細へのリンクで、状態・題名・質問・影響・期限・Agentの推奨・起票者・更新日時を出す。
 * 期限が未設定の相談は「期限未設定」と示し、期限なしや余裕ありとして扱わない。scope別の一覧と横断一覧で共有し、
 * 横断一覧では所属（Project・Workspaceの名前）を`scopeLabelOf`で添える。
 */
export const ConsultationList = ({ consultations, pathOf, scopeLabelOf }: {
  consultations: readonly Consultation[];
  pathOf: (consultation: Consultation) => string;
  scopeLabelOf?: (consultation: Consultation) => string;
}) => {
  const now = Date.now();
  return (
  <ul className="consultation-list">
    {consultations.map((consultation) => {
      const due = describeDue(consultation.dueAt, now, formatTime);
      return (
      <li key={consultation.id}>
        <Link to={pathOf(consultation)}>
          <span className={statusBadgeClass(consultationStatusTones[consultation.status])}>{consultationStatusLabels[consultation.status]}</span>{" "}
          {scopeLabelOf && <span className="consultation-scope">{scopeLabelOf(consultation)}</span>}{" "}
          <strong>{consultation.title}</strong>
          <small>{consultation.question}</small>
          <small className="consultation-triage"><span>影響: {consultation.impact}</span></small>
          <small className="consultation-triage">
            <span>Agentの推奨: {consultation.recommendation}</span>
            {isOpenConsultation(consultation.status) && <span className={due.overdue ? "consultation-due overdue" : due.known ? "consultation-due" : "consultation-due unknown"}>{due.label}</span>}
          </small>
          <small>{describeActor(consultation.createdBy)} ・ {formatTime(consultation.updatedAt)} 更新</small>
        </Link>
      </li>
      );
    })}
  </ul>
  );
};
