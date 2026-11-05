import { fieldId } from "../../api";
import { fieldProps } from "../../components/FormErrorSummary";
import { Button, Field, Fieldset, Select, TextArea, TextInput } from "../../components/ui";
import { evidenceKey, type EvidenceOptionGroup } from "./evidenceOptions";
import {
  emptyProblem,
  maxOutcomeProblems,
  maxProblemEvidence,
  problemEvidenceKindLabels,
  problemEvidenceStatuses,
  problemEvidenceStatusLabels,
  problemNeedsEvidence,
  type ProblemEvidenceStatus,
  type ProblemFormValues,
} from "./outcome";

type ProblemFieldsProps = {
  problems: ProblemFormValues[];
  onChange: (problems: ProblemFormValues[]) => void;
  invalid: ReadonlySet<string>;
  /** 根拠の候補。読込中はnull。 */
  options: { groups: EvidenceOptionGroup[] | null; error: string | null };
};

/**
 * 課題（Problem Statement）ごとの根拠・解決策の入力。観測した事実と原因の仮説を別の欄に分け、原因を確定する欄は置かない。
 * 根拠は同じWorkspaceのResearchの発見・最新の結論から選ぶ。開発上の障害（Taskの停止等）はここに書かない。
 */
export const ProblemFields = ({ problems, onChange, invalid, options }: ProblemFieldsProps) => {
  const update = (index: number, changes: Partial<ProblemFormValues>) => onChange(problems.map((item, i) => (i === index ? { ...item, ...changes } : item)));
  return (
    <>
      {problems.length === 0 && <p className="unset">課題はまだありません。Outcomeの変化を妨げている利用者・事業側の課題があれば追加します。</p>}
      {problems.map((problem, index) => {
        const path = `problems.${index}`;
        const needsEvidence = problemNeedsEvidence(problem.evidenceStatus);
        const selected = new Set(problem.evidence.map(evidenceKey));
        return (
          <Fieldset key={problem.id ?? `new-${index}`} legend={`課題 ${index + 1}`} {...fieldProps(invalid, fieldId(path))}>
            <div className="problem-row">
              <Field label="課題" required description="Outcomeの変化を妨げている利用者・事業側の課題（500文字まで）">
                <TextInput {...fieldProps(invalid, fieldId(`${path}.statement`))} required maxLength={500} value={problem.statement} placeholder="例：無料体験の登録手順で離脱し、有料利用の検討に進めていない。" onChange={(event) => update(index, { statement: event.target.value })} />
              </Field>
              <Field label="根拠の状態" required description="観測済み・反証ありは、観測した事実と根拠が必要です。">
                <Select {...fieldProps(invalid, fieldId(`${path}.evidenceStatus`))} required value={problem.evidenceStatus} onChange={(event) => update(index, { evidenceStatus: event.target.value as ProblemEvidenceStatus })}>
                  {problemEvidenceStatuses.map((status) => <option key={status} value={status}>{problemEvidenceStatusLabels[status]}</option>)}
                </Select>
              </Field>
              <Field label="観測した事実" required={needsEvidence} description="観測できた事実だけを書きます。原因の解釈は「原因の仮説」へ分けます。">
                <TextArea {...fieldProps(invalid, fieldId(`${path}.observation`))} required={needsEvidence} maxLength={2000} rows={3} value={problem.observation} placeholder="例：登録手順の3画面目で途中離脱が続いている。" onChange={(event) => update(index, { observation: event.target.value })} />
              </Field>
              <Field label="原因の仮説" description="未確認の仮説として扱います。観測だけでは原因を確定しません。">
                <TextArea {...fieldProps(invalid, fieldId(`${path}.causeHypothesis`))} maxLength={2000} rows={3} value={problem.causeHypothesis} placeholder="例：入力項目が多く、体験の価値を感じる前に負担が大きい。" onChange={(event) => update(index, { causeHypothesis: event.target.value })} />
              </Field>
              <Field label="解決策の仮説" description="何をするとこの課題が改善すると考えるか">
                <TextArea {...fieldProps(invalid, fieldId(`${path}.solutionHypothesis`))} maxLength={2000} rows={3} value={problem.solutionHypothesis} placeholder="例：体験開始に必要な入力を名前とメールだけにする。" onChange={(event) => update(index, { solutionHypothesis: event.target.value })} />
              </Field>
              <Fieldset legend="根拠" required={needsEvidence ? "1つ以上必須" : false} {...fieldProps(invalid, fieldId(`${path}.evidence`))}>
                {problem.evidence.length === 0 ? <p className="unset">根拠はまだ関連付けていません。</p> : (
                  <ul className="problem-evidence-list">
                    {problem.evidence.map((evidence, position) => (
                      <li key={evidenceKey(evidence)} id={fieldId(`${path}.evidence.${position}.id`)}>
                        <span className="problem-evidence-kind">{problemEvidenceKindLabels[evidence.kind]}{evidence.superseded && "（新しい版あり）"}</span>
                        <span className="problem-evidence-summary">{evidence.summary}</span>
                        <Button variant="text" aria-label={`課題 ${index + 1}の根拠 ${position + 1}を外す`} onClick={() => update(index, { evidence: problem.evidence.filter((_, i) => i !== position) })}>外す</Button>
                      </li>
                    ))}
                  </ul>
                )}
                {options.error ? <p role="alert" className="error-title">根拠の候補を読み込めません: {options.error}</p> : options.groups === null ? <p className="unset">根拠の候補を読み込んでいます...</p> : options.groups.length === 0 ? <p className="unset">このWorkspaceに関連付けられるResearchの発見・結論はまだありません。</p> : (
                  <Field label={`課題 ${index + 1}に根拠を追加`} labelHidden>
                    <Select
                      value=""
                      disabled={problem.evidence.length >= maxProblemEvidence}
                      onChange={(event) => {
                        const option = options.groups!.flatMap((group) => group.options).find((item) => evidenceKey(item) === event.target.value);
                        if (option) update(index, { evidence: [...problem.evidence, option] });
                      }}
                    >
                      <option value="">根拠を追加...</option>
                      {options.groups.map((group) => (
                        <optgroup key={group.requestId} label={group.question}>
                          {group.options.filter((option) => !selected.has(evidenceKey(option))).map((option) => <option key={evidenceKey(option)} value={evidenceKey(option)}>{problemEvidenceKindLabels[option.kind]}: {option.summary}</option>)}
                        </optgroup>
                      ))}
                    </Select>
                  </Field>
                )}
              </Fieldset>
              <Button variant="text" aria-label={`課題 ${index + 1}を削除`} onClick={() => onChange(problems.filter((_, i) => i !== index))}>この課題を削除</Button>
            </div>
          </Fieldset>
        );
      })}
      <Button variant="text" disabled={problems.length >= maxOutcomeProblems} onClick={() => onChange([...problems, emptyProblem])}>＋ 課題を追加</Button>
    </>
  );
};
