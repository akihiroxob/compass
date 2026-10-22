import { readdirSync, readFileSync } from "node:fs";
import { join, relative, sep } from "node:path";
import ts from "typescript";

/**
 * Web UIの構造検査（`npm run check:ui`）。共通の基本部品（`components/ui`）と、段階適用した保護対象の操作列を検査する。
 * 対象外の画面の既存の`.button`・`<button>`等は検査しない。適用範囲を広げるときは`uiProtectedScopes`へ追加する。
 */

/** Web UIのsource（`server/src/web`からの相対path、`/`区切り）。 */
export type UiSource = { path: string; text: string };

/** 保護対象。`components`を省略するとfile全体、指定するとその名前のcomponent（変数宣言）だけを検査する。 */
export type UiProtectedScope = { path: string; components?: string[] };

export const uiProtectedScopes: UiProtectedScope[] = [
  { path: "features/project/ProjectListPage.tsx" },
  { path: "features/workspace/WorkspacePages.tsx", components: ["ProjectsContent"] },
  { path: "features/execution/ExecutionSection.tsx", components: ["TaskFilterSwitch"] },
];

const primitiveRoot = "components/ui/";
const primitiveComponents = new Set(["LinkButton", "ViewSwitch"]);
/** 基本部品が持つclass。保護対象で直接付けると、部品を使わない独自実装になる。 */
const controlClasses = new Set(["button", "secondary-button", "compact", "view-switch", "view-switch-item", "list-switch"]);
const toolbarClass = "list-toolbar";
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

const checkPrimitiveImports = (source: UiSource, tree: ts.SourceFile, errors: string[]) => {
  for (const statement of tree.statements) {
    if (!(ts.isImportDeclaration(statement) || ts.isExportDeclaration(statement)) || !statement.moduleSpecifier || !ts.isStringLiteral(statement.moduleSpecifier)) continue;
    const specifier = statement.moduleSpecifier.text;
    if (!(specifier.startsWith("./") || primitiveExternalImports.has(specifier)))
      errors.push(`${location(source.path, tree, statement)}: 基本部品は機能・画面・他の層に依存しない（import "${specifier}"）`);
  }
};

const checkProtectedNode = (source: UiSource, tree: ts.SourceFile, node: ts.Node, errors: string[]) => {
  for (const element of openingElements(node)) {
    const tag = element.tagName.getText(tree);
    const at = location(source.path, tree, element);
    if (primitiveComponents.has(tag)) {
      for (const name of ["className", "style"]) if (attribute(element, name)) errors.push(`${at}: <${tag}>へ${name}を渡さない（外側余白・配置は親layoutが持つ）`);
      continue;
    }
    if (tag === "button") errors.push(`${at}: <button>を直接使わず、components/uiの基本部品を使う`);
    const own = classNames(element, tree).filter((name) => controlClasses.has(name));
    if (own.length > 0) errors.push(`${at}: <${tag}>に基本部品のclass（${own.join(", ")}）を直接付けず、components/uiの基本部品を使う`);
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

const componentDeclarations = (tree: ts.SourceFile) => {
  const found = new Map<string, ts.Node>();
  for (const statement of tree.statements) {
    if (ts.isVariableStatement(statement))
      for (const declaration of statement.declarationList.declarations) if (ts.isIdentifier(declaration.name)) found.set(declaration.name.text, declaration);
    if (ts.isFunctionDeclaration(statement) && statement.name) found.set(statement.name.text, statement);
  }
  return found;
};

/** TSX・TSの検査。違反の一覧を返す（空なら成功）。 */
export const checkUiSources = (sources: UiSource[], scopes: UiProtectedScope[] = uiProtectedScopes): string[] => {
  const errors: string[] = [];
  const parsed = new Map(sources.map((source) => [source.path, ts.createSourceFile(source.path, source.text, ts.ScriptTarget.Latest, true, source.path.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS)]));
  for (const source of sources) if (source.path.startsWith(primitiveRoot)) checkPrimitiveImports(source, parsed.get(source.path)!, errors);
  for (const scope of scopes) {
    const source = sources.find((candidate) => candidate.path === scope.path);
    const tree = parsed.get(scope.path);
    if (!source || !tree) { errors.push(`${scope.path}: 保護対象のfileが見つからない`); continue; }
    if (!scope.components) { checkProtectedNode(source, tree, tree, errors); continue; }
    const declarations = componentDeclarations(tree);
    for (const name of scope.components) {
      const declaration = declarations.get(name);
      if (declaration) checkProtectedNode(source, tree, declaration, errors);
      else errors.push(`${scope.path}: 保護対象のcomponent ${name} が見つからない`);
    }
  }
  return errors;
};

/**
 * SCSSの宣言を、入れ子のselectorの連なりと一緒に列挙する。行コメント・ブロックコメントは除く。
 * 補間`#{$size}`の波括弧をblockと誤認しないよう、補間は中身（`$size`）へ置き換えてから読む。
 */
const scssDeclarations = (text: string) => {
  const stripped = text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1").replace(/#\{([^{}]*)\}/g, "$1");
  const stack: string[] = [];
  const declarations: { selectors: string[]; property: string; value: string }[] = [];
  let buffer = "";
  for (const char of stripped) {
    if (char === "{") { stack.push(buffer.trim()); buffer = ""; }
    else if (char === "}" || char === ";") {
      const match = /^([a-z-]+)\s*:\s*([\s\S]+)$/.exec(buffer.trim());
      if (match && stack.length > 0) declarations.push({ selectors: [...stack], property: match[1], value: match[2].trim() });
      buffer = "";
      if (char === "}") stack.pop();
    } else buffer += char;
  }
  return declarations;
};

const requiredMixinProperties = ["min-height", "padding", "font-size"];
const sizeProperties = new Set(["min-height", "height", "padding", "padding-left", "padding-right", "font-size", "line-height", "border-width"]);

/** SCSSの検査。size契約はmixinの`--control-*`トークンだけで定め、表示切替・操作列の部品へ外側余白・固定sizeを足さない。 */
export const checkUiStyles = (sources: UiSource[]): string[] => {
  const errors: string[] = [];
  const tokens = sources.find((source) => source.path.endsWith("_tokens.scss"))?.text ?? "";
  const mixins = sources.find((source) => source.path.endsWith("_mixins.scss"))?.text ?? "";
  const mixin = scssDeclarations(mixins).filter(({ selectors }) => /^@mixin control-size\(\$size\)$/.test(selectors[0]));
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
  for (const source of sources) {
    for (const { selectors, property, value } of scssDeclarations(source.text)) {
      const chain = selectors.join(" ");
      if (/\.list-switch(?![\w-])/.test(chain)) { errors.push(`${source.path}: 廃止した.list-switchを使わず、ViewSwitchを使う（${chain}）`); continue; }
      const own = selectors.at(-1) ?? "";
      const inToolbar = /\.list-toolbar(?![\w-])/.test(chain) && /\.(view-switch|view-switch-item|button|secondary-button|compact)(?![\w-])/.test(own);
      const inSwitch = /\.view-switch(-item)?(?![\w-])/.test(own);
      if ((inSwitch || inToolbar) && property.startsWith("margin")) errors.push(`${source.path}: ${chain} に外側余白（${property}）を持たせず、親layoutのgap・余白を使う`);
      if ((inSwitch || inToolbar) && sizeProperties.has(property) && !value.startsWith("var(--control-"))
        errors.push(`${source.path}: ${chain} の${property}はcontrol-sizeのトークンで指定する（${value}）`);
    }
  }
  return errors;
};

const walk = (directory: string): string[] =>
  readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const file = join(directory, entry.name);
    return entry.isDirectory() ? walk(file) : /\.(tsx?|scss)$/.test(entry.name) ? [file] : [];
  });

/** `server/src/web`の実sourceを読み込む。 */
export const readWebSources = (webRoot: string): UiSource[] =>
  walk(webRoot).map((file) => ({ path: relative(webRoot, file).split(sep).join("/"), text: readFileSync(file, "utf8") }));
