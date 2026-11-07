import { request } from "../../api";
import { workspaceMembersPath, type Member } from "./members";

/**
 * Human operatorの表示名（Human ID → 表示名）。Projectは所属WorkspaceのMemberから引く（ADR 0003。Project単位のMemberは無い）。
 * 取得できない場合はrejectし、呼出し側はIDの先頭で表示する。
 */
export const loadMemberNames = async (scope: { kind: "project"; projectId: string } | { kind: "workspace"; workspaceId: string }): Promise<Map<string, string>> => {
  const workspaceId = scope.kind === "workspace"
    ? scope.workspaceId
    : (await request<{ project: { workspaceId: string } }>(`/api/projects/${scope.projectId}`)).project.workspaceId;
  const { members } = await request<{ members: Member[] }>(workspaceMembersPath(workspaceId));
  return new Map(members.map((member) => [member.human.id, member.human.displayName]));
};
