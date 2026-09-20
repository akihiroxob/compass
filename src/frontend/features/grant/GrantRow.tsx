import { describeActionFailure, request } from "../../api";
import { ReasonPanel, useReasonAction } from "../../components/ReasonPanel";
import { revokeGrantPath, revokeInit, type Grant } from "./grants";

type GrantRowProps = { projectId: string; grant: Grant; onRevoked: () => void };

/** 発行済みのStrategist 1件。取消は誤操作防止の確認パネルを挟む（API・CLIには確認工程がない）。 */
export const GrantRow = ({ projectId, grant, onRevoked }: GrantRowProps) => {
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
      <button type="button" className="secondary-button danger" aria-expanded={revoke.confirming} onClick={revoke.open}>
        割当を取り消す
      </button>
      {revoke.confirming && (
        <ReasonPanel
          action={revoke}
          title={`${grant.principalId} のStrategist割当を取り消しますか？`}
          description="取り消すと、このAgentは次のMCP呼び出しからOutcomeを作成できません。作成済みのOutcomeは変更されません。再度割り当てて元に戻せます。"
          confirmLabel="取り消す"
          pendingLabel="取消中..."
        />
      )}
    </li>
  );
};
