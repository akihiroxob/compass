import { describeActionFailure, request } from "../../api";
import { ReasonPanel, useReasonAction } from "../../components/ReasonPanel";
import { grantRoleLabels, revokeGrantPath, revokeInit, type Grant } from "./grants";

type GrantRowProps = { projectId: string; grant: Grant; onRevoked: () => void; readOnly?: boolean };

const revokeConsequence: Record<Grant["role"], string> = {
  strategist: "Outcomeを作成できません",
  researcher: "Research Result・Synthesisを登録できません",
};

/** 発行済みのRole Grant 1件。取消は誤操作防止の確認パネルを挟む（API・CLIには確認工程がない）。 */
export const GrantRow = ({ projectId, grant, onRevoked, readOnly = false }: GrantRowProps) => {
  const label = grantRoleLabels[grant.role];
  const revoke = useReasonAction(async () => {
    await request<{ revoked: boolean }>(revokeGrantPath(projectId, grant), revokeInit);
    onRevoked();
  }, (classified) => describeActionFailure(classified, "Projectが見つかりません。"));
  return (
    <li>
      <div>
        <strong>{grant.principalId}</strong>
        <small>{new Date(grant.createdAt).toLocaleString("ja-JP")} 発行</small>
      </div>
      {!readOnly && (
        <button type="button" className="secondary-button danger" aria-expanded={revoke.confirming} onClick={revoke.open}>
          割当を取り消す
        </button>
      )}
      {!readOnly && revoke.confirming && (
        <ReasonPanel
          action={revoke}
          title={`${grant.principalId} の${label}割当を取り消しますか？`}
          description={`取り消すと、このAgentは次のMCP呼び出しから${revokeConsequence[grant.role]}。作成済みの内容は変更されません。再度割り当てて元に戻せます。`}
          confirmLabel="取り消す"
          pendingLabel="取消中..."
        />
      )}
    </li>
  );
};
