// テストからも読み込むため、他moduleをimportしない（型だけを除く）純関数だけを置く。
import type { StatusTone } from "../../statusTone.ts";
/** HumanのWorkspace Role（ADR 0003）。Workspaceと配下のすべてのProjectへ同じRoleを適用する。順序はowner > administrator > editor > viewer。 */
export type HumanRole = "owner" | "administrator" | "editor" | "viewer";
export const humanRoleOptions: HumanRole[] = ["owner", "administrator", "editor", "viewer"];

export const humanRoleLabels: Record<HumanRole, string> = {
  owner: "Owner",
  administrator: "Administrator",
  editor: "Editor",
  viewer: "Viewer",
};

/** Roleの説明（権限表`humanWorkspacePermissions`・`humanProjectPermissions`）。Workspaceと配下のすべてのProjectに適用する。 */
export const humanRoleDescriptions: Record<HumanRole, string> = {
  owner: "Memberの管理・招待、アーカイブを含むすべての操作",
  administrator: "WorkspaceとProjectの編集・Projectの追加、相談の決定、Agent・Credentialの管理",
  editor: "Intent・Outcome・Story・Taskの作成・更新、Taskへの介入、相談への返信",
  viewer: "参照のみ",
};

export type Membership = { id: string; workspaceId: string; humanUserId: string; role: HumanRole; createdAt: number; updatedAt: number };
export type Member = { membership: Membership; human: { id: string; displayName: string; email: string } };
export type InvitationStatus = "pending" | "accepted" | "revoked";
export type Invitation = {
  id: string;
  workspaceId: string;
  email: string;
  role: HumanRole;
  status: InvitationStatus;
  expiresAt: number;
  createdAt: number;
  acceptedAt: number | null;
  revokedAt: number | null;
};
export type InvitationResponse = { invitation: Invitation; invitationUrl: string };

export const workspaceMembersPath = (workspaceId: string, membershipId?: string) =>
  `/api/workspaces/${workspaceId}/members${membershipId ? `/${membershipId}` : ""}`;
/** Workspaceから発行する招待。配下Projectに個別の参加は不要。 */
export const invitationsPath = (workspaceId: string, invitationId?: string) =>
  `/api/workspaces/${workspaceId}/invitations${invitationId ? `/${invitationId}` : ""}`;

const jsonRequest = (method: string, body: unknown): RequestInit => ({
  method,
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify(body),
});

export const changeRoleInit = (role: HumanRole): RequestInit => jsonRequest("PATCH", { role });
export const invitationInit = (email: string, role: HumanRole, expiresInHours: number): RequestInit =>
  jsonRequest("POST", { email, role, expiresInHours });
export const deleteInit: RequestInit = { method: "DELETE" };

/** 招待の有効期限の選択肢（serverの許容範囲1時間〜30日の内側）。既定は7日。 */
export const invitationExpiryOptions = [
  { hours: 1, label: "1時間" },
  { hours: 24, label: "24時間" },
  { hours: 72, label: "3日" },
  { hours: 168, label: "7日" },
  { hours: 336, label: "14日" },
  { hours: 720, label: "30日" },
] as const;
export const defaultInvitationExpiryHours = 168;

/** 表示上の状態。期限切れはserverが状態を書き換えないため、`pending`と期限から判定する。 */
export type InvitationDisplayStatus = InvitationStatus | "expired";
export const invitationDisplayStatus = (invitation: Pick<Invitation, "status" | "expiresAt">, now: number): InvitationDisplayStatus =>
  invitation.status === "pending" && now >= invitation.expiresAt ? "expired" : invitation.status;

export const invitationStatusTones: Record<InvitationDisplayStatus, StatusTone> = { pending: "waiting", accepted: "done", revoked: "muted", expired: "warning" };

export const invitationStatusLabels: Record<InvitationDisplayStatus, string> = {
  pending: "招待中（未参加）",
  accepted: "参加済み",
  revoked: "取消済み",
  expired: "期限切れ",
};

/**
 * このMemberのRole変更・除外で、Workspaceの有効なownerが0人になるか。UIでは導線を無効にするだけで、拒否はserverが行う
 * （`409 LAST_OWNER`）。
 */
export const isLastOwner = (members: readonly Member[], target: Member): boolean =>
  target.membership.role === "owner" && members.filter((member) => member.membership.role === "owner").length <= 1;

/** 一覧の1ページの件数。Memberが増えても1画面を長くしない。 */
export const memberPageSize = 20;

/** 名前またはメールアドレスの部分一致（大文字小文字を区別しない）。空の検索語は全件。 */
export const filterMembers = <T extends Member>(members: readonly T[], query: string): T[] => {
  const needle = query.trim().toLowerCase();
  if (!needle) return [...members];
  return members.filter(({ human }) => human.displayName.toLowerCase().includes(needle) || human.email.toLowerCase().includes(needle));
};

export type MemberPage<T> = { items: T[]; page: number; pageCount: number; total: number; from: number; to: number };

/** 範囲外のpageは最終ページ／先頭へ寄せる（検索語の変更・除外で件数が減っても空のページを出さない）。 */
export const paginateMembers = <T>(items: readonly T[], page: number, size = memberPageSize): MemberPage<T> => {
  const pageCount = Math.max(1, Math.ceil(items.length / size));
  const current = Math.min(Math.max(1, Math.trunc(page) || 1), pageCount);
  const start = (current - 1) * size;
  return { items: items.slice(start, start + size), page: current, pageCount, total: items.length, from: items.length ? start + 1 : 0, to: Math.min(start + size, items.length) };
};

/** 「権限について」の説明。Roleごとの権限は`humanRoleDescriptions`、適用範囲は全Roleで同じ。 */
export const roleHelpScope = "同じ権限がWorkspaceと配下のすべてのProjectに適用されます。Projectごとの権限設定はありません。";
