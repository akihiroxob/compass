import { useId, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { useWorkspaceNavigation } from "./WorkspaceContext";
import { currentSection, filterWorkspaces, switchWorkspacePath, workspaceCreatePath, workspacePath, workspaceSectionLabels, workspaceSections } from "./workspace";

/**
 * Workspace Selector。現在のWorkspaceを示すbuttonから、閲覧できるWorkspaceの一覧（modal dialog）を開く。
 * 一覧はWorkspace Membershipを持つactiveなWorkspaceだけで、選ぶと同じ項目のURLへ移る（Project配下からはProject一覧）。
 * 開くと絞り込み欄へfocusし、Escで閉じるとbuttonへfocusが戻る。
 */
export const WorkspaceSwitcher = () => {
  const navigation = useWorkspaceNavigation();
  const dialog = useRef<HTMLDialogElement>(null);
  const search = useRef<HTMLInputElement>(null);
  const [query, setQuery] = useState("");
  const titleId = useId();
  if (!navigation) return null;
  const { workspaces, error, reload, location, current, currentId, resolving } = navigation;
  const close = () => dialog.current?.close();
  const open = () => {
    setQuery("");
    if (error) reload();
    dialog.current?.showModal();
    // 一覧があれば絞り込み欄から操作を始める（無ければdialogの既定どおり最初の操作要素）。
    search.current?.focus();
  };
  const label = current ? current.name : resolving ? "読み込み中..." : currentId !== null ? "閲覧できません" : "Workspaceを選択";
  const shown = filterWorkspaces(workspaces ?? [], query);
  return (
    <>
      <button type="button" className="workspace-switch" aria-haspopup="dialog" onClick={open}>
        <small>Workspace</small>
        <strong>{label}</strong>
        {current?.status === "archived" && <span className="status-badge muted">アーカイブ済み</span>}
        <span className="visually-hidden">（切り替える）</span>
      </button>
      <dialog
        ref={dialog}
        className="workspace-dialog"
        aria-labelledby={titleId}
        // 背景（dialog要素自身）のclickで閉じる。内側のclickは子要素がtargetになる。
        onClick={(event) => { if (event.target === event.currentTarget) close(); }}
      >
        <div className="workspace-dialog-body">
          <div className="workspace-dialog-title">
            <div><p className="eyebrow">戦略の単位を切り替える</p><h2 id={titleId}>Workspace</h2></div>
            <button type="button" className="secondary-button compact" onClick={close}>閉じる</button>
          </div>
          {error ? (
            <div className="state-card error" role="alert">
              <p>Workspaceの一覧を読み込めませんでした: {error}</p>
              <button type="button" className="secondary-button compact" onClick={reload}>再試行</button>
            </div>
          ) : workspaces === null ? (
            <div className="state-card" role="status">読み込み中...</div>
          ) : workspaces.length === 0 ? (
            <div className="state-card">
              <p>参加しているWorkspaceはありません。Workspaceを作成するとあなたがownerになります。既存のWorkspaceは、そのownerにMembershipの追加を依頼してください。</p>
              <Link to={workspaceCreatePath} className="text-link" onClick={close}>Workspaceを作成 →</Link>
            </div>
          ) : (
            <>
              <label className="workspace-search">
                Workspaceを絞り込む
                <input ref={search} type="text" value={query} onChange={(event) => setQuery(event.target.value)} placeholder="名前・Mission" />
              </label>
              {shown.length === 0 ? (
                <p className="unset" role="status">「{query.trim()}」に一致するWorkspaceはありません。</p>
              ) : (
                <ul className="workspace-options" aria-label={`${shown.length}件のWorkspace`}>
                  {shown.map((workspace) => (
                    <li key={workspace.id}>
                      <Link to={switchWorkspacePath(location, workspace.id)} aria-current={workspace.id === currentId ? "true" : undefined} onClick={close}>
                        <strong>{workspace.name}</strong>
                        <small>{workspace.mission}</small>
                        {workspace.id === currentId && <span className="status-badge tone-progress">選択中</span>}
                      </Link>
                    </li>
                  ))}
                </ul>
              )}
            </>
          )}
          {workspaces !== null && workspaces.length > 0 && <Link to={workspaceCreatePath} className="text-link" onClick={close}>＋ Workspaceを作成</Link>}
          <p className="section-note">Membershipを持つWorkspaceだけを表示します。Workspaceをまたいで参加中のProjectは<Link to="/projects" onClick={close}>参加中のProject</Link>から開けます。</p>
        </div>
      </dialog>
    </>
  );
};

/**
 * Workspaceのナビゲーション（概要・方向・Project・記録・Agent）。現在のWorkspaceを閲覧できる場合だけ出す。
 * 各項目はURLを持つ画面へのリンクで、選択中に`aria-current="page"`。
 */
export const WorkspaceNav = () => {
  const navigation = useWorkspaceNavigation();
  if (!navigation?.current) return null;
  const { current, location } = navigation;
  const active = currentSection(location);
  return (
    <nav className="workspace-nav" aria-label={`Workspace ${current.name}`}>
      <ul>
        {workspaceSections.map((section) => (
          <li key={section}>
            <Link to={workspacePath(current.id, section)} aria-current={section === active ? "page" : undefined}>{workspaceSectionLabels[section]}</Link>
          </li>
        ))}
      </ul>
    </nav>
  );
};
