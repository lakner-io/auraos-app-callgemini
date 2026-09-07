/**
 * Remote MCP → Gemini bridge.
 *
 * Connects to user-configured remote MCP servers (Streamable HTTP or SSE),
 * lists their tools, and exposes them to a Gemini Live session as
 * `functionDeclarations`. When Gemini emits a tool call, `dispatch()` routes it
 * to the owning MCP client and returns a plain `{ result }` / `{ error }` object
 * suitable for `session.sendToolResponse()`.
 *
 * Tools are declared NON_BLOCKING so Gemini keeps the conversation going while a
 * slow tool runs — the behaviour the ADK write-up wanted ("notify the user, then
 * answer when the result lands"), which the Live API supports natively.
 *
 * The price of NON_BLOCKING: Gemini issues dependent calls before the result
 * they need is back, and fills the dependent argument with the *id of the
 * pending call* ("session_id": "function-call-1812…"). `dispatchBatch()` turns
 * those placeholders back into real values — it waits for the referenced call
 * and lifts the field out of its result — so a chain like session_create →
 * navigate → snapshot → release works as the model intended.
 */

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js';

/** Gemini function names must match this; MCP names occasionally don't. */
function sanitizeName(name) {
  const cleaned = String(name).replace(/[^a-zA-Z0-9_.-]/g, '_');
  return /^[a-zA-Z_]/.test(cleaned) ? cleaned : `t_${cleaned}`;
}

/** Keys the Gemini `Schema` type accepts (everything else is rejected with
 * `Invalid JSON payload received. Unknown name "…"` at setup — the Live socket
 * then closes with 1007 before the call starts). */
const GEMINI_SCHEMA_KEYS = new Set([
  'type', 'format', 'title', 'description', 'nullable', 'enum', 'items',
  'properties', 'required', 'propertyOrdering', 'default', 'example', 'anyOf',
  'minItems', 'maxItems', 'minProperties', 'maxProperties', 'minLength',
  'maxLength', 'pattern', 'minimum', 'maximum',
]);

/** `format` values Gemini accepts, per type. Others (`uri`, `email`, …) error. */
const GEMINI_FORMATS = {
  string: new Set(['enum', 'date-time']),
  integer: new Set(['int32', 'int64']),
  number: new Set(['float', 'double']),
};

/**
 * Convert one JSON Schema node (MCP `inputSchema`) to a Gemini `Schema`.
 * MCP servers emit whatever their validator (zod, etc.) produces; Gemini
 * accepts a strict subset and rejects the whole setup on any unknown key, so
 * this is an allow-list, not a deny-list:
 *   • `exclusiveMinimum`/`exclusiveMaximum` → `minimum`/`maximum` (bumped by 1
 *     for integers; a close-enough bound for numbers);
 *   • `const` → single-value `enum`; `oneOf` → `anyOf`;
 *   • `type: ['string','null']` → `type: 'string', nullable: true`;
 *   • unsupported `format`s are dropped, everything unknown is dropped.
 */
function toGeminiSchema(node) {
  if (Array.isArray(node)) return node.map(toGeminiSchema);
  if (!node || typeof node !== 'object') return node;
  const src = { ...node };

  // JSON Schema type unions: Gemini wants a single type + `nullable`.
  if (Array.isArray(src.type)) {
    const nonNull = src.type.filter((t) => t !== 'null');
    if (src.type.length !== nonNull.length) src.nullable = true;
    src.type = nonNull[0];
  }
  if (src.oneOf && !src.anyOf) src.anyOf = src.oneOf;
  if (src.const !== undefined && !src.enum) src.enum = [src.const];
  if (typeof src.exclusiveMinimum === 'number' && src.minimum == null) {
    src.minimum = src.type === 'integer' ? src.exclusiveMinimum + 1 : src.exclusiveMinimum;
  }
  if (typeof src.exclusiveMaximum === 'number' && src.maximum == null) {
    src.maximum = src.type === 'integer' ? src.exclusiveMaximum - 1 : src.exclusiveMaximum;
  }
  if (src.format && !GEMINI_FORMATS[src.type]?.has(src.format)) delete src.format;
  // Gemini's enum is strings-only.
  if (Array.isArray(src.enum)) src.enum = src.enum.map(String);

  const out = {};
  for (const [k, v] of Object.entries(src)) {
    if (!GEMINI_SCHEMA_KEYS.has(k)) continue;
    if (k === 'properties' && v && typeof v === 'object') {
      out.properties = Object.fromEntries(
        Object.entries(v).map(([name, sub]) => [name, toGeminiSchema(sub)]),
      );
    } else if (k === 'items' || k === 'anyOf') {
      out[k] = toGeminiSchema(v);
    } else {
      out[k] = v;
    }
  }
  return out;
}

/**
 * Gemini function `parameters`: a Gemini `Schema` of type object, or
 * `undefined` for a no-arg tool (anything without a usable object schema).
 */
function toParameters(inputSchema) {
  if (!inputSchema || typeof inputSchema !== 'object') return undefined;
  const schema = toGeminiSchema(inputSchema);
  if (schema.type == null && schema.properties == null) return undefined;
  if (schema.type == null) schema.type = 'object';
  // An object with no properties is a no-arg tool; Gemini rejects empty
  // OBJECT schemas ("properties: should be non-empty for OBJECT type").
  if (schema.type === 'object' && !Object.keys(schema.properties ?? {}).length) return undefined;
  return schema;
}

export { toGeminiSchema, toParameters };

/**
 * Keep only the arguments a tool declares. Returns the pruned args and the
 * names that were dropped (empty when the schema declares no properties —
 * then we can't tell and pass everything through).
 */
function pruneArgs(args, properties) {
  const input = args && typeof args === 'object' ? args : {};
  if (!properties || typeof properties !== 'object') return { args: input, ignored: [] };
  const out = {};
  const ignored = [];
  for (const [k, v] of Object.entries(input)) {
    if (Object.prototype.hasOwnProperty.call(properties, k)) out[k] = v;
    else ignored.push(k);
  }
  return { args: out, ignored };
}

/**
 * Fabricated-handle guard.
 *
 * Besides placeholders, the model sometimes *invents* a handle outright: a
 * random UUID as `session_id`, or a `configuration` token it built by base64-
 * encoding its own inputs. The server rejects those, the model "releases" the
 * phantom session (a no-op) and loops. `createSeenValues()` keeps every opaque
 * token that any tool result, typed message or transcript in this call
 * contained; an opaque value in a handle-like argument that never appeared
 * anywhere is refused before the tool runs, with a message telling the model
 * to omit it or fetch it properly.
 *
 * Deliberately narrow so other MCP servers are unaffected: only arguments
 * whose NAME looks like a handle (`*_id`, `token`, `configuration`, …) and
 * whose VALUE looks machine-generated (≥16 chars, letters+digits, no spaces,
 * or a UUID). "PROJ-123", "42", URLs, e-mails and anything a person actually
 * said or typed pass straight through.
 */
const HANDLE_ARG = /(^|_)(id|ids|token|handle|secret|configuration|cursor|session|key)$|Id$|Token$|Handle$|Key$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const OPAQUE_TOKEN = /[A-Za-z0-9_\-+=.]{16,}/g;

function looksOpaque(v) {
  if (typeof v !== 'string' || v.length < 16 || /\s/.test(v)) return false;
  if (UUID.test(v)) return true;
  return /^[A-Za-z0-9_\-+=.]+$/.test(v) && /[A-Za-z]/.test(v) && /[0-9]/.test(v);
}

/** Pull `<name>=<value>` / `<name>: "<value>"` out of a tool's result text. */
function extractField(name, response) {
  const text = response?.result ?? '';
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const m = text.match(new RegExp(escaped + '\\s*[:=]\\s*["\'`]?([A-Za-z0-9_\\-]+)', 'i'));
  return m?.[1] ?? null;
}

export function createSeenValues() {
  const seen = new Set();
  const MAX = 5000;
  /** Recent tool results, newest last — so a refusal can point at the real value. */
  const results = [];
  const RESULTS_MAX = 50;
  return {
    /** Remember every opaque token in a piece of text (tool result, user text). */
    note(text) {
      for (const m of String(text ?? '').match(OPAQUE_TOKEN) ?? []) {
        if (!looksOpaque(m)) continue;
        seen.add(m);
        if (seen.size > MAX) seen.delete(seen.values().next().value);
      }
    },
    /** Remember a tool result (also notes its tokens). */
    noteResult(toolName, text) {
      this.note(text);
      results.push({ toolName, text: String(text ?? '') });
      if (results.length > RESULTS_MAX) results.shift();
    },
    has(v) { return seen.has(v); },
    /** Newest result that literally provides `<argName>=<value>`, if any. */
    provider(argName) {
      for (let i = results.length - 1; i >= 0; i--) {
        const value = extractField(argName, { result: results[i].text });
        if (value) return { toolName: results[i].toolName, value };
      }
      return null;
    },
  };
}

/** Model-readable error if any handle-like argument holds an opaque value
 * that nothing in this call ever produced; null when the args are fine. */
function fabricatedArgError(fc, args, seen) {
  for (const [k, v] of Object.entries(args ?? {})) {
    if (!HANDLE_ARG.test(k) || !looksOpaque(v) || seen.has(v)) continue;
    const known = seen.provider(k);
    return `argument "${k}" = "${String(v).slice(0, 60)}" was never returned by any tool in this conversation, ` +
      'so it looks invented. Never construct ids, tokens or handles yourself. ' +
      (known
        ? `The most recent tool result that provides "${k}" is from ${known.toolName}: ${k} = "${known.value}". Call ${fc.name} again with exactly that value.`
        : `Leave optional arguments out, or first call the tool that provides "${k}" and pass exactly the value it returns.`);
  }
  return null;
}

function makeTransport(server) {
  const url = new URL(server.url);
  const transport = (server.transport ?? 'http').toLowerCase();
  if (transport === 'sse') return new SSEClientTransport(url);
  return new StreamableHTTPClientTransport(url);
}

/**
 * Connectivity check for one server: connect, list its tools, disconnect.
 * Resolves `{ tools: [names] }` or throws with the transport's error. Used
 * before a server is added at runtime, so a wrong URL is refused with the real
 * reason instead of becoming a tool that fails on every call.
 */
export async function probeServer(server, { timeoutMs = 10000 } = {}) {
  const client = new Client({ name: 'callgemini-probe', version: '0.1.0' }, { capabilities: {} });
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`no response within ${timeoutMs / 1000}s`)), timeoutMs);
  });
  try {
    const tools = await Promise.race([
      (async () => {
        await client.connect(makeTransport(server));
        const { tools = [] } = await client.listTools();
        return tools.map((t) => t.name);
      })(),
      timeout,
    ]);
    return { tools };
  } finally {
    clearTimeout(timer);
    client.close().catch(() => {});
  }
}

/**
 * Connect every configured MCP server and build the Gemini tool surface.
 * Returns a handle with the aggregated `functionDeclarations`, a `dispatch`
 * for tool calls, and a `close` for teardown. One server failing to connect is
 * logged and skipped — it never aborts the call.
 *
 * `skipped` (server URLs) is the per-conversation "Skip" toggle: those servers'
 * tools stay declared, but every call to them is answered instantly with a
 * "skipped by the user" error instead of running. It can be swapped at any time
 * via the handle's `setSkipped()` — no reconnect needed.
 *
 * `seen` (from `createSeenValues()`) is the call-wide memory behind the
 * fabricated-handle guard; pass the same one across a tool-change re-dial so
 * handles from before it stay valid.
 *
 * @param {Array<{ url: string, transport?: 'http'|'sse', name?: string }>} servers
 * @param {{ skipped?: Iterable<string>, seen?: ReturnType<typeof createSeenValues> }} [opts]
 */
export async function connectAll(servers = [], { skipped: initialSkipped = [], seen = createSeenValues() } = {}) {
  /** @type {Array<import('@modelcontextprotocol/sdk/client/index.js').Client>} */
  const clients = [];
  /** @type {Map<string, { client: any, toolName: string, properties: object|null, serverUrl: string }>} */
  const routes = new Map();
  const functionDeclarations = [];
  /** Per-server outcome, in config order — surfaced to the UI sidebar. */
  const serverReports = [];
  let skipped = new Set(initialSkipped);

  for (let i = 0; i < servers.length; i++) {
    const server = servers[i];
    if (!server?.url) continue;
    const client = new Client({ name: 'callgemini', version: '0.1.0' }, { capabilities: {} });
    try {
      await client.connect(makeTransport(server));
      const { tools = [] } = await client.listTools();
      clients.push(client);
      for (const tool of tools) {
        // Keep the natural name; on collision across servers, disambiguate.
        let fnName = sanitizeName(tool.name);
        if (routes.has(fnName)) fnName = `s${i}_${fnName}`;
        routes.set(fnName, { client, toolName: tool.name, properties: tool.inputSchema?.properties ?? null, serverUrl: server.url });
        functionDeclarations.push({
          name: fnName,
          description: tool.description ?? tool.title ?? tool.name,
          parameters: toParameters(tool.inputSchema),
          behavior: 'NON_BLOCKING',
        });
      }
      serverReports.push({ url: server.url, ok: true, tools: tools.length });
      console.log(`[callgemini/mcp] connected ${server.url} (${tools.length} tools)`);
    } catch (err) {
      const message = err?.message ?? String(err);
      serverReports.push({ url: server.url, ok: false, tools: 0, error: message });
      console.error(`[callgemini/mcp] failed to connect ${server.url}:`, message);
      try { await client.close(); } catch { /* noop */ }
    }
  }

  /** Calls seen so far, by Gemini function-call id → their (pending) outcome.
   * Bounded; a placeholder only ever points at a recent call. */
  const calls = new Map();
  const CALLS_MAX = 100;
  const PLACEHOLDER = /^function-call-\d+$/;

  /** Replace placeholder args (ids of other calls) with the values those calls
   * returned, waiting for them if needed. Throws a model-readable error when
   * the reference can't be satisfied. */
  async function resolveArgs(fc) {
    const args = { ...(fc.args ?? {}) };
    for (const [k, v] of Object.entries(args)) {
      if (typeof v !== 'string' || !PLACEHOLDER.test(v)) continue;
      const dep = calls.get(v);
      if (!dep) {
        throw new Error(`argument "${k}" is a placeholder ("${v}") for a tool result that is not available. ` +
          `Wait for the real ${k} from the earlier tool result, then call ${fc.name} again with it.`);
      }
      const res = await dep.promise;
      const real = extractField(k, res);
      if (!real) {
        throw new Error(`argument "${k}" referred to the result of ${dep.name}, but that result has no ${k}` +
          (res?.error ? ` (it failed: ${String(res.error).slice(0, 200)})` : '') +
          `. Fix that first, then call ${fc.name} again with a real ${k}.`);
      }
      console.log(`[callgemini/mcp] ${fc.name}.${k}: resolved ${v} → ${real} (from ${dep.name})`);
      args[k] = real;
    }
    return args;
  }

  /** One FIFO per MCP server: browser-style tools (navigate → snapshot →
   * release on one session) are order-sensitive, and Gemini issues them
   * back-to-back under NON_BLOCKING. The conversation stays non-blocking —
   * only the tool executions are serialised. */
  const queues = new Map();
  function enqueue(client, task) {
    const prev = queues.get(client) ?? Promise.resolve();
    const run = prev.then(task, task);
    queues.set(client, run.catch(() => {}));
    return run;
  }

  /** Indices of `fcs` in a safe execution order (see dispatchBatch). */
  function orderByDependency(fcs) {
    const idIndex = new Map(fcs.map((fc, i) => [fc.id, i]).filter(([id]) => id));
    const depsOf = (i) => Object.values(fcs[i].args ?? {})
      .filter((v) => typeof v === 'string' && idIndex.has(v) && idIndex.get(v) !== i)
      .map((v) => idIndex.get(v));
    const order = [];
    const state = new Array(fcs.length).fill(0); // 0 = new, 1 = visiting, 2 = done
    const visit = (i) => {
      if (state[i]) return;      // done, or a cycle — just keep issue order
      state[i] = 1;
      for (const d of depsOf(i)) visit(d);
      state[i] = 2;
      order.push(i);
    };
    for (let i = 0; i < fcs.length; i++) visit(i);
    return order;
  }

  /** Run one Gemini functionCall against its MCP server (args as given). */
  async function dispatch(fc) {
      const route = routes.get(fc.name);
      if (!route) return { error: `unknown tool: ${fc.name}` };
      // The model sometimes invents arguments the tool never declared (e.g.
      // `url`/`goal` on a session-create tool); strict MCP servers then reject
      // the whole call. Drop undeclared keys and say so in the result, so the
      // call succeeds and the model learns which inputs it actually has.
      const { args, ignored } = pruneArgs(fc.args, route.properties);
      // "Skip" toggle: the tool stays declared (no Gemini re-dial), but the
      // user doesn't want it run in this conversation. Answer instantly with
      // an error the model can act on instead of retrying.
      if (skipped.has(route.serverUrl)) {
        let host = route.serverUrl;
        try { host = new URL(route.serverUrl).host; } catch { /* keep raw */ }
        return {
          error: `Skipped: the user has turned off "${route.toolName}" (server ${host}) for this ` +
            'conversation. Do not retry it; tell the user it was skipped and continue without it.',
        };
      }
      try {
        const res = await route.client.callTool({
          name: route.toolName,
          arguments: args,
        });
        let text = (res?.content ?? [])
          .map((c) => (c?.type === 'text' ? c.text : JSON.stringify(c)))
          .join('\n');
        seen.noteResult(route.toolName, text); // handles this result hands out are legitimate from now on
        if (ignored.length) {
          text += `${text ? '\n\n' : ''}(Ignored undeclared argument(s): ${ignored.join(', ')}. ` +
            `This tool only accepts: ${Object.keys(route.properties ?? {}).join(', ') || 'no arguments'}.)`;
        }
        if (res?.isError) return { error: text || 'tool reported an error' };
        return { result: text || 'ok' };
      } catch (err) {
        return { error: err?.message ?? String(err) };
      }
  }

  return {
    functionDeclarations,
    /** `[{ url, ok, tools, error? }]` — one entry per configured server. */
    servers: serverReports,
    dispatch,

    /** Replace the set of skipped server URLs. Takes effect on the next call. */
    setSkipped(urls) {
      skipped = new Set(urls ?? []);
    },

    /**
     * Dispatch a whole `toolCall.functionCalls` batch with placeholder
     * resolution. Every call is registered before any is resolved, so a call
     * may reference another one later in the same batch (or any recent one).
     * @param {Array<{ id?: string, name: string, args?: Record<string, unknown> }>} fcs
     * @returns {Array<Promise<{ result: string } | { error: string }>>}
     */
    dispatchBatch(fcs) {
      const deferreds = fcs.map(() => {
        let resolve;
        const promise = new Promise((r) => { resolve = r; });
        return { promise, resolve };
      });
      fcs.forEach((fc, i) => {
        if (!fc.id) return;
        calls.set(fc.id, { name: fc.name, promise: deferreds[i].promise });
        while (calls.size > CALLS_MAX) calls.delete(calls.keys().next().value);
      });
      // Queue order = issue order, except an in-batch forward reference
      // (call 0 uses call 1's id) is moved behind what it references, so the
      // per-server queue can never wait on something queued after it.
      for (const i of orderByDependency(fcs)) {
        const fc = fcs[i];
        const client = routes.get(fc.name)?.client ?? null;
        enqueue(client, async () => {
          let args;
          try { args = await resolveArgs(fc); } catch (err) { return { error: err.message }; }
          const fabricated = fabricatedArgError(fc, args, seen);
          if (fabricated) return { error: fabricated };
          return dispatch({ ...fc, args });
        }).then(deferreds[i].resolve);
      }
      return deferreds.map((d) => d.promise);
    },

    async close() {
      await Promise.allSettled(clients.map((c) => c.close()));
    },
  };
}
