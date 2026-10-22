import assert from "node:assert/strict";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { checkUiDependencies, checkUiSources, checkUiStyles, readWebPaths, readWebSources, type UiProtectedScope, type UiSource } from "./support/uiStructure.ts";

/** `npm run check:ui`の入口。検査自体をfixtureで確かめ、そのうえで実際のWeb UIを検査する。 */

const scopes: UiProtectedScope[] = [{ path: "features/sample/SampleList.tsx", components: ["SampleToolbar"] }];
const feature = (body: string): UiSource => ({
  path: "features/sample/SampleList.tsx",
  text: `import { Link } from "react-router-dom";\nimport { LinkButton, ViewSwitch } from "../../components/ui";\n${body}\nexport const Other = () => <Link to="/" className="button">対象外</Link>;\n`,
});
const primitive = (imports: string): UiSource => ({ path: "components/ui/LinkButton.tsx", text: `${imports}\nexport const LinkButton = () => null;\n` });
const allowedPrimitive = primitive(`import { Link } from "react-router-dom";\nimport { controlSizeClass } from "./ViewSwitch";`);

const allowedToolbar = `export const SampleToolbar = () => (
  <div className="list-toolbar">
    <ViewSwitch label="表示" size="sm" items={[]} />
    {true && <LinkButton to="/new" size="sm">追加</LinkButton>}
  </div>
);`;

test("check:ui accepts shared primitives with one size in a protected toolbar and ignores unprotected components", () => {
  assert.deepEqual(checkUiSources([allowedPrimitive, feature(allowedToolbar)], scopes), []);
});

test("check:ui rejects hand-made controls in a protected scope", () => {
  const errors = checkUiSources([allowedPrimitive, feature(`export const SampleToolbar = () => (
  <>
    <nav className="list-switch"><Link to="/a" aria-current="page">A</Link></nav>
    <Link to="/new" className="button compact">追加</Link>
    <button type="button">再読込</button>
  </>
);`)], scopes);
  assert.equal(errors.length, 3, errors.join("\n"));
  assert.match(errors[0], /SampleList\.tsx:5: <nav>に基本部品のclass（list-switch）/);
  assert.match(errors[1], /<Link>に基本部品のclass（button, compact）/);
  assert.match(errors[2], /<button>を直接使わず/);
});

test("check:ui rejects a toolbar whose controls break the size contract", () => {
  const mixed = checkUiSources([allowedPrimitive, feature(allowedToolbar.replace('size="sm">追加', 'size="md">追加'))], scopes);
  assert.equal(mixed.length, 1);
  assert.match(mixed[0], /sizeが一致しない（sm: ViewSwitch \/ md: LinkButton）/);

  const missing = checkUiSources([allowedPrimitive, feature(allowedToolbar.replace(' size="sm" items', " items"))], scopes);
  assert.deepEqual(missing.map((error) => /<ViewSwitch>にsizeを文字列で指定する/.test(error)), [true]);

  const rawLink = checkUiSources([allowedPrimitive, feature(allowedToolbar.replace("{true && <LinkButton", '<Link to="/x">x</Link>{true && <LinkButton'))], scopes);
  assert.deepEqual(rawLink.map((error) => /<Link>を直接置かず/.test(error)), [true]);

  const outer = checkUiSources([allowedPrimitive, feature(allowedToolbar.replace('<LinkButton to="/new"', '<LinkButton to="/new" className="push" style={{ marginTop: 8 }}'))], scopes);
  assert.equal(outer.length, 2, outer.join("\n"));
  assert.match(outer[0], /<LinkButton>へclassNameを渡さない/);
  assert.match(outer[1], /<LinkButton>へstyleを渡さない/);
});

test("check:ui rejects primitives that depend on features and protected scopes that disappeared", () => {
  const errors = checkUiSources([primitive(`import { useSession } from "../../features/auth";`), feature("export const Renamed = () => null;")], scopes);
  assert.deepEqual(errors, [
    'components/ui/LinkButton.tsx:1: 基本部品は機能・画面・他の層に依存しない（import "../../features/auth"）',
    "features/sample/SampleList.tsx: 保護対象のcomponent SampleToolbar が見つからない",
  ]);
});

const tokens: UiSource = { path: "styles/_tokens.scss", text: ":root {\n" + ["md", "sm"].flatMap((size) => ["height", "padding-x", "font-size"].map((part) => `  --control-${size}-${part}: 1rem;`)).join("\n") + "\n}\n" };
const mixins = (body: string): UiSource => ({ path: "styles/_mixins.scss", text: `// size\n@mixin control-size($size) {\n${body}\n}\n` });
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
const components = (text: string): UiSource => ({ path: "styles/_components.scss", text });

test("check:ui accepts token-based control sizes and parent-owned spacing", () => {
  assert.deepEqual(checkUiStyles([tokens, allowedMixin, components(`.view-switch { display: flex; gap: .4rem; }
.view-switch-item { @include control-size(md); &.compact { @include control-size(sm); } }
.view-switch-count { margin-left: .25rem; }
.list-toolbar { display: flex; gap: .75rem; margin: 0 0 2rem; + .section-note { margin-top: -1rem; } }`)]), []);
});

test("check:ui rejects literal control sizes, control margins and the removed list-switch", () => {
  assert.deepEqual(checkUiStyles([tokens, replaceInMixin("min-height: var(--control-#{$size}-height)", "min-height: 3rem"), components("")]), ["styles/_mixins.scss: control-sizeのmin-heightは--control-*トークンを使う（3rem）"]);
  assert.deepEqual(checkUiStyles([tokens, allowedMixin, components(`.view-switch { margin: 0 0 2rem; }
.list-toolbar { .button { min-height: 2.6rem; } }
.list-switch { display: flex; }`)]), [
    "styles/_components.scss: .view-switch に外側余白（margin）を持たせず、親layoutのgap・余白を使う",
    "styles/_components.scss: .list-toolbar .button のmin-heightはcontrol-sizeのトークンで指定する（2.6rem）",
    "styles/_components.scss: 廃止した.list-switchを使わず、ViewSwitchを使う（.list-switch）",
  ]);
});

test("check:ui inspects every declaration of the control-size mixin after SCSS interpolation", () => {
  const check = (from: string, to: string) => checkUiStyles([tokens, replaceInMixin(from, to), components("")]);
  assert.deepEqual(check("padding: 0 var(--control-#{$size}-padding-x)", "padding: 0 99px"), ["styles/_mixins.scss: control-sizeのpaddingは--control-*トークンを使う（0 99px）"]);
  assert.deepEqual(check("padding: 0 var(--control-#{$size}-padding-x)", "padding: 2px var(--control-#{$size}-padding-x)"), ["styles/_mixins.scss: control-sizeのpaddingは--control-*トークンを使う（2px var(--control-$size-padding-x)）"]);
  assert.deepEqual(check("border-width: var(--control-border-width)", "border-width: 1px"), ["styles/_mixins.scss: control-sizeのborder-widthは--control-*トークンを使う（1px）"]);
  assert.deepEqual(check("font-size: var(--control-#{$size}-font-size)", "font-size: 99px"), ["styles/_mixins.scss: control-sizeのfont-sizeは--control-*トークンを使う（99px）"]);
  assert.deepEqual(check("line-height: var(--control-line-height)", "line-height: 1.2"), ["styles/_mixins.scss: control-sizeのline-heightは--control-*トークンを使う（1.2）"]);
  assert.deepEqual(check("  font-size: var(--control-#{$size}-font-size);\n", ""), ["styles/_mixins.scss: control-sizeがfont-sizeを定めていない"]);
});

/** 依存方向の検査のfixture。appがFeatureを合成し、FeatureはShell等の共通層と他Featureの公開入口だけを使う。 */
const source = (path: string, text: string): UiSource => ({ path, text });
const allowedWeb: UiSource[] = [
  source("app/main.tsx", `import { App } from "./App";\nimport "../styles/main.scss";\nexport const root = App;`),
  source("app/App.tsx", `import { Shell } from "../components/Shell";\nimport { SamplePage } from "../features/sample";\nimport { OtherPage } from "../features/other/index.ts";\nexport const App = () => <Shell session={null}><SamplePage /><OtherPage /></Shell>;`),
  source("components/Shell.tsx", `import type { ReactNode } from "react";\nimport { Link } from "react-router-dom";\nimport { formatName } from "../format";\nexport const Shell = ({ session, children }: { session: ReactNode; children: ReactNode }) => <><Link to="/">{formatName("Compass")}</Link>{session}{children}</>;`),
  source("format.ts", `export const formatName = (name: string) => name.trim();`),
  source("features/sample/index.ts", `export { SamplePage } from "./SamplePage";`),
  source("features/sample/SamplePage.tsx", `import { formatName } from "../../format";\nimport { OtherPage } from "../other";\nimport type { OtherValue } from "../other/index";\nexport const SamplePage = () => { const value: OtherValue = formatName("x"); return <OtherPage key={value} />; };`),
  source("features/other/index.ts", `export { OtherPage, type OtherValue } from "./OtherPage";`),
  source("features/other/OtherPage.tsx", `export type OtherValue = string;\nexport const OtherPage = () => null;`),
];
const withSource = (path: string, text: string) => [...allowedWeb.filter((candidate) => candidate.path !== path), source(path, text)];
const dependencyErrors = (sources: UiSource[], options: Parameters<typeof checkUiDependencies>[1] = {}) => checkUiDependencies(sources, { knownCrossFeatureImports: [], ...options });

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

test("check:ui rejects private cross-feature imports unless listed exactly, and stale known entries", () => {
  const privateImport = withSource("features/sample/SamplePage.tsx", `import { OtherPage } from "../other/OtherPage";\nexport const SamplePage = () => <OtherPage />;`);
  assert.deepEqual(dependencyErrors(privateImport), [
    "features/sample/SamplePage.tsx:1: 他Featureの内部fileへ依存しない（features/other/OtherPage.tsx）。features/other/index.tsの公開入口を使う",
  ]);
  const edge = "features/sample/SamplePage.tsx -> features/other/OtherPage.tsx";
  assert.deepEqual(dependencyErrors(privateImport, { knownCrossFeatureImports: [edge] }), []);
  assert.deepEqual(dependencyErrors(allowedWeb, { knownCrossFeatureImports: [edge] }), [`既知の依存 ${edge} は見つからない。解消したら一覧から削除する`]);
});

test("check:ui fails when a layer is missing from the scan", () => {
  assert.deepEqual(dependencyErrors([]), ["app", "feature", "common"].map((kind) => `走査対象に${kind}のsourceがない（検査の対象rootを確認する）`));
  assert.deepEqual(dependencyErrors(allowedWeb.filter((candidate) => !candidate.path.startsWith("app/"))), ["走査対象にappのsourceがない（検査の対象rootを確認する）"]);
});

test("check:ui: the Web UI satisfies the dependency, shared primitive and protected toolbar rules", () => {
  const webRoot = fileURLToPath(new URL("../src/web", import.meta.url));
  const sources = readWebSources(webRoot);
  assert.ok(sources.filter((candidate) => candidate.path.startsWith("app/")).length >= 3, "appのsourceを走査していない");
  assert.ok(sources.filter((candidate) => candidate.path.startsWith("features/")).length >= 50, "Featureのsourceを走査していない");
  assert.deepEqual(checkUiDependencies(sources, { paths: readWebPaths(webRoot) }), []);
  assert.deepEqual(checkUiSources(sources.filter((candidate) => !candidate.path.endsWith(".scss"))), []);
  assert.deepEqual(checkUiStyles(sources.filter((candidate) => candidate.path.endsWith(".scss"))), []);
});
