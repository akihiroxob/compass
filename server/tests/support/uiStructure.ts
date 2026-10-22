import { readdirSync, readFileSync } from "node:fs";
import { join, relative, sep } from "node:path";
import ts from "typescript";

/**
 * Web UIの構造検査（`npm run check:ui`）。web全体のapp・Feature・共通層の依存方向と、共通の基本部品（`components/ui`）、
 * 段階適用した保護対象の操作列を検査する。基本部品の検査の対象外の画面にある既存の`.button`・`<button>`等は検査しない。
 * 適用範囲を広げるときは`uiProtectedScopes`へ追加する。
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

/** 依存の層。`app/`はapp、`features/<名前>/`はFeature、それ以外（`components/`・web直下の共通処理等）は共通層。 */
type UiLayer = { kind: "app" } | { kind: "feature"; name: string } | { kind: "common" };
const layerOf = (path: string): UiLayer => {
  if (path.startsWith("app/")) return { kind: "app" };
  const feature = /^features\/([^/]+)\//.exec(path);
  return feature ? { kind: "feature", name: feature[1] } : { kind: "common" };
};
/** Featureの公開入口（`features/<名前>/index.ts(x)`）。他Featureはここだけを参照する。 */
const isPublicEntry = (path: string) => /^features\/[^/]+\/index\.tsx?$/.test(path);
/** bundlerが解決するstyle・asset。依存方向の検査の対象外。 */
const assetSpecifier = /\.(scss|sass|css|svg|png|jpe?g|webp|gif)(\?.*)?$/;

/**
 * 他Featureの内部fileへの既知の依存（`from -> to`）。公開入口と循環の整理は後続Task（03 機能固有の型・hook・API・validationを
 * Featureへ集約し、公開入口を検査する）が所有する。ここに無い依存は失敗し、解消した依存が残っていても失敗する（一覧を増やさない）。
 */
export const knownCrossFeatureImports: string[] = [
  "features/activity/ActivitySection.tsx -> features/workspace/workspace.ts",
  "features/agent/AgentSections.tsx -> features/credential/credentials.ts",
  "features/agent/AgentSections.tsx -> features/grant/grants.ts",
  "features/agent/AgentSections.tsx -> features/project/overview.ts",
  "features/agent/AgentSections.tsx -> features/workspace/workspace.ts",
  "features/agent/agents.ts -> features/credential/credentials.ts",
  "features/agent/agents.ts -> features/execution/execution.ts",
  "features/agent/agents.ts -> features/grant/grants.ts",
  "features/execution/TaskDetailPage.tsx -> features/project/overview.ts",
  "features/execution/TaskDetailPage.tsx -> features/workspace/WorkspaceContext.tsx",
  "features/execution/TaskDetailPage.tsx -> features/workspace/workspace.ts",
  "features/execution/TaskOutcomeSection.tsx -> features/workspace/workspace.ts",
  "features/project/ProjectDetailPage.tsx -> features/workspace/workspace.ts",
  "features/project/ProjectFormPages.tsx -> features/workspace/workspace.ts",
  "features/project/ProjectListPage.tsx -> features/workspace/workspace.ts",
  "features/project/ProjectOverview.tsx -> features/workspace/WorkspaceOverview.tsx",
  "features/project/ProjectOverview.tsx -> features/workspace/directionData.ts",
  "features/project/ProjectOverview.tsx -> features/workspace/workspace.ts",
  "features/project/overview.ts -> features/workspace/direction.ts",
  "features/project/overview.ts -> features/workspace/overview.ts",
  "features/workspace/WorkspaceDirection.tsx -> features/intent/IntentFacts.tsx",
  "features/workspace/WorkspaceOverview.tsx -> features/project/overview.ts",
  "features/workspace/WorkspacePages.tsx -> features/project/overview.ts",
];

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
export type UiDependencyOptions = { paths?: Record<string, string[]>; knownCrossFeatureImports?: string[] };

const virtualRoot = "/web";

/**
 * web全体の依存方向の検査。共通層からapp・Featureへ、Featureからappへ、他Featureの公開入口以外への依存を検出する。
 * importはTypeScriptのbundler解決（tsconfigの`paths`を含む）で実際のfileへ解決するため、alias・再exportの経由も同じ規則で判定する。
 * 解決できないlocal import・文字列でない`import()`は迂回になりうるため失敗にする。app・Feature・共通層のいずれかが空でも失敗する。
 */
export const checkUiDependencies = (sources: UiSource[], options: UiDependencyOptions = {}): string[] => {
  const known = options.knownCrossFeatureImports ?? knownCrossFeatureImports;
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
  const used = new Set<string>();
  for (const source of code) {
    const tree = ts.createSourceFile(source.path, source.text, ts.ScriptTarget.Latest, true, source.path.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
    const from = layerOf(source.path);
    for (const { node, specifier } of moduleSpecifiers(tree)) {
      const at = location(source.path, tree, node);
      if (specifier === null) { errors.push(`${at}: 文字列でないimport()・require()は依存を検査できないため使わない`); continue; }
      if (assetSpecifier.test(specifier)) continue;
      const resolved = ts.resolveModuleName(specifier, `${virtualRoot}/${source.path}`, compilerOptions, host).resolvedModule?.resolvedFileName;
      const target = resolved?.startsWith(`${virtualRoot}/`) && files.has(resolved) ? resolved.slice(virtualRoot.length + 1) : null;
      if (target === null) {
        if (specifier.startsWith(".") || specifier.startsWith("/") || aliasPrefixes.some((prefix) => specifier.startsWith(prefix)))
          errors.push(`${at}: web内で解決できないlocal import "${specifier}"`);
        continue;
      }
      const to = layerOf(target);
      if (from.kind === "common" && to.kind !== "common") errors.push(`${at}: 共通層から${to.kind === "app" ? "app" : "Feature"}へ依存しない（${target}）`);
      else if (from.kind === "feature" && to.kind === "app") errors.push(`${at}: Featureからappへ依存しない（${target}）。画面の合成はappのroute layoutで行う`);
      else if (from.kind === "feature" && to.kind === "feature" && from.name !== to.name && !isPublicEntry(target)) {
        const edge = `${source.path} -> ${target}`;
        if (known.includes(edge)) used.add(edge);
        else errors.push(`${at}: 他Featureの内部fileへ依存しない（${target}）。features/${to.name}/index.tsの公開入口を使う`);
      }
    }
  }
  for (const edge of known) if (!used.has(edge)) errors.push(`既知の依存 ${edge} は見つからない。解消したら一覧から削除する`);
  return errors;
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
