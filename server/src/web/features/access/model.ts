// accessの純粋な公開入口。操作可否の判定と型だけを置き、テスト・他Featureの純関数のmoduleから読む。
export {
  currentProjectOperationResult,
  projectOperationAccess,
  projectOperationDeniedMessage,
  registrationUnavailableNote,
  type KeyedProjectOperationResult,
  type OperationScope,
  type ProjectOperationAccess,
} from "./projectAccess.ts";
