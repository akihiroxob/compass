import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { OrchestrationState } from "./state.ts";

export interface CompassStateReader {
  getOrchestrationState(projectId: string, token: string): Promise<OrchestrationState>;
}

export class CompassToolError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

/**
 * Compass Server の `/mcp` から現在状態を読む。操作 Context は常に `runtime` に固定する（`X-Compass-Active-Role`）。
 * Orchestrator は読むだけで、Direction / Work の状態を書き換えない。
 */
export class McpCompassStateReader implements CompassStateReader {
  constructor(private readonly serverUrl: string) {}

  async getOrchestrationState(projectId: string, token: string): Promise<OrchestrationState> {
    const client = new Client({ name: "compass-orchestrator", version: "0.1.0" });
    const transport = new StreamableHTTPClientTransport(new URL("/mcp", this.serverUrl), {
      requestInit: { headers: { Authorization: `Bearer ${token}`, "X-Compass-Active-Role": "runtime" } },
    });
    await client.connect(transport);
    try {
      const result = (await client.callTool({ name: "get_orchestration_state", arguments: { projectId } })) as {
        isError?: boolean;
        structuredContent?: Record<string, unknown>;
      };
      if (result.isError) {
        const error = (result.structuredContent?.error ?? {}) as { code?: string; message?: string };
        throw new CompassToolError(error.code ?? "UNKNOWN", error.message ?? "get_orchestration_state failed");
      }
      return result.structuredContent as OrchestrationState;
    } finally {
      await client.close();
    }
  }
}
