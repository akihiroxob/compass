import assert from "node:assert/strict";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { checkUiSources, checkUiStyles, readWebSources, type UiProtectedScope, type UiSource } from "./support/uiStructure.ts";

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
const allowedMixin = mixins("  min-height: var(--control-#{$size}-height);\n  padding: 0 var(--control-#{$size}-padding-x);\n  font-size: var(--control-#{$size}-font-size);");
const components = (text: string): UiSource => ({ path: "styles/_components.scss", text });

test("check:ui accepts token-based control sizes and parent-owned spacing", () => {
  assert.deepEqual(checkUiStyles([tokens, allowedMixin, components(`.view-switch { display: flex; gap: .4rem; }
.view-switch-item { @include control-size(md); &.compact { @include control-size(sm); } }
.view-switch-count { margin-left: .25rem; }
.list-toolbar { display: flex; gap: .75rem; margin: 0 0 2rem; + .section-note { margin-top: -1rem; } }`)]), []);
});

test("check:ui rejects literal control sizes, control margins and the removed list-switch", () => {
  assert.deepEqual(checkUiStyles([tokens, mixins("  min-height: 3rem;"), components("")]), ["styles/_mixins.scss: control-sizeのmin-heightは--control-*トークンを使う（3rem）"]);
  assert.deepEqual(checkUiStyles([tokens, allowedMixin, components(`.view-switch { margin: 0 0 2rem; }
.list-toolbar { .button { min-height: 2.6rem; } }
.list-switch { display: flex; }`)]), [
    "styles/_components.scss: .view-switch に外側余白（margin）を持たせず、親layoutのgap・余白を使う",
    "styles/_components.scss: .list-toolbar .button のmin-heightはcontrol-sizeのトークンで指定する（2.6rem）",
    "styles/_components.scss: 廃止した.list-switchを使わず、ViewSwitchを使う（.list-switch）",
  ]);
});

test("check:ui: the Web UI satisfies the shared primitive and protected toolbar rules", () => {
  const sources = readWebSources(fileURLToPath(new URL("../src/web", import.meta.url)));
  assert.deepEqual(checkUiSources(sources.filter((source) => !source.path.endsWith(".scss"))), []);
  assert.deepEqual(checkUiStyles(sources.filter((source) => source.path.endsWith(".scss"))), []);
});
