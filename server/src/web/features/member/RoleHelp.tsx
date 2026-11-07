import { useId, useState } from "react";
import { Button, Dialog } from "../../components/ui";
import { humanRoleDescriptions, humanRoleLabels, humanRoleOptions, roleHelpScope } from "./members";

/**
 * 「権限について」。Roleの説明は常設せず、必要なときだけ共通Dialogで開く。
 * ×・Escape・背景で閉じ、Dialogが開いた操作（このボタン）へfocusを戻す。
 */
export const RoleHelpButton = ({ workspaceName }: { workspaceName: string }) => {
  const [open, setOpen] = useState(false);
  const id = useId();
  return (
    <>
      <Button variant="text" aria-haspopup="dialog" aria-controls={id} onClick={() => setOpen(true)}>権限について</Button>
      <Dialog id={id} open={open} onClose={() => setOpen(false)} title="権限について">
        <p className="section-note">{workspaceName}</p>
        <dl className="role-help">
          {humanRoleOptions.map((role) => (
            <div key={role}>
              <dt>{humanRoleLabels[role]}</dt>
              <dd>{humanRoleDescriptions[role]}</dd>
            </div>
          ))}
        </dl>
        <p className="section-note">{roleHelpScope}</p>
      </Dialog>
    </>
  );
};
