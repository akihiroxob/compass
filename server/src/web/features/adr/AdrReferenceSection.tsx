import { useEffect, useState } from "react";
import { classifyError, loadFailureMessage, request } from "../../api";
import type { AdrReference } from "../../adrReferenceForm";
import { ErrorState, Loading } from "../../components/StateCard";

const ReferenceRow = ({ reference }: { reference: AdrReference }) => (
  <li>
    <div>
      <strong>{reference.path}</strong>
      <small>
        commit {reference.commitSha.slice(0, 12)}
        {reference.pullRequestUrl && (
          <>
            {" ・ "}
            <a href={reference.pullRequestUrl} target="_blank" rel="noreferrer">
              Pull Request
            </a>
          </>
        )}
      </small>
    </div>
    <small>{new Date(reference.createdAt).toLocaleString("ja-JP")} 記録（Decision {reference.decisionId}）</small>
  </li>
);

/**
 * ProjectのADR参照一覧（Human向け読み取り専用）。実Wachaとは未接続で、Repository ADRの正本はRepository側にある。
 * ここではWachaが完了させた結果（path・commit SHA・PR URL）の参照だけを表示する。
 */
export const AdrReferenceSection = ({ projectId }: { projectId: string }) => {
  const [references, setReferences] = useState<AdrReference[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    request<{ references: AdrReference[] }>(`/api/projects/${projectId}/adr-references`)
      .then(({ references }) => setReferences(references))
      .catch((reason: unknown) => setError(loadFailureMessage(classifyError(reason), "Projectが見つかりません。")));
  }, [projectId]);
  return (
    <section className="detail-section" aria-labelledby="adr-heading">
      <h2 id="adr-heading">ADR参照</h2>
      <p className="section-note">
        Repository ADRの正本はRepository側です。ここではWachaが完了させた結果の参照だけを表示します。
      </p>
      {error ? (
        <ErrorState message={`ADR参照の読み込みに失敗しました: ${error}`} />
      ) : references === null ? (
        <Loading />
      ) : references.length ? (
        <ul className="grant-list">{references.map((reference) => <ReferenceRow key={reference.id} reference={reference} />)}</ul>
      ) : (
        <p className="unset">ADR参照は未登録です</p>
      )}
    </section>
  );
};
