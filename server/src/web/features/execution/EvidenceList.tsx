import { formatTime, type OutcomeExecutionRecord } from "./execution";

/** ProjectのExecutionからOutcomeへ還流したEvidence参照。Outcome詳細・Workspaceの方向・Task詳細で共有する。 */
export const EvidenceList = ({ record }: { record: OutcomeExecutionRecord }) =>
  record.evidence.length ? (
    <ul className="grant-list">
      {record.evidence.map((item) => (
        <li key={item.id}>
          <a href={item.uri} target="_blank" rel="noreferrer" className="evidence-uri">{item.uri}</a>
          <small>
            {item.kind}
            {item.versionHash && <> ・ <code>{item.versionHash.slice(0, 12)}</code></>} ・ 観測 {formatTime(item.observedAt)} ・ Change #{item.sourceChangeCursor}
          </small>
        </li>
      ))}
    </ul>
  ) : (
    <p className="unset">Evidence参照はまだ還流されていません（Evidence不足）</p>
  );
