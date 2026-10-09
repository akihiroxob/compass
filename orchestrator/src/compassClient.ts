import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { WorkspaceOrchestrationState } from "./state.ts";

export interface CompassStateReader {
  getWorkspaceOrchestrationState(workspaceId: string, token: string): Promise<WorkspaceOrchestrationState>;
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
 * Compass Server の `/mcp` から Workspace の現在状態（`get_workspace_orchestration_state`）を Workspace Runtime Credential で読む。
 * 操作 Context は常に `runtime` に固定する（`X-Compass-Active-Role`）。Orchestrator は読むだけで、Direction / Work の状態を書き換えない。
 */
export class McpCompassStateReader implements CompassStateReader {
  constructor(private readonly serverUrl: string) {}

  async getWorkspaceOrchestrationState(workspaceId: string, token: string): Promise<WorkspaceOrchestrationState> {
    const client = new Client({ name: "compass-orchestrator", version: "0.1.0" });
    const transport = new StreamableHTTPClientTransport(new URL("/mcp", this.serverUrl), {
      requestInit: { headers: { Authorization: `Bearer ${token}`, "X-Compass-Active-Role": "runtime" } },
    });
    await client.connect(transport);
    try {
      const result = (await client.callTool({ name: "get_workspace_orchestration_state", arguments: { workspaceId } })) as {
        isError?: boolean;
        structuredContent?: Record<string, unknown>;
      };
      if (result.isError) {
        const error = (result.structuredContent?.error ?? {}) as { code?: string; message?: string };
        throw new CompassToolError(error.code ?? "UNKNOWN", error.message ?? "get_workspace_orchestration_state failed");
      }
      return result.structuredContent as WorkspaceOrchestrationState;
    } finally {
      await client.close();
    }
  }
}
