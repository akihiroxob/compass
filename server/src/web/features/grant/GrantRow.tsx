import { describeActionFailure, request } from "../../api";
import { Button } from "../../components/ui";
import { ReasonPanel, useReasonAction } from "../../components/ReasonPanel";
import { grantRoleLabels, revokeInit, revokeRecoveryNote, scopeNotFoundMessage, scopeRevokeGrantPath, type Grant, type GrantScope } from "./grants";

type GrantRowProps = { scope: GrantScope; grant: Grant; onRevoked: () => void; readOnly?: boolean };

const revokeConsequence: Record<Grant["role"], string> = {
  strategist: "Outcomeを作成できません",
  researcher: "Research Result・Synthesisを登録できません",
  manager: "Story・Taskの作成・編集と最終受入ができません",
  worker: "Taskを引き受けて実装できません",
  reviewer: "完了したTaskをレビューできません",
  evaluator: "OutcomeのEvaluationを保存できません",
  runtime: "Runtimeイベントの取得・ackとExecution Evidenceの還流ができません",
};

/** 発行済みのRole Grant 1件。取消は誤操作防止の確認パネルを挟む（API・CLIには確認工程がない）。 */
export const GrantRow = ({ scope, grant, onRevoked, readOnly = false }: GrantRowProps) => {
  const label = grantRoleLabels[grant.role];
  const revoke = useReasonAction(async () => {
    await request<{ revoked: boolean }>(scopeRevokeGrantPath(scope, grant), revokeInit);
    onRevoked();
  }, (classified) => describeActionFailure(classified, scopeNotFoundMessage(scope)));
  return (
    <li>
      <div>
        <strong>{grant.principalId}</strong>
        <small>{new Date(grant.createdAt).toLocaleString("ja-JP")} 発行</small>
      </div>
      {!readOnly && (
        <Button variant="secondary" size="sm" tone="danger" aria-expanded={revoke.confirming} onClick={revoke.open}>
          割当を取り消す
        </Button>
      )}
      {!readOnly && revoke.confirming && (
        <ReasonPanel
          action={revoke}
          title={`${grant.principalId} の${label}割当を取り消しますか？`}
          description={`取り消すと、このAgentは次のMCP呼び出しから${revokeConsequence[grant.role]}。作成済みの内容は変更されません。${revokeRecoveryNote(scope, grant.role)}`}
          confirmLabel="取り消す"
          pendingLabel="取消中..."
        />
      )}
    </li>
  );
};
