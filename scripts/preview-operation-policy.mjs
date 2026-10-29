/**
 * Scope-based operation policy for verification actors on a dedicated preview MCP.
 * Tool names from tools/list are observations: permission comes from each tool's `_meta` classification and the manifest scope.
 * The server still enforces Grants, Roles, Claims, leases, versions and self-review/acceptance rules.
 */
export const toolContextMetaKey = 'compass/context';
export const toolCallerMetaKey = 'compass/caller';

export const previewOperationPolicy = {
  kind: 'scoped-public-operations',
  contexts: ['work', 'collaboration'],
  caller: 'agent',
  roleScopes: { manager: 'project', worker: 'project', reviewer: 'project', strategist: 'workspace', evaluator: 'workspace' },
  entities: 'dedicated-preview-database-only',
};

/** kind: tool_unavailable | policy_denied | authorization_denied | operation_failed | transport_failure */
export class PreviewOperationError extends Error {
  constructor(kind, message, details = {}) {
    super(`${kind}: ${message}`);
    this.name = 'PreviewOperationError';
    this.kind = kind;
    Object.assign(this, details);
  }
}

export const classifyTool = (tool) => ({
  name: tool.name, context: tool._meta?.[toolContextMetaKey] ?? null, caller: tool._meta?.[toolCallerMetaKey] ?? null,
});

/** null when the policy permits the call, otherwise the reason. `preparation` is the manifest's dataPreparation. */
const actorDenial = (preparation, role) =>
  preparation.operationPolicy?.roleScopes?.[role] && preparation.actors?.[role] ? null : `${role} is not a verification actor of this preview`;

export const policyDenial = (preparation, role, tool, args = {}) => {
  const policy = preparation.operationPolicy;
  const actor = actorDenial(preparation, role);
  if (actor) return actor;
  const { context, caller } = classifyTool(tool);
  if (!policy.contexts.includes(context) || caller !== policy.caller) {
    return `${tool.name} (context ${context ?? 'none'}, caller ${caller ?? 'none'}) is outside the permitted ${policy.contexts.join('/')} operations`;
  }
  if (args.projectId !== undefined && !preparation.projectIds.includes(args.projectId)) return `Project ${args.projectId} is outside the verification scope`;
  if (args.workspaceId !== undefined && !preparation.workspaceIds.includes(args.workspaceId)) return `Workspace ${args.workspaceId} is outside the verification scope`;
  return null;
};

const readResponse = (raw, id) => {
  const messages = raw.split('\n').filter((line) => line.startsWith('data: ')).map((line) => line.slice(6));
  for (const text of messages.length ? messages : [raw]) {
    try {
      const message = JSON.parse(text);
      if (message.id === id) return message;
    } catch {}
  }
  return null;
};

/** MCP client bound to the dedicated preview origin. Pass `fetch` to call an in-process app. */
export const createPreviewMcpClient = ({ origin, preparation, fetch: send = globalThis.fetch }) => {
  const endpoint = new URL(preparation.endpointPath, origin).href;
  const listed = new Map();
  let sequence = 0;
  const rpc = async (role, method, params) => {
    const id = `preview-${++sequence}`;
    let response, raw;
    try {
      response = await send(endpoint, { method: 'POST', headers: {
        'Content-Type': 'application/json', Accept: 'application/json, text/event-stream',
        Authorization: `Bearer ${preparation.actors[role]}`, 'X-Compass-Active-Role': role,
      }, body: JSON.stringify({ jsonrpc: '2.0', id, method, params }) });
      raw = await response.text();
    } catch (error) {
      throw new PreviewOperationError('transport_failure', `${method} could not reach ${endpoint}: ${error.message}`, { method });
    }
    if (response.status === 401 || response.status === 403) {
      throw new PreviewOperationError('authorization_denied', `${method} returned HTTP ${response.status}`, { method, status: response.status });
    }
    if (!response.ok) throw new PreviewOperationError('transport_failure', `${method} returned HTTP ${response.status}`, { method, status: response.status });
    const message = readResponse(raw, id);
    if (!message) throw new PreviewOperationError('transport_failure', `${method} returned no JSON-RPC response for ${id}`, { method });
    if (message.error) throw new PreviewOperationError('operation_failed', `${method}: ${message.error.message}`, { method, code: message.error.code });
    return message.result;
  };
  const listTools = async (role) => {
    const actor = actorDenial(preparation, role);
    if (actor) throw new PreviewOperationError('policy_denied', actor, { role });
    if (!listed.has(role)) {
      const tools = [];
      let cursor;
      do {
        const page = await rpc(role, 'tools/list', cursor === undefined ? {} : { cursor });
        if (!Array.isArray(page?.tools)) throw new PreviewOperationError('transport_failure', 'Invalid tools/list response', { method: 'tools/list' });
        tools.push(...page.tools);
        cursor = page.nextCursor;
      } while (cursor);
      listed.set(role, tools);
    }
    return listed.get(role);
  };
  return {
    listTools,
    /** Tools of the current contract that the policy permits for the role, before scope checks on arguments. */
    permittedTools: async (role) => (await listTools(role)).filter((tool) => policyDenial(preparation, role, tool) === null).map(({ name }) => name),
    /** Calls a tool after checking the current contract and the policy. Adds a requestId when the schema declares one and none is given. */
    call: async (role, name, args = {}) => {
      const tool = (await listTools(role)).find((item) => item.name === name);
      if (!tool) throw new PreviewOperationError('tool_unavailable', `${name} is not in the current tools/list`, { tool: name });
      const denial = policyDenial(preparation, role, tool, args);
      if (denial) throw new PreviewOperationError('policy_denied', denial, { tool: name });
      const input = tool.inputSchema?.properties?.requestId && args.requestId === undefined ? { ...args, requestId: crypto.randomUUID() } : args;
      const result = await rpc(role, 'tools/call', { name, arguments: input });
      if (result?.isError) {
        const error = result.structuredContent?.error ?? {};
        const kind = ['FORBIDDEN', 'UNAUTHENTICATED'].includes(error.code) ? 'authorization_denied' : 'operation_failed';
        throw new PreviewOperationError(kind, `${name}: ${error.code ?? 'ERROR'} ${error.message ?? ''}`.trim(), { tool: name, code: error.code, conflict: error.conflict });
      }
      return result.structuredContent;
    },
  };
};
