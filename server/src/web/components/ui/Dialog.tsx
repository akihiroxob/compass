import { useEffect, useId, useRef, type ReactNode } from "react";
import { IconButton } from "./IconButton";

export type DialogProps = {
  /** 開閉は利用側が持つ。閉じる操作（×・Escape・背景）は`onClose`を呼ぶだけで、`open`をfalseにすると閉じる。 */
  open: boolean;
  onClose: () => void;
  /** 読み上げ名。`header`が無ければ見出しとしても表示する。 */
  title: string;
  /** ×と同じ行に置く内容（Workspace選択等）。指定すると見出しを表示せず、`title`は読み上げ名だけに使う。 */
  header?: ReactNode;
  /** `end`は画面の右端に全高で開く（狭い画面のメニュー）。 */
  placement?: "center" | "end";
  /** 開く操作の`aria-controls`から参照するid。 */
  id?: string;
  children: ReactNode;
};

/**
 * モーダル（nativeの`<dialog>`の`showModal`）。閉じる操作は右上の×（44px・読み上げ名「閉じる」）で、Escape・背景のclickでも閉じる。
 * 開いている間は背景を操作できず、閉じた後は開いた操作へfocusを戻す。文字の「閉じる」ボタンは置かない。
 */
export const Dialog = ({ open, onClose, title, header, placement = "center", id, children }: DialogProps) => {
  const dialog = useRef<HTMLDialogElement>(null);
  const opener = useRef<Element | null>(null);
  const titleId = useId();
  useEffect(() => {
    const element = dialog.current;
    if (!element) return;
    if (open && !element.open) {
      opener.current = document.activeElement;
      element.showModal();
    } else if (!open && element.open) element.close();
  }, [open]);
  // ×・Escape・背景・利用側のどれで閉じても、開いた操作が残っていればそこへfocusを戻す。
  const restoreFocus = () => {
    const target = opener.current;
    opener.current = null;
    if (target instanceof HTMLElement && target.isConnected) target.focus();
  };
  return (
    <dialog
      ref={dialog}
      id={id}
      className={placement === "end" ? "dialog end" : "dialog"}
      aria-labelledby={header === undefined ? titleId : undefined}
      aria-label={header === undefined ? undefined : title}
      // Escapeはnativeで閉じず、利用側の状態を通して閉じる（開閉の正本を1つにする）。
      onCancel={(event) => { event.preventDefault(); onClose(); }}
      onClose={restoreFocus}
      // 背景（dialog要素自身）のclickで閉じる。内側のclickは子要素がtargetになる。
      onClick={(event) => { if (event.target === event.currentTarget) onClose(); }}
    >
      <div className="dialog-frame">
        <div className="dialog-header">
          {header ?? <h2 id={titleId}>{title}</h2>}
          <IconButton icon="close" label="閉じる" onClick={onClose} />
        </div>
        {children}
      </div>
    </dialog>
  );
};
