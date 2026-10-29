import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

/**
 * tools/listの`_meta`で公開するToolの分類。所有するBounded Context（`compass/context`）と、呼び出す主体の種別（`compass/caller`）。
 * 検証用Policy等はTool名の一覧ではなくこの分類とscopeで許可範囲を決める。分類は操作の許可ではなく、認可はServerが常に行う。
 */
export const toolContextMetaKey = "compass/context";
export const toolCallerMetaKey = "compass/caller";
export type ToolContext = "work" | "collaboration";

/** Runtime Credentialだけが呼べるtoolに付ける。Agent Credentialの利用主体を対象にした許可範囲から外れる。 */
export const runtimeToolMeta = { [toolCallerMetaKey]: "runtime" } as const;

export type ToolRegistrar = Pick<McpServer, "registerTool">;

/** このregistrarで登録するtoolに、同じContextの分類を付ける。新しいtoolも登録先のmoduleで分類され、名前の追記を要しない。 */
export const withToolContext = (server: McpServer, context: ToolContext): ToolRegistrar => ({
  registerTool: ((name: string, config: { _meta?: Record<string, unknown> }, callback: unknown) =>
    (server.registerTool as (...args: unknown[]) => unknown).call(server, name, {
      ...config,
      _meta: { [toolContextMetaKey]: context, [toolCallerMetaKey]: "agent", ...config._meta },
    }, callback)) as McpServer["registerTool"],
});
