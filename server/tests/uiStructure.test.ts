import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  checkCompiledCss,
  checkUiClassUsage,
  checkUiDependencies,
  checkUiSources,
  checkUiStyleEntry,
  checkUiStyles,
  readWebPaths,
  readWebSources,
  uiButtonExceptions,
  type UiButtonException,
  type UiSource,
} from "./support/uiStructure.ts";

/** `npm run check:ui`の入口。検査自体をfixtureで確かめ、そのうえで実際のWeb UIを検査する。 */

const source = (path: string, text: string): UiSource => ({ path, text });
const feature = (body: string): UiSource => source(
  "features/sample/SampleList.tsx",
  `import { Link } from "react-router-dom";\nimport { Button, LinkButton, ViewSwitch } from "../../components/ui";\n${body}\n`,
);
const primitive = (imports: string): UiSource => source("components/ui/LinkButton.tsx", `${imports}\nexport const LinkButton = () => null;\n`);
const allowedPrimitive = primitive(`import { Link } from "react-router-dom";\nimport { controlSizeClass } from "./ViewSwitch";`);

const allowedToolbar = `export const SampleToolbar = () => (
  <div className="list-toolbar">
    <ViewSwitch label="表示" size="sm" items={[]} />
    {true && <LinkButton to="/new" size="sm">追加</LinkButton>}
  </div>
);`;

test("check:ui accepts shared primitives with one size in a toolbar anywhere in the web", () => {
  assert.deepEqual(checkUiSources([allowedPrimitive, feature(allowedToolbar)], []), []);
});

test("check:ui rejects native buttons in every component, not only selected scopes", () => {
  const errors = checkUiSources([allowedPrimitive, feature(`${allowedToolbar}\nexport const Other = () => <button type="button" onClick={() => {}}>再読込</button>;`)], []);
  assert.deepEqual(errors, ["features/sample/SampleList.tsx:9: <button>を直接使わず、components/uiのButtonを使う"]);
});

test("check:ui rejects a toolbar whose controls break the size contract", () => {
  const mixed = checkUiSources([allowedPrimitive, feature(allowedToolbar.replace('size="sm">追加', 'size="md">追加'))], []);
  assert.equal(mixed.length, 1);
  assert.match(mixed[0], /sizeが一致しない（sm: ViewSwitch \/ md: LinkButton）/);

  const missing = checkUiSources([allowedPrimitive, feature(allowedToolbar.replace(' size="sm" items', " items"))], []);
  assert.deepEqual(missing.map((error) => /<ViewSwitch>にsizeを文字列で指定する/.test(error)), [true]);

  const rawLink = checkUiSources([allowedPrimitive, feature(allowedToolbar.replace("{true && <LinkButton", '<Link to="/x">x</Link>{true && <LinkButton'))], []);
  assert.deepEqual(rawLink.map((error) => /<Link>を直接置かず/.test(error)), [true]);

  const outer = checkUiSources([allowedPrimitive, feature(allowedToolbar.replace('<LinkButton to="/new"', '<LinkButton to="/new" className="push" style={{ marginTop: 8 }}'))], []);
  assert.equal(outer.length, 2, outer.join("\n"));
  assert.match(outer[0], /<LinkButton>へclassNameを渡さない/);
  assert.match(outer[1], /<LinkButton>へstyleを渡さない/);
});

test("check:ui rejects primitives that depend on features", () => {
  assert.deepEqual(checkUiSources([primitive(`import { useSession } from "../../features/auth";`), feature(allowedToolbar)], []), [
    'components/ui/LinkButton.tsx:1: 基本部品は機能・画面・他の層に依存しない（import "../../features/auth"）',
  ]);
});

test("check:ui allows only the listed button exceptions and fails when an exception no longer matches", () => {
  const exception: UiButtonException = { path: "features/sample/SampleList.tsx", className: "sample-switch", reason: "fixture" };
  const opener = `export const Opener = () => <button type="button" className="sample-switch">開く</button>;`;
  assert.deepEqual(checkUiSources([allowedPrimitive, feature(`${allowedToolbar}\n${opener}`)], [exception]), []);
  // classが変わった・別のfileの`<button>`は例外に当たらず、使われない例外は無効な除外として失敗する。
  assert.deepEqual(checkUiSources([allowedPrimitive, feature(`${allowedToolbar}\n${opener.replace("sample-switch", "other-switch")}`)], [exception]), [
    "features/sample/SampleList.tsx:9: <button>を直接使わず、components/uiのButtonを使う",
    'features/sample/SampleList.tsx: <button className="sample-switch">の例外の対象が見つからない（例外を削除する）',
  ]);
  assert.ok(uiButtonExceptions.every((candidate) => candidate.reason.length > 0), "例外には理由を書く");
});

/** 入力の基本部品を使うフォームのfixture。 */
const formFeature = (body: string, other = "export const Other = () => null;"): UiSource => source(
  "features/sample/SampleForm.tsx",
  `import { Link } from "react-router-dom";\nimport { Button, Field, Fieldset, LinkButton, Select, TextArea, TextInput } from "../../components/ui";\n${body}\n${other}\n`,
);
const inputPrimitive = source("components/ui/FormControls.tsx", `export const TextInput = () => <input className="input" />;\nexport const Select = () => <select className="select" />;\n`);
const allowedForm = `export const SampleForm = () => (
  <form>
    <input type="hidden" name="returnTo" value="/" />
    <Field label="名前" required><TextInput id="field-name" required maxLength={100} /></Field>
    <Field label="説明"><TextArea rows={3} /></Field>
    <Field label="種別" layout="inline"><Select size="sm"><option value="a">A</option></Select></Field>
    <div className="form-actions"><LinkButton to="/" variant="secondary">キャンセル</LinkButton><Button type="submit" pending={false}>保存</Button></div>
  </form>
);`;

test("check:ui accepts forms built from the input primitives and a hidden input", () => {
  assert.deepEqual(checkUiSources([inputPrimitive, formFeature(allowedForm)], []), []);
});

test("check:ui rejects native inputs outside components/ui", () => {
  const errors = checkUiSources([inputPrimitive, formFeature(allowedForm, `export const Other = () => (
  <>
    <input type="text" />
    <textarea />
    <select><option>x</option></select>
    <input type={"hidden"} name="ok" />
  </>
);`)], []);
  assert.deepEqual(errors, [
    "features/sample/SampleForm.tsx:14: <input>を直接使わず、components/uiの入力部品（TextInput・TextArea・Select・Checkbox）を使う",
    "features/sample/SampleForm.tsx:15: <textarea>を直接使わず、components/uiの入力部品（TextInput・TextArea・Select・Checkbox）を使う",
    "features/sample/SampleForm.tsx:16: <select>を直接使わず、components/uiの入力部品（TextInput・TextArea・Select・Checkbox）を使う",
  ]);
});

test("check:ui rejects className and style on primitives", () => {
  const outside = checkUiSources([inputPrimitive, formFeature(allowedForm, `export const Other = () => <><TextInput className="wide" style={{ height: 40 }} /><Fieldset legend="x" className="y">{null}</Fieldset></>;`)], []);
  assert.deepEqual(outside, [
    "features/sample/SampleForm.tsx:12: <TextInput>へclassNameを渡さない（外側余白・配置は親layoutが持つ）",
    "features/sample/SampleForm.tsx:12: <TextInput>へstyleを渡さない（外側余白・配置は親layoutが持つ）",
    "features/sample/SampleForm.tsx:12: <Fieldset>へclassNameを渡さない（外側余白・配置は親layoutが持つ）",
  ]);
});

const tokens = source("styles/_tokens.scss", ":root {\n" + ["md", "sm"].flatMap((size) => ["height", "padding-x", "font-size"].map((part) => `  --control-${size}-${part}: 1rem;`)).join("\n") + "\n}\n");
const mixins = (body: string): UiSource => source("styles/_mixins.scss", `// size\n@mixin control-size($size) {\n${body}\n}\n`);
/** 実際の`_mixins.scss`と同じく、補間`#{$size}`を含む宣言を並べる。 */
const allowedMixin = mixins(`  min-height: var(--control-#{$size}-height);
  padding: 0 var(--control-#{$size}-padding-x);
  border-width: var(--control-border-width);
  font-size: var(--control-#{$size}-font-size);
  line-height: var(--control-line-height);`);
const replaceInMixin = (from: string, to: string): UiSource => {
  assert.ok(allowedMixin.text.includes(from), from);
  return { ...allowedMixin, text: allowedMixin.text.replace(from, to) };
};
const styles = (...partials: [string, string][]) => [tokens, allowedMixin, ...partials.map(([path, text]) => source(path, text))];
const button = (text: string): [string, string] => ["components/ui/_button.scss", text];
const viewSwitch = (text: string): [string, string] => ["components/ui/_view-switch.scss", text];
const field = (text: string): [string, string] => ["components/ui/_field.scss", text];
const layout = (text: string): [string, string] => ["styles/_layout.scss", text];

test("check:ui accepts token-based control sizes and parent-owned spacing", () => {
  assert.deepEqual(checkUiStyles(styles(
    viewSwitch(`.view-switch { display: flex; gap: .4rem; }
.view-switch-item { @include control-size(md); &.compact { @include control-size(sm); } }
.view-switch-count { margin-left: .25rem; }`),
    layout(`.list-toolbar { display: flex; gap: .75rem; margin: 0 0 2rem; + .section-note { margin-top: -1rem; } }`),
  )), []);
});

test("check:ui rejects literal control sizes, control margins and the removed list-switch", () => {
  assert.deepEqual(checkUiStyles([tokens, replaceInMixin("min-height: var(--control-#{$size}-height)", "min-height: 3rem")]), ["styles/_mixins.scss: control-sizeのmin-heightは--control-*トークンを使う（3rem）"]);
  assert.deepEqual(checkUiStyles(styles(
    button(".button { color: #fff; @include control-size(md); }"),
    viewSwitch(".view-switch { margin: 0 0 2rem; }"),
    layout(".list-toolbar { .button { min-height: 2.6rem; } }\n.list-switch { display: flex; }"),
  )), [
    "components/ui/_view-switch.scss: .view-switch に外側余白（margin）を持たせず、親layoutのgap・余白を使う",
    "styles/_layout.scss: .list-toolbar .button のmin-heightはcontrol-sizeのトークンで指定する（2.6rem）",
    "styles/_layout.scss: .list-toolbar .button はcomponents/ui/_button.scssの.buttonを外側から上書きしない（min-height）。配置以外は部品のpartialで指定する",
    "styles/_layout.scss: 廃止した.list-switchを使わず、ViewSwitchを使う（.list-switch）",
  ]);
});

test("check:ui inspects every declaration of the control-size mixin after SCSS interpolation", () => {
  const check = (from: string, to: string) => checkUiStyles([tokens, replaceInMixin(from, to)]);
  assert.deepEqual(check("padding: 0 var(--control-#{$size}-padding-x)", "padding: 0 99px"), ["styles/_mixins.scss: control-sizeのpaddingは--control-*トークンを使う（0 99px）"]);
  assert.deepEqual(check("padding: 0 var(--control-#{$size}-padding-x)", "padding: 2px var(--control-#{$size}-padding-x)"), ["styles/_mixins.scss: control-sizeのpaddingは--control-*トークンを使う（2px var(--control-$size-padding-x)）"]);
  assert.deepEqual(check("border-width: var(--control-border-width)", "border-width: 1px"), ["styles/_mixins.scss: control-sizeのborder-widthは--control-*トークンを使う（1px）"]);
  assert.deepEqual(check("font-size: var(--control-#{$size}-font-size)", "font-size: 99px"), ["styles/_mixins.scss: control-sizeのfont-sizeは--control-*トークンを使う（99px）"]);
  assert.deepEqual(check("line-height: var(--control-line-height)", "line-height: 1.2"), ["styles/_mixins.scss: control-sizeのline-heightは--control-*トークンを使う（1.2）"]);
  assert.deepEqual(check("  font-size: var(--control-#{$size}-font-size);\n", ""), ["styles/_mixins.scss: control-sizeがfont-sizeを定めていない"]);
});

test("check:ui keeps input sizes on tokens and spacing on the parent layout", () => {
  assert.deepEqual(checkUiStyles(styles(
    field(`.field { display: grid; gap: var(--field-gap); }
.input, .select { @include control-size(md); &.compact { @include control-size(sm); } }
.textarea { padding: var(--field-padding-y) var(--control-md-padding-x); font-size: var(--control-md-font-size); line-height: var(--field-line-height); }`),
    button(".text-button { min-height: var(--control-sm-height); padding: 0; }"),
    layout(`.form-section { display: grid; gap: var(--space-md); }
.invitation-link .input { font-family: monospace; }
.member-role-form { .select { width: auto; } }`),
  )), []);
  assert.deepEqual(checkUiStyles(styles(
    field(".field { margin-top: 1.25rem; }\n.textarea { padding: .85rem 1rem; }\n.input { width: 100%; }"),
    button(".text-button { padding: 0; }\n.secondary-button { border-style: solid; }"),
    ["features/sample/_sample.scss", `.invitation-link { .input { font-size: var(--control-sm-font-size); } }
.repeat-row .text-button { margin-bottom: .5rem; }
.grant-list { .secondary-button { min-height: 2.4rem; } }`],
  )), [
    "components/ui/_field.scss: .field に外側余白（margin-top）を持たせず、親layoutのgap・余白を使う",
    "components/ui/_field.scss: .textarea のpaddingは--control-*・--field-*トークンで指定する（.85rem 1rem）",
    "features/sample/_sample.scss: .invitation-link .input はcomponents/ui/_field.scssの.inputを外側から上書きしない（font-size）。配置以外は部品のpartialで指定する",
    "features/sample/_sample.scss: .repeat-row .text-button に外側余白（margin-bottom）を持たせず、親layoutのgap・余白を使う",
    "features/sample/_sample.scss: .repeat-row .text-button はcomponents/ui/_button.scssの.text-buttonを外側から上書きしない（margin-bottom）。配置以外は部品のpartialで指定する",
    "features/sample/_sample.scss: .grant-list .secondary-button のmin-heightは--control-*・--field-*トークンで指定する（2.4rem）",
    "features/sample/_sample.scss: .grant-list .secondary-button はcomponents/ui/_button.scssの.secondary-buttonを外側から上書きしない（min-height）。配置以外は部品のpartialで指定する",
  ]);
});

test("check:ui keeps each class in one partial and limits outside overrides of components to placement", () => {
  assert.deepEqual(checkUiStyles(styles(
    button(".button { color: #fff; }"),
    ["components/_state-card.scss", ".state-card { margin-top: 3rem; padding: 2rem; }"],
    layout(".section-note { color: gray; }\n.page-heading { display: flex; }"),
    ["features/sample/_sample.scss", `.sample-row { display: flex; .button { flex: 1 1 auto; } .state-card { margin: 0; } .section-note { margin: 0; color: red; } }`],
  )), []);
  assert.deepEqual(checkUiStyles(styles(
    button(".button { color: #fff; }"),
    ["components/_state-card.scss", ".state-card { padding: 2rem; }"],
    layout(".page-heading { display: flex; .button { display: flex; width: 100%; } }\n.button.wide { color: red; }"),
    ["features/sample/_sample.scss", ".sample-row .state-card { padding: 0; }\nmain { padding: 0; }\n.page-heading { gap: 0; }"],
  )), [
    ".button の定義が複数のpartialにある（components/ui/_button.scss, styles/_layout.scss）。所有するpartialの1つへまとめる",
    ".page-heading の定義が複数のpartialにある（features/sample/_sample.scss, styles/_layout.scss）。所有するpartialの1つへまとめる",
    "features/sample/_sample.scss: 最上位のselector main はclassから始める（要素・全体のselectorはstyles/_base.scssに置く）",
    "features/sample/_sample.scss: .sample-row .state-card はcomponents/_state-card.scssの.state-cardを外側から上書きしない（padding）。配置以外は部品のpartialで指定する",
  ]);
  // reset・要素の既定値はstyles/_base.scssに置ける。
  assert.deepEqual(checkUiStyles(styles(["styles/_base.scss", "main { width: 100%; &.narrow { width: 50%; } }\nfieldset { border: 0; }"])), []);
});

test("check:ui ties every class to the sources of its owner", () => {
  const scss = [
    source("components/ui/_button.scss", ".button { color: #fff; }"),
    source("components/_state-card.scss", ".state-card { padding: 1rem; }"),
    source("styles/_layout.scss", ".section-note { color: gray; }\n.only-sample { color: red; }\n.unused-note { color: blue; }"),
    source("features/sample/_sample.scss", ".sample-row { display: flex; }"),
    source("app/_app.scss", ".app-link { color: red; }"),
  ];
  const ui = source("components/ui/Button.tsx", `const variants = { primary: "button" };\nexport const Button = () => <button className={variants.primary} />;`);
  const card = source("components/StateCard.tsx", `export const StateCard = () => <div className="state-card" />;`);
  const page = (path: string, body: string) => source(path, `export const Page = () => (${body});`);
  const allowed = [
    ...scss.filter((candidate) => !candidate.path.startsWith("styles/")),
    source("styles/_layout.scss", ".section-note { color: gray; }"),
    ui,
    card,
    page("features/sample/SamplePage.tsx", `<div className="sample-row"><p className="section-note" title="unused-note button">x</p></div>`),
    // slot（attributeに渡したJSX）の中のclassNameも利用として数える。
    page("app/AppLayout.tsx", `<Shell footer={<a className="app-link section-note">x</a>} />`),
  ];
  assert.deepEqual(checkUiClassUsage(allowed), []);
  assert.deepEqual(checkUiClassUsage([
    ...scss,
    ui,
    card,
    page("features/sample/SamplePage.tsx", `<div className="sample-row only-sample"><a className="button">x</a><div className="state-card" /><p className="section-note" /></div>`),
    page("features/other/OtherPage.tsx", `<div className={\`sample-row \${"x"}\`} />`),
    page("app/AppLayout.tsx", `<p className="section-note app-link" />`),
  ]), [
    "features/sample/SamplePage.tsx: components/uiのclass .button（components/ui/_button.scss）を直接使わない。その部品を使う",
    "styles/_layout.scss: .only-sample はfeatures/sampleだけが使うため、その所有partialへ移す",
    "features/other/OtherPage.tsx: features/sampleのclass .sample-row（features/sample/_sample.scss）を直接使わない。共有するならstyles/_layout.scssへ移す",
    "features/sample/SamplePage.tsx: componentsのclass .state-card（components/_state-card.scss）を直接使わない。その部品を使う",
    "styles/_layout.scss: .unused-note はどのsourceからも使われていない（未使用のstyleを削除する）",
  ]);
  assert.deepEqual(checkUiClassUsage([]), ["走査対象にSCSS・TSXがない（検査の対象rootを確認する）"]);
});

test("check:ui rejects the same declaration in separate rules of the compiled CSS", () => {
  assert.deepEqual(checkCompiledCss(`.a { color: red; }\n.a:hover { color: blue; }\n@media (max-width: 1px) { .a { color: green; } }\n.b { color: red; color: blue; }`), []);
  assert.deepEqual(checkCompiledCss(`:root { --x: 1; }\n.a, .b { gap: 1rem; }\n.b { gap: 2rem; }\n:root { --x: 1; }`), [
    "出力CSSで:rootの--xを複数のruleで宣言している。1つのruleにまとめる",
    "出力CSSで.bのgapを複数のruleで宣言している。1つのruleにまとめる",
  ]);
});

test("check:ui compiles the Sass entry and fails on partials that the entry does not load", () => {
  const root = mkdtempSync(join(tmpdir(), "compass-ui-"));
  try {
    const write = (path: string, text: string) => { mkdirSync(dirname(join(root, path)), { recursive: true }); writeFileSync(join(root, path), text); };
    write("app/main.scss", `@use "../styles/tokens";\n@use "../features/sample/sample";\n`);
    write("styles/_tokens.scss", ":root { --x: 1; }\n");
    write("features/sample/_sample.scss", ".sample { color: red; }\n");
    assert.deepEqual(checkUiStyleEntry(root), []);
    write("features/other/_other.scss", ".other { color: red; }\n");
    write("features/sample/_twice.scss", ".sample { color: blue; }\n");
    write("app/main.scss", `@use "../styles/tokens";\n@use "../features/sample/sample";\n@use "../features/sample/twice";\n`);
    assert.deepEqual(checkUiStyleEntry(root), [
      "features/other/_other.scss: Sassの入口（app/main.scss）から読まれていない",
      "出力CSSで.sampleのcolorを複数のruleで宣言している。1つのruleにまとめる",
    ]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

/** 依存方向の検査のfixture。appがFeatureを合成し、FeatureはShell等の共通層と他Featureの公開入口だけを使う。 */
const allowedWeb: UiSource[] = [
  source("app/main.tsx", `import { App } from "./App";\nimport "./main.scss";\nexport const root = App;`),
  source("app/App.tsx", `import { Shell } from "../components/Shell";\nimport { SamplePage } from "../features/sample";\nimport { OtherPage } from "../features/other/index.ts";\nexport const App = () => <Shell session={null}><SamplePage /><OtherPage /></Shell>;`),
  source("components/Shell.tsx", `import type { ReactNode } from "react";\nimport { Link } from "react-router-dom";\nimport { formatName } from "../format";\nexport const Shell = ({ session, children }: { session: ReactNode; children: ReactNode }) => <><Link to="/">{formatName("Compass")}</Link>{session}{children}</>;`),
  source("format.ts", `export const formatName = (name: string) => name.trim();`),
  source("features/sample/index.ts", `export { SamplePage } from "./SamplePage";`),
  source("features/sample/SamplePage.tsx", `import { formatName } from "../../format";\nimport { OtherPage } from "../other";\nimport type { OtherValue } from "../other/index";\nexport const SamplePage = () => { const value: OtherValue = formatName("x"); return <OtherPage key={value} />; };`),
  source("features/other/index.ts", `export { OtherPage, type OtherValue } from "./OtherPage";`),
  source("features/other/OtherPage.tsx", `export type OtherValue = string;\nexport const OtherPage = () => null;`),
];
const withSource = (path: string, text: string) => [...allowedWeb.filter((candidate) => candidate.path !== path), source(path, text)];
const dependencyErrors = (sources: UiSource[], options: Parameters<typeof checkUiDependencies>[1] = {}) => checkUiDependencies(sources, options);

test("check:ui accepts app composition, shared layers and feature public entries", () => {
  assert.deepEqual(dependencyErrors(allowedWeb), []);
});

test("check:ui rejects shared layers that depend on features or app", () => {
  assert.deepEqual(dependencyErrors(withSource("components/Shell.tsx", `import { OtherPage } from "../features/other";\nimport { App } from "../app/App";\nexport const Shell = () => <><OtherPage /><App /></>;`)), [
    "components/Shell.tsx:1: 共通層からFeatureへ依存しない（features/other/index.ts）",
    "components/Shell.tsx:2: 共通層からappへ依存しない（app/App.tsx）",
  ]);
  // web直下の共通処理からFeature内部の型を読む（import type）も違反。
  assert.deepEqual(dependencyErrors(withSource("format.ts", `import type { OtherValue } from "./features/other/OtherPage";\nexport const formatName = (name: OtherValue) => name;`)), [
    "format.ts:1: 共通層からFeatureへ依存しない（features/other/OtherPage.tsx）",
  ]);
});

test("check:ui rejects features that depend on app, including re-exports and dynamic imports", () => {
  assert.deepEqual(dependencyErrors(withSource("features/sample/index.ts", `export { SamplePage } from "./SamplePage";\nexport * from "../../app/App";`)), [
    "features/sample/index.ts:2: Featureからappへ依存しない（app/App.tsx）。画面の合成はappのroute layoutで行う",
  ]);
  assert.deepEqual(dependencyErrors(withSource("features/other/OtherPage.tsx", `export type OtherValue = import("../../app/App.tsx").Missing;\nexport const OtherPage = () => { void import("../../app/App"); const name = "../../app/App"; void import(name); return null; };`)), [
    "features/other/OtherPage.tsx:1: Featureからappへ依存しない（app/App.tsx）。画面の合成はappのroute layoutで行う",
    "features/other/OtherPage.tsx:2: Featureからappへ依存しない（app/App.tsx）。画面の合成はappのroute layoutで行う",
    "features/other/OtherPage.tsx:2: 文字列でないimport()・require()は依存を検査できないため使わない",
  ]);
});

test("check:ui resolves aliases and shared re-exports instead of trusting the specifier", () => {
  const paths = { "@app/*": ["app/*"], "@shared/*": ["./*"] };
  assert.deepEqual(dependencyErrors(withSource("features/sample/SamplePage.tsx", `import { App } from "@app/App";\nimport { formatName } from "@shared/format";\nexport const SamplePage = () => <App key={formatName("x")} />;`), { paths }), [
    "features/sample/SamplePage.tsx:1: Featureからappへ依存しない（app/App.tsx）。画面の合成はappのroute layoutで行う",
  ]);
  // 共通層の再exportを経由してFeature内部・appへ迂回すると、再exportした共通層のfileが違反になる。
  assert.deepEqual(dependencyErrors([...withSource("format.ts", `export const formatName = (name: string) => name;\nexport { OtherPage } from "./features/other/OtherPage";\nexport * from "@app/App";`)], { paths }), [
    "format.ts:2: 共通層からFeatureへ依存しない（features/other/OtherPage.tsx）",
    "format.ts:3: 共通層からappへ依存しない（app/App.tsx）",
  ]);
  assert.deepEqual(dependencyErrors(withSource("features/sample/index.ts", `export { SamplePage } from "./SamplePage";\nexport { Missing } from "@app/Missing";\nexport { Gone } from "../gone";`), { paths }), [
    'features/sample/index.ts:2: web内で解決できないlocal import "@app/Missing"',
    'features/sample/index.ts:3: web内で解決できないlocal import "../gone"',
  ]);
});

test("check:ui rejects private cross-feature imports, including aliases and re-exports", () => {
  const message = "他Featureの内部fileへ依存しない（features/other/OtherPage.tsx）。features/other/index.ts（純関数のmoduleからはmodel.ts）の公開入口を使う";
  assert.deepEqual(dependencyErrors(withSource("features/sample/SamplePage.tsx", `import { OtherPage } from "../other/OtherPage";\nexport const SamplePage = () => <OtherPage />;`)), [
    `features/sample/SamplePage.tsx:1: ${message}`,
  ]);
  assert.deepEqual(dependencyErrors(withSource("features/sample/SamplePage.tsx", `import { OtherPage } from "@features/other/OtherPage";\nexport const SamplePage = () => <OtherPage />;`), { paths: { "@features/*": ["features/*"] } }), [
    `features/sample/SamplePage.tsx:1: ${message}`,
  ]);
  // 自Featureの公開入口で他Featureの内部を再exportすると、再exportした行が違反になる。
  assert.deepEqual(dependencyErrors(withSource("features/sample/index.ts", `export { SamplePage } from "./SamplePage";\nexport type { OtherValue } from "../other/OtherPage";`)), [
    `features/sample/index.ts:2: ${message}`,
  ]);
});

/** 純粋な公開入口`model.ts`を持つFeature。他Featureの純関数のmoduleとテストはここを読む。 */
const modelWeb = [
  ...allowedWeb,
  source("features/other/model.ts", `export { otherLabel } from "./other";`),
  source("features/other/other.ts", `export const otherLabel = (value: string) => value.toUpperCase();`),
];

test("check:ui accepts a pure model entry and rejects one that reaches components", () => {
  assert.deepEqual(dependencyErrors([...modelWeb.filter((candidate) => candidate.path !== "features/sample/SamplePage.tsx"),
    source("features/sample/SamplePage.tsx", `import { otherLabel } from "../other/model";\nexport const SamplePage = () => <p>{otherLabel("x")}</p>;`)]), []);
  const impure = [...modelWeb.filter((candidate) => candidate.path !== "features/other/other.ts"),
    source("features/other/other.ts", `import { OtherPage } from "./OtherPage";\nexport const otherLabel = (value: string) => value;\nexport const page = OtherPage;`)];
  assert.deepEqual(dependencyErrors(impure), ["features/other/model.ts: model.tsは純粋な公開入口のため、.tsxへ推移的に依存しない（features/other/OtherPage.tsx）"]);
});

test("check:ui rejects importing the own feature through its public entry", () => {
  assert.deepEqual(dependencyErrors(withSource("features/other/OtherPage.tsx", `import type { OtherValue as Value } from "./index";\nexport type OtherValue = string;\nexport const OtherPage = (_: { value?: Value }) => null;`)), [
    "features/other/OtherPage.tsx:1: Feature内から自身の公開入口（features/other/index.ts）を経由しない。内部fileを直接参照する",
  ]);
});

test("check:ui detects feature cycles even through public entries", () => {
  // sample -> other（公開入口）に加え、other -> sample（公開入口）で循環する。
  const cycle = withSource("features/other/OtherPage.tsx", `import { SamplePage } from "../sample";\nexport type OtherValue = string;\nexport const OtherPage = () => <SamplePage />;`);
  assert.deepEqual(dependencyErrors(cycle), [
    "Featureの依存が循環する（other -> sample -> other）: features/other/OtherPage.tsx -> features/sample/index.ts, features/sample/SamplePage.tsx -> features/other/index.ts",
  ]);
  // 3つのFeatureを経由する循環も検出する。
  const third = [
    ...withSource("features/other/OtherPage.tsx", `import { thirdLabel } from "../third/model";\nexport type OtherValue = string;\nexport const OtherPage = () => <p>{thirdLabel}</p>;`),
    source("features/third/model.ts", `import type { SamplePage } from "../sample";\nexport const thirdLabel = "third";\nexport type Page = typeof SamplePage;`),
  ];
  const errors = dependencyErrors(third);
  assert.equal(errors.filter((error) => error.startsWith("Featureの依存が循環する（other -> third -> sample -> other）")).length, 1, errors.join("\n"));
});

test("check:ui fails when a layer is missing from the scan", () => {
  assert.deepEqual(dependencyErrors([]), ["app", "feature", "common"].map((kind) => `走査対象に${kind}のsourceがない（検査の対象rootを確認する）`));
  assert.deepEqual(dependencyErrors(allowedWeb.filter((candidate) => !candidate.path.startsWith("app/"))), ["走査対象にappのsourceがない（検査の対象rootを確認する）"]);
});

test("check:ui: the whole Web UI satisfies the dependency, primitive, style ownership and Sass entry rules", () => {
  const webRoot = fileURLToPath(new URL("../src/web", import.meta.url));
  const sources = readWebSources(webRoot);
  assert.ok(sources.filter((candidate) => candidate.path.startsWith("app/")).length >= 3, "appのsourceを走査していない");
  assert.ok(sources.filter((candidate) => candidate.path.startsWith("features/")).length >= 50, "Featureのsourceを走査していない");
  assert.ok(sources.filter((candidate) => candidate.path.endsWith(".scss")).length >= 15, "SCSSのpartialを走査していない");
  assert.deepEqual(checkUiDependencies(sources, { paths: readWebPaths(webRoot) }), []);
  assert.deepEqual(checkUiSources(sources), []);
  assert.deepEqual(checkUiStyles(sources), []);
  assert.deepEqual(checkUiClassUsage(sources), []);
  assert.deepEqual(checkUiStyleEntry(webRoot), []);
});


test("カタログは型importだけを許可し、基本部品・依存の検査を維持する", () => {
  const story = (body: string) => source("components/ui/Button.stories.tsx", body);
  assert.deepEqual(checkUiSources([story('import type { Meta } from "@storybook/react-vite"; import { Button } from "./index"; export const Example = () => <Button>保存</Button>;')], []), []);
  assert.ok(checkUiSources([story('import { anything } from "@storybook/react-vite";')], []).length > 0);
  assert.ok(checkUiSources([story('import type { Secret } from "../../features/auth";')], []).length > 0);
  assert.ok(checkUiSources([story('export const Bad = () => <button>保存</button>;')], []).length > 0);
  assert.ok(checkUiSources([story('export const Bad = () => <input />;')], []).length > 0);
  assert.ok(checkUiSources([story('export const Bad = () => <Button style={{color: "red"}}>保存</Button>;')], []).length > 0);
  const sources = [source("app/main.tsx", 'import "../components/ui/Button.stories";'), source("features/sample/index.ts", "export {};"), story("export const Example = {}; ")];
  assert.ok(checkUiDependencies(sources).some((error) => error.includes("製品sourceからカタログstory")));
  const dependencyBase = [source("app/main.tsx", "export {};"), source("features/sample/index.ts", "export {};")];
  for (const [path, statement] of [
    ["components/Leak.ts", 'import type { Meta } from "@storybook/react-vite";'],
    ["components/Leak.stories.tsx", 'import { something } from "@storybook/react-vite";'],
    ["components/Leak.stories.tsx", 'import type { Something } from "@storybook/other";'],
  ]) assert.ok(checkUiDependencies([...dependencyBase, source(path, statement)]).some((error) => error.includes("Storybookはstory")));
  assert.deepEqual(checkUiDependencies([...dependencyBase, source("components/Valid.stories.tsx", 'import type { Meta } from "@storybook/react-vite";')]), []);
});
