import type { ToolAnnotations } from '@modelcontextprotocol/server';
import { SearchApiInput, searchApi } from '../tools/searchApi.js';
import { DescribeSchemaInput, describeSchema } from '../tools/describeSchema.js';
import { ExecuteInput, execute, type RequestCtx } from '../tools/execute.js';
import { zodToJsonSchema } from './zodToJsonSchema.js';
import type { Sdk } from '../sdk/bindings.js';
import type { SandboxRunner } from '../sandbox/types.js';
import type { Corpus } from '../search/corpus.js';
import type { SubjectQuota } from '../util/quotas.js';
import type { ExecutionLimiter } from '../util/executionLimiter.js';

export interface ToolDescriptor {
  name: string;
  title: string;
  description: string;
  annotations: ToolAnnotations;
  inputSchema: Record<string, unknown>;
  /** JSON Schema of the structured result (`structuredContent`). */
  outputSchema: Record<string, unknown>;
  /** `signal` aborts when the client cancels the request or disconnects. */
  handler: (args: unknown, ctx?: { signal?: AbortSignal }) => Promise<unknown>;
  /** True when a returned result is a tool execution failure (MCP `isError`). */
  isFailure?: (result: unknown) => boolean;
}

const ENTRY_SCHEMA = {
  type: 'object',
  properties: {
    id: { type: 'string' }, kind: { type: 'string', enum: ['endpoint', 'field'] }, binding: { type: 'string' },
    description: { type: 'string' }, signature: { type: 'string' }, example: { type: 'string' }, score: { type: 'number' },
  },
  required: ['id', 'kind', 'binding', 'description'],
} as const;

export const OUTPUT_SCHEMAS = {
  search_api: {
    type: 'object',
    properties: { hits: { type: 'array', items: ENTRY_SCHEMA }, note: { type: 'string' } },
    required: ['hits', 'note'],
  },
  describe_schema: {
    type: 'object',
    properties: { found: { type: 'boolean' }, entries: { type: 'array', items: ENTRY_SCHEMA }, message: { type: 'string' } },
    required: ['found'],
  },
  execute: {
    type: 'object',
    properties: {
      ok: { type: 'boolean', description: 'false when the code threw, timed out, or broke a limit; see error' },
      value: { description: 'The JSON value the code returned' },
      logs: { type: 'array', items: { type: 'string' } },
      error: {
        type: 'object',
        properties: { name: { type: 'string' }, message: { type: 'string' }, status: { type: 'number' } },
        required: ['name', 'message'],
      },
      durationMs: { type: 'number' },
    },
    required: ['ok', 'logs', 'durationMs'],
  },
} as const;

export interface CatalogDeps {
  sdk: Sdk;
  sdkForSubject?: (subject?: string) => Promise<Sdk>;
  sandbox: SandboxRunner;
  corpus: Corpus;
  /** Upstream calls one execute may make, per binding. */
  callBudgets: Readonly<Record<string, number>>;
  /** Per-subject hourly quotas by binding (HTTP only; replaced by PostgreSQL limits in account mode). */
  subjectQuotas?: Readonly<Record<string, SubjectQuota>>;
  /** Caps simultaneous executions (global and per subject). */
  executionLimiter?: ExecutionLimiter;
  /** Aborts all executions on shutdown. */
  shutdownSignal?: AbortSignal;
  /** Tools to register; default all three. Account mode's anonymous endpoint omits `execute`. */
  tools?: ReadonlyArray<'search_api' | 'describe_schema' | 'execute'>;
}

export function buildCatalog(deps: CatalogDeps, requestCtx?: RequestCtx): ToolDescriptor[] {
  const all = allTools(deps, requestCtx);
  return deps.tools ? all.filter(t => deps.tools!.includes(t.name as 'execute')) : all;
}

function allTools(deps: CatalogDeps, requestCtx?: RequestCtx): ToolDescriptor[] {
  const names = deps.sdk.registeredNames.join(', ');
  const namespaces = deps.sdk.registeredNames.map(n => `${n}.*`).join(', ');
  return [
    {
      name: 'search_api',
      title: 'Search USPTO API Documentation',
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
      description:
        `BM25 search over the SDK methods and response-field dictionary for all bound sources (${names}): patent applications (file wrapper), PTAB trials/appeals/interferences, petition decisions, office actions, bulk datasets, and trademark status. Returns method signatures and JavaScript examples for use in execute. Start here.`,
      inputSchema: zodToJsonSchema(SearchApiInput),
      outputSchema: OUTPUT_SCHEMAS.search_api,
      handler: async (args) => searchApi(SearchApiInput.parse(args), deps.corpus),
    },
    {
      name: 'describe_schema',
      title: 'Describe USPTO API Schema',
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
      description:
        `Look up an endpoint or field by exact dotted id (path) or by namespace prefix. Use to drill into the bound source surfaces (${namespaces}).`,
      inputSchema: zodToJsonSchema(DescribeSchemaInput, {
        // Exactly one of path / prefix (the handler's refine rule, in JSON Schema form).
        oneOf: [{ required: ['path'], not: { required: ['prefix'] } }, { required: ['prefix'], not: { required: ['path'] } }],
      }),
      outputSchema: OUTPUT_SCHEMAS.describe_schema,
      handler: async (args) => describeSchema(DescribeSchemaInput.parse(args), deps.corpus.entries),
    },
    {
      name: 'execute',
      title: 'Query USPTO Patent and Trademark Data',
      // The sandbox SDK only reads upstream data. Idempotence describes external
      // effects, not identical results; annotations do not enforce permissions.
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
      description:
        `Run JavaScript inside a sandbox (no net, fs, env, or subprocess). Plain JS only — TypeScript type annotations are rejected. Globals: ${names}. Top-level await is allowed; \`return\` the value you want as the result. USPTO serves one request at a time per API key, so calls are queued: prefer one well-filtered search (with \`fields\` to trim large records) over many lookups, and return only what you need.`,
      inputSchema: zodToJsonSchema(ExecuteInput),
      outputSchema: OUTPUT_SCHEMAS.execute,
      handler: async (args, ctx) => execute(ExecuteInput.parse(args), deps, { ...requestCtx, ...(ctx?.signal ? { signal: ctx.signal } : {}) }),
      isFailure: (result) => (result as { ok?: unknown })?.ok === false,
    },
  ];
}
