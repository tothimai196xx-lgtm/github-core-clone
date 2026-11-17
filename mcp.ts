// mcp.ts — Model Context Protocol over Streamable HTTP at POST /mcp. Plain JSON-RPC 2.0
// replies (no SSE). Answers server/discover (modern era), the legacy initialize handshake,
// tools/list (a static, byte-identical list) and tools/call for the six tools the suite
// exercises, all against the same Store the REST and GraphQL layers use.

import {
  resolveBranch,
  VIEWER,
  type Store,
} from './store.ts';
import { handleRest, type RestContext } from './rest.ts';

const SERVER_NAME = 'github-forge-mcp';
const SERVER_VERSION = '1.0.0';
const PROTOCOL_VERSION = '2026-07-28';

interface JsonRpcRequest {
  jsonrpc?: string;
  id?: string | number | null;
  method?: string;
  params?: Record<string, unknown>;
}

function rpcResult(id: string | number | null, result: unknown): Record<string, unknown> {
  return { jsonrpc: '2.0', id, result };
}

function rpcError(id: string | number | null, code: number, message: string): Record<string, unknown> {
  return { jsonrpc: '2.0', id, error: { code, message } };
}

function toolDef(name: string, description: string, properties: Record<string, unknown>, required: string[]): Record<string, unknown> {
  return {
    name,
    description,
    inputSchema: { type: 'object', properties, required },
  };
}

const TOOLS: Array<Record<string, unknown>> = [
  toolDef(
    'create_repo',
    'Create a new repository for the authenticated user.',
    {
      name: { type: 'string', description: 'Repository name' },
      description: { type: 'string', description: 'Repository description' },
      private: { type: 'boolean', description: 'Whether the repository is private' },
    },
    ['name'],
  ),
  toolDef(
    'get_repo',
    'Get a repository by owner and name.',
    {
      owner: { type: 'string', description: 'Repository owner login' },
      repo: { type: 'string', description: 'Repository name' },
    },
    ['owner', 'repo'],
  ),
  toolDef(
    'create_issue',
    'Create an issue in a repository.',
    {
      owner: { type: 'string', description: 'Repository owner login' },
      repo: { type: 'string', description: 'Repository name' },
      title: { type: 'string', description: 'Issue title' },
      body: { type: 'string', description: 'Issue body' },
    },
    ['owner', 'repo', 'title'],
  ),
  toolDef(
    'list_issues',
    'List issues in a repository.',
    {
      owner: { type: 'string', description: 'Repository owner login' },
      repo: { type: 'string', description: 'Repository name' },
      state: { type: 'string', description: 'Issue state: open, closed, or all', enum: ['open', 'closed', 'all'] },
    },
    ['owner', 'repo'],
  ),
  toolDef(
    'create_pull_request',
    'Create a pull request in a repository.',
    {
      owner: { type: 'string', description: 'Repository owner login' },
      repo: { type: 'string', description: 'Repository name' },
      title: { type: 'string', description: 'Pull request title' },
      head: { type: 'string', description: 'Head branch name' },
      base: { type: 'string', description: 'Base branch name' },
      body: { type: 'string', description: 'Pull request body' },
    },
    ['owner', 'repo', 'title', 'head', 'base'],
  ),
  toolDef(
    'merge_pull_request',
    'Merge a pull request in a repository.',
    {
      owner: { type: 'string', description: 'Repository owner login' },
      repo: { type: 'string', description: 'Repository name' },
      pull_number: { type: 'integer', description: 'Pull request number' },
    },
    ['owner', 'repo', 'pull_number'],
  ),
];

function serverInfo(): Record<string, unknown> {
  return { name: SERVER_NAME, version: SERVER_VERSION };
}

/** Run a REST call against the store from inside a tool, reusing the REST handlers. */
function restCall(
  store: Store,
  ctx: Omit<RestContext, 'body' | 'bodyText' | 'authed' | 'requestId'> & { body?: unknown },
  requestId: string,
): { status: number; json: unknown } {
  const result = handleRest(store, {
    ...ctx,
    body: ctx.body,
    bodyText: ctx.body === undefined ? '' : JSON.stringify(ctx.body),
    authed: true,
    requestId,
  });
  let json: unknown = null;
  if (result.body !== '') {
    try {
      json = JSON.parse(result.body);
    } catch {
      json = null;
    }
  }
  return { status: result.status, json };
}

function textResult(value: unknown): Record<string, unknown> {
  const text = typeof value === 'string' ? value : JSON.stringify(value);
  return {
    content: [{ type: 'text', text }],
    structuredContent: typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : { value: text },
    isError: false,
  };
}

function toolError(message: string): Record<string, unknown> {
  return { content: [{ type: 'text', text: message }], isError: true };
}

function missingArgs(params: Record<string, unknown>, required: string[]): string | null {
  for (const key of required) {
    if (params[key] === undefined || params[key] === null || params[key] === '') return key;
  }
  return null;
}

function handleToolsCall(store: Store, name: string, params: Record<string, unknown>, requestId: string): Record<string, unknown> {
  const ctxBase = { method: 'GET', segments: [] as string[], query: new URLSearchParams(), host: 'localhost' };
  switch (name) {
    case 'create_repo': {
      const missing = missingArgs(params, ['name']);
      if (missing !== null) return toolError(`Missing required argument: ${missing}`);
      const { status, json } = restCall(store, {
        ...ctxBase,
        method: 'POST',
        segments: ['user', 'repos'],
        body: { name: params.name, description: params.description, private: params.private === true },
      }, requestId);
      if (status !== 201) return toolError(`Failed to create repository: ${JSON.stringify(json)}`);
      return textResult(json);
    }
    case 'get_repo': {
      const missing = missingArgs(params, ['owner', 'repo']);
      if (missing !== null) return toolError(`Missing required argument: ${missing}`);
      const { status, json } = restCall(store, {
        ...ctxBase,
        method: 'GET',
        segments: ['repos', String(params.owner), String(params.repo)],
      }, requestId);
      if (status !== 200) return toolError(`Repository not found: ${params.owner}/${params.repo}`);
      return textResult(json);
    }
    case 'create_issue': {
      const missing = missingArgs(params, ['owner', 'repo', 'title']);
      if (missing !== null) return toolError(`Missing required argument: ${missing}`);
      const { status, json } = restCall(store, {
        ...ctxBase,
        method: 'POST',
        segments: ['repos', String(params.owner), String(params.repo), 'issues'],
        body: { title: params.title, body: params.body },
      }, requestId);
      if (status !== 201) return toolError(`Failed to create issue: ${JSON.stringify(json)}`);
      return textResult(json);
    }
    case 'list_issues': {
      const missing = missingArgs(params, ['owner', 'repo']);
      if (missing !== null) return toolError(`Missing required argument: ${missing}`);
      const query = new URLSearchParams();
      if (typeof params.state === 'string') query.set('state', params.state);
      const { status, json } = restCall(store, {
        ...ctxBase,
        method: 'GET',
        segments: ['repos', String(params.owner), String(params.repo), 'issues'],
        query,
      }, requestId);
      if (status !== 200) return toolError(`Failed to list issues: ${JSON.stringify(json)}`);
      return textResult(json);
    }
    case 'create_pull_request': {
      const missing = missingArgs(params, ['owner', 'repo', 'title', 'head', 'base']);
      if (missing !== null) return toolError(`Missing required argument: ${missing}`);
      const { status, json } = restCall(store, {
        ...ctxBase,
        method: 'POST',
        segments: ['repos', String(params.owner), String(params.repo), 'pulls'],
        body: { title: params.title, head: params.head, base: params.base, body: params.body },
      }, requestId);
      if (status !== 201) return toolError(`Failed to create pull request: ${JSON.stringify(json)}`);
      return textResult(json);
    }
    case 'merge_pull_request': {
      const missing = missingArgs(params, ['owner', 'repo', 'pull_number']);
      if (missing !== null) return toolError(`Missing required argument: ${missing}`);
      const { status, json } = restCall(store, {
        ...ctxBase,
        method: 'PUT',
        segments: ['repos', String(params.owner), String(params.repo), 'pulls', String(params.pull_number), 'merge'],
        body: {},
      }, requestId);
      if (status !== 200) return toolError(`Failed to merge pull request: ${JSON.stringify(json)}`);
      return textResult(json);
    }
    default:
      return { __rpcError: -32601, __rpcMessage: `Unknown tool: ${name}` };
  }
}

export interface McpContext {
  authed: boolean;
  bodyText: string;
}

export function handleMcp(store: Store, ctx: McpContext): { status: number; body: string } {
  if (!ctx.authed) {
    return {
      status: 401,
      body: `${JSON.stringify(rpcError(null, -32001, 'Unauthorized'))}\n`,
    };
  }
  let request: JsonRpcRequest;
  try {
    request = JSON.parse(ctx.bodyText) as JsonRpcRequest;
  } catch {
    return {
      status: 400,
      body: `${JSON.stringify(rpcError(null, -32700, 'Parse error'))}\n`,
    };
  }
  if (typeof request !== 'object' || request === null || typeof request.method !== 'string') {
    return { status: 400, body: `${JSON.stringify(rpcError(null, -32600, 'Invalid Request'))}\n` };
  }
  const id = request.id ?? null;
  const method = request.method;
  const params = (request.params ?? {}) as Record<string, unknown>;

  // A notification has no id: answer 202 with an empty body.
  if (id === null && method.startsWith('notifications/')) {
    return { status: 202, body: '' };
  }

  if (method === 'server/discover') {
    return {
      status: 200,
      body: `${JSON.stringify(
        rpcResult(id, {
          supportedVersions: ['2026-07-28', '2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'],
          capabilities: { tools: {} },
          serverInfo: serverInfo(),
          _meta: { 'io.modelcontextprotocol/serverInfo': serverInfo() },
        }),
      )}\n`,
    };
  }

  if (method === 'initialize') {
    return {
      status: 200,
      body: `${JSON.stringify(
        rpcResult(id, {
          protocolVersion: PROTOCOL_VERSION,
          capabilities: { tools: {} },
          serverInfo: serverInfo(),
          _meta: { 'io.modelcontextprotocol/serverInfo': serverInfo() },
        }),
      )}\n`,
    };
  }

  if (method === 'tools/list') {
    return { status: 200, body: `${JSON.stringify(rpcResult(id, { tools: TOOLS }))}\n` };
  }

  if (method === 'tools/call') {
    const toolName = typeof params.name === 'string' ? params.name : '';
    const toolArgs = (params.arguments ?? {}) as Record<string, unknown>;
    const known = TOOLS.some((tool) => tool.name === toolName);
    if (!known) {
      return { status: 200, body: `${JSON.stringify(rpcError(id, -32601, `Unknown tool: ${toolName}`))}\n` };
    }
    const requestId = `mcp-${typeof id === 'string' || typeof id === 'number' ? id : '0'}`;
    const result = handleToolsCall(store, toolName, toolArgs, requestId);
    if (typeof result.__rpcError === 'number') {
      return {
        status: 200,
        body: `${JSON.stringify(rpcError(id, result.__rpcError, String(result.__rpcMessage ?? 'Unknown tool')))}\n`,
      };
    }
    return { status: 200, body: `${JSON.stringify(rpcResult(id, result))}\n` };
  }

  if (method === 'ping') {
    return { status: 200, body: `${JSON.stringify(rpcResult(id, {}))}\n` };
  }

  return { status: 200, body: `${JSON.stringify(rpcError(id, -32601, `Method not found: ${method}`))}\n` };
}

export { resolveBranch, VIEWER };
