import type { Intent } from "../../intentForm";

export const IntentFacts = ({ intent }: { intent: Intent }) => <dl className="intent-facts"><dt>実現したい状態</dt><dd>{intent.desiredState}</dd><dt>完了の定義</dt><dd>{intent.completionDefinition ?? <span className="unset">未設定</span>}</dd></dl>;
