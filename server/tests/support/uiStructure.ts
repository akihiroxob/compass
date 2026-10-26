import { readdirSync, readFileSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import * as sass from "sass";
import ts from "typescript";

/**
 * Web UIの構造検査（`npm run check:ui`）。web全体（`server/src/web`）を対象に、app・Feature・共通層の依存方向、
 * 共通の基本部品（`components/ui`）の利用、SCSSのclassの所有・上書き・Sassの入口と出力を検査する。
 * web全体を一律に検査する。native buttonの個別例外は`uiButtonExceptions`だけで、対象が無ければ失敗する。
 * storyのStorybook型importだけを許可し、製品からstoryへの依存は禁止する。
 */

/** Web UIのsource（`server/src/web`からの相対path、`/`区切り）。 */
export type UiSource = { path: string; text: string };

/** `<button>`を基本部品の外で使う個別の例外。対象のfileに指定したclassの`<button>`が無ければ失敗する（無効な除外を残さない）。 */
export type UiButtonException = { path: string; className: string; reason: string };

export const uiButtonExceptions: UiButtonException[] = [
  {
    path: "features/workspace/WorkspaceSwitcher.tsx",
    className: "workspace-switch",
    reason: "現在のWorkspaceの名前を示すカード型のdialogの開閉。操作ボタンのsize契約を持たず、Workspace固有の表示を含む",
  },
];

const primitiveRoot = "components/ui/";
const primitiveComponents = new Set(["Button", "LinkButton", "ViewSwitch", "Field", "Fieldset", "TextInput", "TextArea", "Select", "Checkbox"]);
/** 入力の基本部品だけが描画するnative要素。`components/ui`の外では使わない。 */
const nativeInputTags = new Set(["input", "textarea", "select"]);
const toolbarClass = "list-toolbar";
const isCatalogStory = (path: string) => path.endsWith(".stories.tsx");
const primitiveExternalImports = new Set(["react", "react-router-dom"]);

const attribute = (element: ts.JsxOpeningLikeElement, name: string) =>
  element.attributes.properties.find((property): property is ts.JsxAttribute => ts.isJsxAttribute(property) && property.name.getText() === name);

/** 文字列リテラルのattribute値。式・未指定はnull。 */
const literalAttribute = (element: ts.JsxOpeningLikeElement, name: string) => {
  const initializer = attribute(element, name)?.initializer;
  if (!initializer) return null;
  if (ts.isStringLiteral(initializer)) return initializer.text;
  if (ts.isJsxExpression(initializer) && initializer.expression && ts.isStringLiteralLike(initializer.expression)) return initializer.expression.text;
  return null;
};

/** classNameに含まれるclass名。テンプレート文字列等は字句から読める範囲を返す。 */
const classNames = (element: ts.JsxOpeningLikeElement, tree: ts.SourceFile) => {
  const initializer = attribute(element, "className")?.initializer;
  if (!initializer) return [];
  const text = ts.isStringLiteral(initializer) ? initializer.text : initializer.getText(tree);
  return text.split(/[^A-Za-z0-9_-]+/).filter(Boolean);
};

const openingElements = (node: ts.Node): ts.JsxOpeningLikeElement[] => {
  const found: ts.JsxOpeningLikeElement[] = [];
  const visit = (child: ts.Node) => {
    if (ts.isJsxOpeningElement(child) || ts.isJsxSelfClosingElement(child)) found.push(child);
    ts.forEachChild(child, visit);
  };
  visit(node);
  return found;
};

const location = (path: string, tree: ts.SourceFile, node: ts.Node) => `${path}:${tree.getLineAndCharacterOfPosition(node.getStart(tree)).line + 1}`;
const parseSource = (source: UiSource) =>
  ts.createSourceFile(source.path, source.text, ts.ScriptTarget.Latest, true, source.path.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS);

const checkPrimitiveImports = (source: UiSource, tree: ts.SourceFile, errors: string[]) => {
  for (const statement of tree.statements) {
    if (!(ts.isImportDeclaration(statement) || ts.isExportDeclaration(statement)) || !statement.moduleSpecifier || !ts.isStringLiteral(statement.moduleSpecifier)) continue;
    const specifier = statement.moduleSpecifier.text;
    const catalogTypeImport = isCatalogStory(source.path) && ts.isImportDeclaration(statement) && statement.importClause?.isTypeOnly && specifier === "@storybook/react-vite";
    if (!(specifier.startsWith("./") || primitiveExternalImports.has(specifier) || catalogTypeImport))
      errors.push(`${location(source.path, tree, statement)}: 基本部品は機能・画面・他の層に依存しない（import "${specifier}"）`);
  }
};

/**
 * web全体（`components/ui`を除く`.tsx`）の検査。nativeの`<button>`・入力要素を使わず、基本部品へ`className`・`style`を渡さず、
 * 操作列（`.list-toolbar`）の部品は同じ`size`を文字列で指定する。
 * 入力の例外は`<input type="hidden">`だけ（表示・操作を持たず、form POSTの値を運ぶだけのため。ログインのreturnTo・招待token）。
 */
const checkSharedPrimitives = (source: UiSource, tree: ts.SourceFile, exceptions: UiButtonException[], used: Set<UiButtonException>, errors: string[]) => {
  for (const element of openingElements(tree)) {
    const tag = element.tagName.getText(tree);
    const at = location(source.path, tree, element);
    if (primitiveComponents.has(tag))
      for (const name of ["className", "style"]) if (attribute(element, name)) errors.push(`${at}: <${tag}>へ${name}を渡さない（外側余白・配置は親layoutが持つ）`);
    if (nativeInputTags.has(tag) && !(tag === "input" && literalAttribute(element, "type") === "hidden"))
      errors.push(`${at}: <${tag}>を直接使わず、components/uiの入力部品（TextInput・TextArea・Select・Checkbox）を使う`);
    if (tag === "button") {
      const exception = exceptions.find((candidate) => candidate.path === source.path && literalAttribute(element, "className") === candidate.className);
      if (exception) used.add(exception);
      else errors.push(`${at}: <button>を直接使わず、components/uiのButtonを使う`);
    }
    if (classNames(element, tree).includes(toolbarClass)) checkToolbar(source, tree, element, errors);
  }
};

/** 操作列の中の部品は、すべて同じ`size`を文字列で指定する。 */
const checkToolbar = (source: UiSource, tree: ts.SourceFile, toolbar: ts.JsxOpeningLikeElement, errors: string[]) => {
  const body = ts.isJsxOpeningElement(toolbar) ? toolbar.parent : toolbar;
  const sizes = new Map<string, string[]>();
  for (const element of openingElements(body)) {
    if (element === toolbar) continue;
    const tag = element.tagName.getText(tree);
    const at = location(source.path, tree, element);
    if (["a", "Link", "NavLink", "button"].includes(tag)) { errors.push(`${at}: 操作列（.${toolbarClass}）に<${tag}>を直接置かず、sizeを持つ部品を使う`); continue; }
    if (!/^[A-Z]/.test(tag)) continue;
    const size = literalAttribute(element, "size");
    if (size === null) { errors.push(`${at}: 操作列（.${toolbarClass}）の<${tag}>にsizeを文字列で指定する`); continue; }
    sizes.set(size, [...(sizes.get(size) ?? []), tag]);
  }
  if (sizes.size > 1)
    errors.push(`${location(source.path, tree, toolbar)}: 操作列（.${toolbarClass}）の部品のsizeが一致しない（${[...sizes].map(([size, tags]) => `${size}: ${tags.join(", ")}`).join(" / ")}）`);
};

/** TSX・TSの検査。違反の一覧を返す（空なら成功）。 */
export const checkUiSources = (sources: UiSource[], exceptions: UiButtonException[] = uiButtonExceptions): string[] => {
  const errors: string[] = [];
  const used = new Set<UiButtonException>();
  for (const source of sources) {
    if (!/\.tsx?$/.test(source.path)) continue;
    const tree = parseSource(source);
    if (source.path.startsWith(primitiveRoot)) checkPrimitiveImports(source, tree, errors);
    if (source.path.endsWith(".tsx") && (!source.path.startsWith(primitiveRoot) || isCatalogStory(source.path))) checkSharedPrimitives(source, tree, exceptions, used, errors);
  }
  for (const exception of exceptions)
    if (!used.has(exception)) errors.push(`${exception.path}: <button className="${exception.className}">の例外の対象が見つからない（例外を削除する）`);
  return errors;
};

/** SCSSの宣言。`selectors`は入れ子と`&`を展開したselector、`at`は囲む@規則（`@media`・`@include narrow`・`@mixin`等）。 */
type ScssDeclaration = { file: string; rule: number; selectors: string[]; at: string[]; property: string; value: string };
type ScssSheet = { declarations: ScssDeclaration[]; topLevelSelectors: string[] };

/** 括弧の外のカンマで分ける。 */
const splitSelectorList = (text: string) => {
  const parts: string[] = [];
  let depth = 0;
  let current = "";
  for (const char of text) {
    if (char === "(" || char === "[") depth += 1;
    if (char === ")" || char === "]") depth -= 1;
    if (char === "," && depth === 0) { parts.push(current); current = ""; } else current += char;
  }
  return [...parts, current].map((part) => part.trim().replace(/\s+/g, " ")).filter(Boolean);
};

const expandSelectors = (parents: string[], header: string) =>
  splitSelectorList(header).flatMap((child) => (parents.length === 0 ? [child] : parents.map((parent) => (child.includes("&") ? child.replaceAll("&", parent) : `${parent} ${child}`))));

/**
 * SCSS（CSSを含む）を読み、入れ子を展開した宣言と最上位のselectorを返す。行コメント・ブロックコメント、`@keyframes`の中は除く。
 * 補間`#{$size}`の波括弧をblockと誤認しないよう、補間は中身（`$size`）へ置き換えてから読む。
 */
const parseScss = (file: string, text: string): ScssSheet => {
  const stripped = text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1").replace(/#\{([^{}]*)\}/g, "$1");
  const stack: { selectors: string[]; at: string[]; rule: number }[] = [];
  let rules = 0;
  const sheet: ScssSheet = { declarations: [], topLevelSelectors: [] };
  const skipped = (at: string[]) => at.some((rule) => /^@(keyframes|mixin|function)\b/.test(rule));
  let buffer = "";
  for (const char of stripped) {
    if (char === "{") {
      const header = buffer.trim();
      const parent = stack.at(-1) ?? { selectors: [], at: [], rule: 0 };
      rules += 1;
      if (header.startsWith("@")) stack.push({ selectors: parent.selectors, at: [...parent.at, header], rule: rules });
      else {
        const selectors = expandSelectors(parent.selectors, header);
        if (parent.selectors.length === 0 && !skipped(parent.at)) sheet.topLevelSelectors.push(...selectors);
        stack.push({ selectors, at: parent.at, rule: rules });
      }
      buffer = "";
    } else if (char === "}" || char === ";") {
      const match = /^([a-z-]+)\s*:\s*([\s\S]+)$/.exec(buffer.trim());
      const frame = stack.at(-1);
      if (match && frame && !frame.at.some((rule) => rule.startsWith("@keyframes")))
        sheet.declarations.push({ file, rule: frame.rule, selectors: frame.selectors, at: frame.at, property: match[1], value: match[2].trim() });
      buffer = "";
      if (char === "}") stack.pop();
    } else buffer += char;
  }
  return sheet;
};

/** selectorのcompound（子孫・子・兄弟の結合子で分けた単位）。属性・疑似classの引数は除く。 */
const compounds = (selector: string) => selector.replace(/\[[^\]]*\]/g, "").replace(/\([^)]*\)/g, "").split(/\s*[>+~]\s*|\s+/).filter(Boolean);
const classesOf = (compound: string) => [...compound.matchAll(/\.([A-Za-z_-][\w-]*)/g)].map((match) => match[1]);

/** selectorが定義するclass。末尾から見て最初にclassを持つcompoundの先頭のclass。それより前にclassが無ければ文脈の無い定義（plain）。 */
const definingClass = (selector: string) => {
  const list = compounds(selector);
  for (let index = list.length - 1; index >= 0; index -= 1) {
    const found = classesOf(list[index]);
    if (found.length > 0) return { name: found[0], plain: list.slice(0, index).every((compound) => classesOf(compound).length === 0) };
  }
  return null;
};

/** partial・sourceの所有者。`styles/`は共有（tokens・mixin・reset・複数の所有者が使うlayout）。 */
type UiOwner = "ui" | "components" | "app" | "shared" | "common" | `feature:${string}`;
const ownerOf = (path: string): UiOwner => {
  if (path.startsWith(primitiveRoot)) return "ui";
  if (path.startsWith("components/")) return "components";
  if (path.startsWith("app/")) return "app";
  if (path.startsWith("styles/")) return "shared";
  const feature = /^features\/([^/]+)\//.exec(path);
  return feature ? `feature:${feature[1]}` : "common";
};
const ownerLabel = (owner: UiOwner) =>
  owner === "ui" ? "components/ui" : owner === "components" ? "components" : owner === "shared" ? "styles" : owner === "common" ? "web直下の共通処理" : owner === "app" ? "app" : `features/${owner.slice("feature:".length)}`;

/** 各classを定義するpartial。文脈の無い定義があるpartialを優先し、無ければ文脈つきで定義するpartial。 */
const classHomes = (sheets: Map<string, ScssSheet>) => {
  const plain = new Map<string, Set<string>>();
  const contextual = new Map<string, Set<string>>();
  for (const [file, sheet] of sheets)
    for (const { selectors, at } of sheet.declarations) {
      if (at.some((rule) => rule.startsWith("@mixin"))) continue;
      for (const selector of selectors) {
        const defined = definingClass(selector);
        if (!defined) continue;
        const target = defined.plain ? plain : contextual;
        target.set(defined.name, (target.get(defined.name) ?? new Set()).add(file));
      }
    }
  const homes = new Map<string, Set<string>>(plain);
  for (const [name, files] of contextual) if (!homes.has(name)) homes.set(name, files);
  return homes;
};

const requiredMixinProperties = ["min-height", "padding", "font-size"];
const sizeProperties = new Set(["min-height", "height", "padding", "padding-left", "padding-right", "font-size", "line-height", "border-width"]);
/** 部品・組合せUIのpartialの外から、そのclassへ指定してよいproperty（親layoutが決める配置と字体）。部品（components/ui）へは外側余白も足さない。 */
const placementProperties = new Set(["width", "min-width", "max-width", "flex", "flex-grow", "flex-shrink", "flex-basis", "align-self", "justify-self", "grid-column", "grid-row", "order", "font-family"]);
const isPlacement = (property: string, home: string) => placementProperties.has(property) || (!home.startsWith(primitiveRoot) && property.startsWith("margin"));

/** 外側余白を持たない基本部品のclass（入力・文字だけのボタン）。sizeをトークンだけで指定する部品は`sizedClass`。 */
const fieldClass = /\.(field|input|textarea|select|checkbox|text-button)(?![\w-])/;
const sizedClass = /\.(input|textarea|select|text-button|button|secondary-button)(?![\w-])/;
/** sizeの値は`0`か`--control-*`・`--field-*`トークンだけ。 */
const tokenSize = (value: string) => value.split(/\s+/).every((part) => part === "0" || /^var\(--(control|field)-[^)]*\)$/.test(part));
/** 要素・全体のselector（reset・要素の既定値）を置いてよいpartial。tokensは`:root`のCSS変数だけを持つ。 */
const globalSelectorPartials = /^styles\/_(base|tokens)\.scss$/;

/**
 * SCSSの検査。size契約はmixinの`--control-*`トークンだけで定め、部品の内側の見た目は部品のpartialだけが持つ。
 * - 表示切替・操作列・入力の部品（`.view-switch*`・`.field`・`.input`・`.textarea`・`.select`・`.checkbox`・`.text-button`）へ外側余白を持たせず、
 *   入力・ボタンのsizeはどのselectorからもトークンだけで指定する。
 * - classを定義するpartialは1つだけ。部品（components/ui）・組合せUI（components）のclassへ、そのpartialの外から指定できるのは
 *   配置（幅・flex・grid・字体。組合せUIには外側余白も）だけ。共有layout（styles）のclassは利用側の文脈で調整してよい。
 * - `styles/_base.scss`・`styles/_tokens.scss`以外の最上位のselectorはclassから始める（要素・全体へのselectorを各partialに置かない）。
 */
export const checkUiStyles = (sources: UiSource[]): string[] => {
  const errors: string[] = [];
  const scss = sources.filter((source) => source.path.endsWith(".scss"));
  if (scss.length === 0) return ["走査対象にSCSSがない（検査の対象rootを確認する）"];
  const tokens = scss.find((source) => source.path.endsWith("_tokens.scss"))?.text ?? "";
  const mixins = scss.find((source) => source.path.endsWith("_mixins.scss"))?.text ?? "";
  const mixin = parseScss("styles/_mixins.scss", mixins).declarations.filter(({ at }) => /^@mixin control-size\(\$size\)$/.test(at[0] ?? ""));
  if (mixin.length === 0) errors.push("styles/_mixins.scss: @mixin control-size($size) が見つからない");
  else {
    // 値の各項は0か`--control-*`トークンだけ（`0 99px`等の固定値を混ぜない）。
    for (const { property, value } of mixin)
      if (!value.split(/\s+/).every((part) => part === "0" || /^var\(--control-[^)]*\)$/.test(part)))
        errors.push(`styles/_mixins.scss: control-sizeの${property}は--control-*トークンを使う（${value}）`);
    for (const property of requiredMixinProperties)
      if (!mixin.some((declaration) => declaration.property === property)) errors.push(`styles/_mixins.scss: control-sizeが${property}を定めていない`);
    for (const size of ["md", "sm"])
      for (const part of ["height", "padding-x", "font-size"])
        if (!tokens.includes(`--control-${size}-${part}:`)) errors.push(`styles/_tokens.scss: --control-${size}-${part} が定義されていない`);
  }
  const sheets = new Map(scss.map((source) => [source.path, parseScss(source.path, source.text)]));
  const homes = classHomes(sheets);
  for (const [name, files] of homes)
    if (files.size > 1) errors.push(`.${name} の定義が複数のpartialにある（${[...files].sort().join(", ")}）。所有するpartialの1つへまとめる`);
  for (const [file, sheet] of sheets) {
    if (!globalSelectorPartials.test(file))
      for (const selector of sheet.topLevelSelectors)
        if (!selector.startsWith(".")) errors.push(`${file}: 最上位のselector ${selector} はclassから始める（要素・全体のselectorはstyles/_base.scssに置く）`);
    for (const { selectors, at, property, value } of sheet.declarations) {
      if (at.some((rule) => rule.startsWith("@mixin"))) continue;
      for (const selector of selectors) {
        if (/\.list-switch(?![\w-])/.test(selector)) { errors.push(`${file}: 廃止した.list-switchを使わず、ViewSwitchを使う（${selector}）`); continue; }
        const own = compounds(selector).at(-1) ?? "";
        const inToolbar = /\.list-toolbar(?![\w-])/.test(selector) && /\.(view-switch|view-switch-item|button|secondary-button|compact)(?![\w-])/.test(own);
        const inSwitch = /\.view-switch(-item)?(?![\w-])/.test(own);
        if ((inSwitch || inToolbar) && property.startsWith("margin")) errors.push(`${file}: ${selector} に外側余白（${property}）を持たせず、親layoutのgap・余白を使う`);
        else if (fieldClass.test(own) && property.startsWith("margin")) errors.push(`${file}: ${selector} に外側余白（${property}）を持たせず、親layoutのgap・余白を使う`);
        if ((inSwitch || inToolbar) && sizeProperties.has(property) && !value.startsWith("var(--control-"))
          errors.push(`${file}: ${selector} の${property}はcontrol-sizeのトークンで指定する（${value}）`);
        else if (sizedClass.test(own) && sizeProperties.has(property) && !tokenSize(value))
          errors.push(`${file}: ${selector} の${property}は--control-*・--field-*トークンで指定する（${value}）`);
        const defined = definingClass(selector);
        const home = defined ? homes.get(defined.name) : undefined;
        const homeFile = home?.size === 1 ? [...home][0] : null;
        if (homeFile && homeFile !== file && ["ui", "components"].includes(ownerOf(homeFile)) && !isPlacement(property, homeFile))
          errors.push(`${file}: ${selector} は${homeFile}の.${defined!.name}を外側から上書きしない（${property}）。配置以外は部品のpartialで指定する`);
      }
    }
  }
  return errors;
};

/** classの利用を探すsourceの文字列。classNameと、JSXのattribute（spreadを含む）以外の式の文字列（class名を組み立てる関数等）を読む。 */
const classTokens = (source: UiSource) => {
  const tokens = new Set<string>();
  const visit = (node: ts.Node, inOtherAttribute: boolean) => {
    if (ts.isJsxAttribute(node)) {
      if (node.initializer) visit(node.initializer, inOtherAttribute || node.name.getText() !== "className");
      return;
    }
    if (ts.isJsxSpreadAttribute(node)) return;
    // attributeの値に渡したJSX（slot）の中のclassNameは読む。
    if (ts.isJsxElement(node) || ts.isJsxSelfClosingElement(node) || ts.isJsxFragment(node)) { ts.forEachChild(node, (child) => visit(child, false)); return; }
    if (!inOtherAttribute && (ts.isStringLiteralLike(node) || ts.isTemplateHead(node) || ts.isTemplateMiddle(node) || ts.isTemplateTail(node)))
      for (const token of node.text.split(/[^A-Za-z0-9_-]+/)) if (token) tokens.add(token);
    ts.forEachChild(node, (child) => visit(child, inOtherAttribute));
  };
  visit(parseSource(source), false);
  return tokens;
};

/**
 * SCSSのclassの所有と利用の検査。部品（components/ui）・組合せUI（components）・Feature・appのpartialのclassは、その所有者のsourceだけが使う。
 * `styles/`の共有classは2つ以上の所有者が使い、1つだけが使うならその所有partialへ移す。どこからも使わないclassは残さない。
 */
export const checkUiClassUsage = (sources: UiSource[]): string[] => {
  const scss = sources.filter((source) => source.path.endsWith(".scss"));
  const code = sources.filter((source) => /\.tsx?$/.test(source.path) && !source.path.endsWith(".d.ts"));
  if (scss.length === 0 || code.length === 0) return ["走査対象にSCSS・TSXがない（検査の対象rootを確認する）"];
  const homes = classHomes(new Map(scss.map((source) => [source.path, parseScss(source.path, source.text)])));
  const tokens = code.map((source) => ({ path: source.path, owner: ownerOf(source.path), tokens: classTokens(source) }));
  const errors: string[] = [];
  for (const [name, files] of [...homes].sort(([a], [b]) => a.localeCompare(b))) {
    if (files.size !== 1) continue;
    const [home] = files;
    const owner = ownerOf(home);
    const users = tokens.filter((candidate) => candidate.tokens.has(name));
    if (users.length === 0) { errors.push(`${home}: .${name} はどのsourceからも使われていない（未使用のstyleを削除する）`); continue; }
    if (owner === "shared") {
      const owners = [...new Set(users.map((user) => user.owner))];
      if (owners.length === 1) errors.push(`${home}: .${name} は${ownerLabel(owners[0])}だけが使うため、その所有partialへ移す`);
      continue;
    }
    for (const user of users)
      if (user.owner !== owner)
        errors.push(`${user.path}: ${ownerLabel(owner)}のclass .${name}（${home}）を直接使わない。${owner === "ui" || owner === "components" ? "その部品を使う" : "共有するならstyles/_layout.scssへ移す"}`);
  }
  return errors;
};

/**
 * 整理済みの旧視覚表現の検査（docs/web-ui.mdの「残存する旧表現の確認」）。pill（`--radius-pill`）は状態badge（`.status-badge`）だけが使い、
 * hoverで持ち上げる動き（`transform`）と、mixin以外での大文字変換（`text-transform: uppercase`）を使わない。
 */
export const checkLegacyVisuals = (sources: UiSource[]): string[] => {
  const errors: string[] = [];
  for (const source of sources.filter(({ path }) => path.endsWith(".scss") && path !== "styles/_tokens.scss" && path !== "styles/_mixins.scss"))
    for (const { selectors, property, value } of parseScss(source.path, source.text).declarations) {
      const where = `${source.path}: ${selectors.join(", ")}`;
      if (value.includes("--radius-pill") && !selectors.every((selector) => selector.startsWith(".status-badge"))) errors.push(`${where} のpillは状態badgeだけに使う`);
      if (property === "transform") errors.push(`${where} のtransformを使わない（hoverは面・枠の色で示す）`);
      if (property === "text-transform" && value === "uppercase") errors.push(`${where} の大文字変換はcaps-labelのmixinだけで行う`);
    }
  return errors;
};

/**
 * Sassの出力の検査。同じ@規則の中で、同じselectorの同じpropertyを別のruleで宣言しない（partialの二重出力・後のruleによる打消しを残さない）。
 * 1つのruleの中でmixinの値を上書きする宣言（`@include caps-label; color: ...`）は対象外。
 */
export const checkCompiledCss = (css: string): string[] => {
  const rules = new Map<string, Set<number>>();
  for (const { selectors, at, property, rule } of parseScss("css", css).declarations)
    for (const selector of selectors) {
      const key = `${at.join(" ")}\u0000${selector}\u0000${property}`;
      rules.set(key, (rules.get(key) ?? new Set()).add(rule));
    }
  return [...rules].filter(([, found]) => found.size > 1).map(([key]) => {
    const [at, selector, property] = key.split("\u0000");
    return `出力CSSで${selector}の${property}を複数のruleで宣言している${at ? `（${at}）` : ""}。1つのruleにまとめる`;
  });
};

/** Sassの入口。`app/main.tsx`が読み、tokens → base → layout → 部品 → 組合せUI → app → Featureの順に`@use`する。 */
export const uiStyleEntry = "app/main.scss";

/** Sassの入口をcompileし、web内の全partialが入口から読まれること（読まれないpartialを残さない）と出力の重複を検査する。 */
export const checkUiStyleEntry = (webRoot: string): string[] => {
  const result = sass.compile(join(webRoot, uiStyleEntry), { style: "expanded" });
  const loaded = new Set(result.loadedUrls.map((url) => relative(webRoot, fileURLToPath(url)).split(sep).join("/")));
  const files = walk(webRoot).map((file) => relative(webRoot, file).split(sep).join("/")).filter((file) => file.endsWith(".scss"));
  const errors = files.filter((file) => file !== uiStyleEntry && !loaded.has(file)).map((file) => `${file}: Sassの入口（${uiStyleEntry}）から読まれていない`);
  return [...errors, ...checkCompiledCss(result.css)];
};

/** 依存の層。`app/`はapp、`features/<名前>/`はFeature、それ以外（`components/`・web直下の共通処理等）は共通層。 */
type UiLayer = { kind: "app" } | { kind: "feature"; name: string } | { kind: "common" };
const layerOf = (path: string): UiLayer => {
  if (path.startsWith("app/")) return { kind: "app" };
  const feature = /^features\/([^/]+)\//.exec(path);
  return feature ? { kind: "feature", name: feature[1] } : { kind: "common" };
};
/**
 * Featureの公開入口。`index.ts(x)`はUIを含む入口、`model.ts`は純粋な型・関数だけの入口（テスト・他Featureの純関数のmoduleが読む）。
 * 他Featureはここだけを参照する。
 */
const isPublicEntry = (path: string) => /^features\/[^/]+\/(index\.tsx?|model\.ts)$/.test(path);
const isIndexEntry = (path: string) => /^features\/[^/]+\/index\.tsx?$/.test(path);
const isModelEntry = (path: string) => /^features\/[^/]+\/model\.ts$/.test(path);
/** bundlerが解決するstyle・asset。依存方向の検査の対象外。 */
const assetSpecifier = /\.(scss|sass|css|svg|png|jpe?g|webp|gif)(\?.*)?$/;

/** import元の指定。`import`・`export ... from`（型だけを含む）・文字列の`import()`・`require()`・`import("x")`型を読む。 */
const moduleSpecifiers = (tree: ts.SourceFile) => {
  const found: { node: ts.Node; specifier: string | null }[] = [];
  const visit = (node: ts.Node) => {
    if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier))
      found.push({ node, specifier: node.moduleSpecifier.text });
    if (ts.isImportEqualsDeclaration(node) && ts.isExternalModuleReference(node.moduleReference) && ts.isStringLiteral(node.moduleReference.expression))
      found.push({ node, specifier: node.moduleReference.expression.text });
    if (ts.isCallExpression(node) && (node.expression.kind === ts.SyntaxKind.ImportKeyword || (ts.isIdentifier(node.expression) && node.expression.text === "require"))) {
      const [argument] = node.arguments;
      found.push({ node, specifier: argument && ts.isStringLiteralLike(argument) ? argument.text : null });
    }
    if (ts.isImportTypeNode(node) && ts.isLiteralTypeNode(node.argument) && ts.isStringLiteral(node.argument.literal))
      found.push({ node, specifier: node.argument.literal.text });
    ts.forEachChild(node, visit);
  };
  visit(tree);
  return found;
};

/** tsconfigの`paths`（`server/src/web`からの相対）。aliasを経由した依存もimport先のfileで判定する。 */
export type UiDependencyOptions = { paths?: Record<string, string[]> };

const virtualRoot = "/web";

/**
 * web全体の依存方向の検査。共通層からapp・Featureへ、Featureからappへ、他Featureの公開入口以外への依存を検出する。
 * importはTypeScriptのbundler解決（tsconfigの`paths`を含む）で実際のfileへ解決するため、alias・再exportの経由も同じ規則で判定する。
 * 解決できないlocal import・文字列でない`import()`は迂回になりうるため失敗にする。app・Feature・共通層のいずれかが空でも失敗する。
 * さらに、Feature内から自身の`index`を経由しないこと、`model.ts`が`.tsx`へ推移的に依存しないこと、公開入口を経由したものを含めて
 * Feature間の依存が循環しないことを検査する。
 */
export const checkUiDependencies = (sources: UiSource[], options: UiDependencyOptions = {}): string[] => {
  const code = sources.filter((source) => /\.tsx?$/.test(source.path) && !source.path.endsWith(".d.ts"));
  const errors: string[] = [];
  for (const kind of ["app", "feature", "common"] as const)
    if (!code.some((source) => layerOf(source.path).kind === kind)) errors.push(`走査対象に${kind}のsourceがない（検査の対象rootを確認する）`);
  const files = new Map(code.map((source) => [`${virtualRoot}/${source.path}`, source.text]));
  const host: ts.ModuleResolutionHost = {
    fileExists: (file) => files.has(file),
    readFile: (file) => files.get(file),
    directoryExists: (directory) => [...files.keys()].some((file) => file.startsWith(`${directory}/`)),
  };
  const compilerOptions: ts.CompilerOptions = {
    module: ts.ModuleKind.ESNext,
    moduleResolution: ts.ModuleResolutionKind.Bundler,
    allowImportingTsExtensions: true,
    jsx: ts.JsxEmit.ReactJSX,
    ...(options.paths ? { baseUrl: virtualRoot, paths: options.paths } : {}),
  };
  const aliasPrefixes = Object.keys(options.paths ?? {}).map((pattern) => pattern.split("*")[0]);
  /** 解決したweb内の依存（file → file）と、Feature間の依存（Feature → Feature → 根拠のfileの組）。 */
  const graph = new Map<string, Set<string>>();
  const featureEdges = new Map<string, Map<string, string>>();
  for (const source of code) {
    const tree = parseSource(source);
    const from = layerOf(source.path);
    for (const { node, specifier } of moduleSpecifiers(tree)) {
      const at = location(source.path, tree, node);
      if (specifier === null) { errors.push(`${at}: 文字列でないimport()・require()は依存を検査できないため使わない`); continue; }
      if ((specifier === "storybook" || specifier.startsWith("@storybook/")) &&
          !(isCatalogStory(source.path) && specifier === "@storybook/react-vite" && ts.isImportDeclaration(node) && node.importClause?.isTypeOnly))
        errors.push(`${at}: Storybookはstoryの@storybook/react-vite型importだけを使う`);
      if (assetSpecifier.test(specifier)) continue;
      const resolved = ts.resolveModuleName(specifier, `${virtualRoot}/${source.path}`, compilerOptions, host).resolvedModule?.resolvedFileName;
      const target = resolved?.startsWith(`${virtualRoot}/`) && files.has(resolved) ? resolved.slice(virtualRoot.length + 1) : null;
      if (target === null) {
        if (specifier.startsWith(".") || specifier.startsWith("/") || aliasPrefixes.some((prefix) => specifier.startsWith(prefix)))
          errors.push(`${at}: web内で解決できないlocal import "${specifier}"`);
        continue;
      }
      if (isCatalogStory(target) && !isCatalogStory(source.path))
        errors.push(`${at}: 製品sourceからカタログstoryへ依存しない（${target}）`);
      const to = layerOf(target);
      graph.set(source.path, (graph.get(source.path) ?? new Set()).add(target));
      if (from.kind === "feature" && to.kind === "feature" && from.name !== to.name) {
        const edges = featureEdges.get(from.name) ?? new Map<string, string>();
        if (!edges.has(to.name)) edges.set(to.name, `${source.path} -> ${target}`);
        featureEdges.set(from.name, edges);
      }
      if (from.kind === "feature" && to.kind === "feature" && from.name === to.name && isIndexEntry(target) && !isIndexEntry(source.path))
        errors.push(`${at}: Feature内から自身の公開入口（${target}）を経由しない。内部fileを直接参照する`);
      if (from.kind === "common" && to.kind !== "common") errors.push(`${at}: 共通層から${to.kind === "app" ? "app" : "Feature"}へ依存しない（${target}）`);
      else if (from.kind === "feature" && to.kind === "app") errors.push(`${at}: Featureからappへ依存しない（${target}）。画面の合成はappのroute layoutで行う`);
      else if (from.kind === "feature" && to.kind === "feature" && from.name !== to.name && !isPublicEntry(target))
        errors.push(`${at}: 他Featureの内部fileへ依存しない（${target}）。features/${to.name}/index.ts（純関数のmoduleからはmodel.ts）の公開入口を使う`);
    }
  }
  for (const source of code.filter((candidate) => isModelEntry(candidate.path))) {
    const component = reachable(graph, source.path).find((path) => path.endsWith(".tsx"));
    if (component) errors.push(`${source.path}: model.tsは純粋な公開入口のため、.tsxへ推移的に依存しない（${component}）`);
  }
  for (const cycle of featureCycles(featureEdges))
    errors.push(`Featureの依存が循環する（${cycle.map(([name]) => name).join(" -> ")} -> ${cycle[0][0]}）: ${cycle.map(([, evidence]) => evidence).join(", ")}`);
  return errors;
};

/** `start`から辿れるfile（`start`を除く）。 */
const reachable = (graph: ReadonlyMap<string, ReadonlySet<string>>, start: string): string[] => {
  const seen = new Set<string>([start]);
  const queue = [start];
  while (queue.length > 0) for (const next of graph.get(queue.shift()!) ?? []) if (!seen.has(next)) { seen.add(next); queue.push(next); }
  seen.delete(start);
  return [...seen].sort();
};

/** Feature間の循環。同じFeatureの組の循環は1回だけ、各辺の根拠（最初に見つけたimport）とともに返す。 */
const featureCycles = (edges: ReadonlyMap<string, ReadonlyMap<string, string>>): [string, string][][] => {
  const cycles: [string, string][][] = [];
  const reported = new Set<string>();
  const done = new Set<string>();
  const visit = (name: string, stack: string[]) => {
    if (done.has(name)) return;
    const index = stack.indexOf(name);
    if (index >= 0) {
      const members = stack.slice(index);
      const key = [...members].sort().join(",");
      if (!reported.has(key)) {
        reported.add(key);
        cycles.push(members.map((member, i) => [member, edges.get(member)!.get(members[(i + 1) % members.length])!]));
      }
      return;
    }
    for (const next of [...(edges.get(name)?.keys() ?? [])].sort()) visit(next, [...stack, name]);
    done.add(name);
  };
  for (const name of [...edges.keys()].sort()) visit(name, []);
  return cycles;
};

/** web（`server/src/web/tsconfig.json`）の`paths`。`baseUrl`が無ければtsconfigのdirectoryを基準にする。 */
export const readWebPaths = (webRoot: string): Record<string, string[]> | undefined => {
  const config = ts.readConfigFile(join(webRoot, "tsconfig.json"), ts.sys.readFile);
  if (config.error) throw new Error("server/src/web/tsconfig.jsonを読めない");
  const { baseUrl = ".", paths } = (config.config as { compilerOptions?: { baseUrl?: string; paths?: Record<string, string[]> } }).compilerOptions ?? {};
  if (!paths) return undefined;
  return Object.fromEntries(Object.entries(paths).map(([pattern, targets]) => [pattern, targets.map((target) => join(baseUrl, target).split(sep).join("/"))]));
};

const walk = (directory: string): string[] =>
  readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const file = join(directory, entry.name);
    return entry.isDirectory() ? walk(file) : /\.(tsx?|scss)$/.test(entry.name) ? [file] : [];
  });

/** `server/src/web`の実sourceを読み込む。 */
export const readWebSources = (webRoot: string): UiSource[] =>
  walk(webRoot).map((file) => ({ path: relative(webRoot, file).split(sep).join("/"), text: readFileSync(file, "utf8") }));
