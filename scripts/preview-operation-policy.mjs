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

/** Each denial returns null when the policy permits, otherwise the reason. `preparation` is the manifest's dataPreparation. */
const actorDenial = (preparation, role) =>
  preparation.operationPolicy?.roleScopes?.[role] && preparation.actors?.[role] ? null : `${role} is not a verification actor of this preview`;

const scopeKeys = { projectId: 'projectIds', workspaceId: 'workspaceIds' };
/** Idempotency and correlation keys name requests, not Entities. */
const nonEntityKeys = new Set(['requestId', 'correlationId']);
const isEntityKey = (key) => /Ids?$/.test(key) && !(key in scopeKeys) && !nonEntityKeys.has(key) && !/principal/i.test(key);
const scopeDenial = (preparation, value) => {
  for (const [key, list] of Object.entries(scopeKeys)) {
    if (value[key] !== undefined && !preparation[list].includes(value[key])) return `${key} ${value[key]} is outside the verification scope`;
  }
  return null;
};

/** Entity IDs referenced by arguments, including nested ones such as deliverables[].repositoryId. */
const entityReferences = (value, found = []) => {
  if (Array.isArray(value)) value.forEach((item) => entityReferences(item, found));
  else if (value && typeof value === 'object') {
    for (const [key, item] of Object.entries(value)) {
      if (isEntityKey(key)) for (const id of [item].flat()) if (typeof id === 'string') found.push({ key, id });
      entityReferences(item, found);
    }
  }
  return found;
};

/**
 * Records Entity IDs from a result inside the verification scope. An object declaring a projectId/workspaceId outside the scope,
 * and everything under it, is not recorded.
 */
const recordEntities = (preparation, known, value) => {
  if (Array.isArray(value)) return value.forEach((item) => recordEntities(preparation, known, item));
  if (!value || typeof value !== 'object' || scopeDenial(preparation, value)) return;
  for (const [key, item] of Object.entries(value)) {
    if (key === 'id' || isEntityKey(key)) for (const id of [item].flat()) if (typeof id === 'string') known.add(id);
    recordEntities(preparation, known, item);
  }
};

/**
 * Every call must target the scope: projectId/workspaceId in the manifest, and each other Entity ID observed inside the scope.
 * `known` holds the Entity IDs observed by this client; an ID it has not observed is treated as outside the scope.
 */
const classificationDenial = (preparation, role, tool) => {
  const policy = preparation.operationPolicy;
  const actor = actorDenial(preparation, role);
  if (actor) return actor;
  const { context, caller } = classifyTool(tool);
  if (!policy.contexts.includes(context) || caller !== policy.caller) {
    return `${tool.name} (context ${context ?? 'none'}, caller ${caller ?? 'none'}) is outside the permitted ${policy.contexts.join('/')} operations`;
  }
  return null;
};

export const policyDenial = (preparation, role, tool, args = {}, known = new Set()) => {
  const classification = classificationDenial(preparation, role, tool);
  if (classification) return classification;
  const scope = scopeDenial(preparation, args);
  if (scope) return scope;
  const references = entityReferences(args);
  const unknown = references.find(({ id }) => !known.has(id));
  if (unknown) return `${unknown.key} ${unknown.id} is not an Entity observed in the verification scope`;
  if (!Object.keys(scopeKeys).some((key) => args[key] !== undefined) && references.length === 0) {
    return `${tool.name} has no projectId, workspaceId or Entity ID that places it in the verification scope`;
  }
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
  const known = new Set();
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
    /** Tools of the current contract whose classification the policy permits for the role, before scope checks on arguments. */
    permittedTools: async (role) => (await listTools(role)).filter((tool) => classificationDenial(preparation, role, tool) === null).map(({ name }) => name),
    /** Records Entities that a Human entry created in a permitted Project/Workspace, e.g. a Repository or a reply message. */
    observe: (scope, value) => {
      const denial = Object.keys(scope).length === 0 || Object.keys(scope).some((key) => !(key in scopeKeys)) ? 'observe requires projectId or workspaceId'
        : scopeDenial(preparation, scope);
      if (denial) throw new PreviewOperationError('policy_denied', denial);
      recordEntities(preparation, known, value);
    },
    /** Calls a tool after checking the current contract and the policy. Adds a requestId when the schema declares one and none is given. */
    call: async (role, name, args = {}) => {
      const tool = (await listTools(role)).find((item) => item.name === name);
      if (!tool) throw new PreviewOperationError('tool_unavailable', `${name} is not in the current tools/list`, { tool: name });
      const denial = policyDenial(preparation, role, tool, args, known);
      if (denial) throw new PreviewOperationError('policy_denied', denial, { tool: name });
      const input = tool.inputSchema?.properties?.requestId && args.requestId === undefined ? { ...args, requestId: crypto.randomUUID() } : args;
      const result = await rpc(role, 'tools/call', { name, arguments: input });
      if (result?.isError) {
        const error = result.structuredContent?.error ?? {};
        const kind = ['FORBIDDEN', 'UNAUTHENTICATED'].includes(error.code) ? 'authorization_denied' : 'operation_failed';
        throw new PreviewOperationError(kind, `${name}: ${error.code ?? 'ERROR'} ${error.message ?? ''}`.trim(), { tool: name, code: error.code, conflict: error.conflict });
      }
      recordEntities(preparation, known, result.structuredContent);
      return result.structuredContent;
    },
  };
};
