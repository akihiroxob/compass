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
  projectId: string;
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
/** Projectから発行する招待。受諾すると所属WorkspaceのMembershipになる。 */
export const invitationsPath = (projectId: string, invitationId?: string) =>
  `/api/projects/${projectId}/invitations${invitationId ? `/${invitationId}` : ""}`;

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
  pending: "受諾待ち",
  accepted: "受諾済み",
  revoked: "取消済み",
  expired: "期限切れ",
};

/**
 * このMemberのRole変更・除外で、Workspaceの有効なownerが0人になるか。UIでは導線を無効にするだけで、拒否はserverが行う
 * （`409 LAST_OWNER`）。
 */
export const isLastOwner = (members: readonly Member[], target: Member): boolean =>
  target.membership.role === "owner" && members.filter((member) => member.membership.role === "owner").length <= 1;
