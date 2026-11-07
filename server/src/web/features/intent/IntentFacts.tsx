import type { ReactNode } from "react";
import { intentFieldLabels, type Intent, type IntentFormField } from "./intent";

const Fact = ({ intent, field }: { intent: Intent; field: Exclude<IntentFormField, "title"> }) => (
  <div className="intent-fact"><dt>{intentFieldLabels[field]}</dt><dd>{intent[field] ?? <span className="unset">未設定</span>}</dd></div>
);

/**
 * 目標の全項目。要約せず全文を出し、未設定は「未設定」と示す（空欄や架空の値で埋めない）。
 * 背景・対象・制約は広い画面では横に並べ、狭い画面では縦に並べる。
 */
export const IntentFacts = ({ intent }: { intent: Intent }) => (
  <dl className="intent-facts">
    <Fact intent={intent} field="desiredState" />
    <div className="intent-context-facts">
      <Fact intent={intent} field="background" />
      <Fact intent={intent} field="audience" />
      <Fact intent={intent} field="constraints" />
    </div>
    <Fact intent={intent} field="completionDefinition" />
    <Fact intent={intent} field="targetDate" />
  </dl>
);

/** Activeな目標が無いときの案内と作成導線の並び。 */
export const IntentEmpty = ({ children }: { children: ReactNode }) => <div className="intent-empty">{children}</div>;
