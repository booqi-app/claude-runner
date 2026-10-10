/**
 * Claude Agent SDK Bridge Server
 *
 * Embeds a tiny HTTP server that speaks OpenAI chat completions protocol.
 * When OpenClaw sends a request, it invokes the Claude Agent SDK's query()
 * function and translates the streaming messages into SSE chunks.
 *
 * Features:
 *   - Agent SDK (no CLI subprocess, no TUI, no PTY)
 *   - Session reuse via SDK resume
 *   - Request queue with randomized jitter
 *   - Structured streaming via includePartialMessages
 *   - Retry with exponential backoff on transient errors
 *   - AbortController-based cancellation
 */

import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { randomUUID, createHash } from "node:crypto";
import type { query as sdkQuery } from "@anthropic-ai/claude-agent-sdk";
// `.ts`, not `.js`. install.sh ships the TypeScript sources uncompiled, so a
// `./bridge-config.js` specifier resolves only under a loader that rewrites
// the extension. A `.ts` specifier resolves under that loader AND under plain
// `node --test` type stripping, which is what lets test/claude-bridge.test.ts
// import this module at all. booqi-app/infra#202.
import {
  buildQueryOptions,
  chatSessionFromAgentSessionKey,
  examineAffinityHeaders,
  normaliseChatSessionId,
  normaliseSystemPromptMode,
  readContextBar,
  resolveSystemPrompt,
  wrapSystemPromptAsInstructions,
} from "./bridge-config.ts";
import type { AffinityHeaderExamination, BridgeConfig } from "./bridge-config.ts";
export type { AffinityHeaderExamination } from "./bridge-config.ts";

export type { BridgeConfig, McpServerEntry } from "./bridge-config.ts";

/**
 * The Agent SDK's `query()`, resolved lazily.
 *
 * The import above is `import type`, which Node's type stripping erases, so
 * this module no longer pulls the SDK in at load time. That is what lets the
 * hermetic unit suite import it and drive `executeWithRetries` against a fake
 * `query`. It matters: before booqi-app/infra#202's fix round, everything in
 * this file was provable only by regex over its own source text, and three
 * separate reviewers each re-introduced the defect this module exists to fix
 * in a spelling those regexes did not recognise, with the suite green.
 *
 * The production path is unchanged -- the same `query` from the same package,
 * just resolved on first use instead of at import.
 */
export type QueryFn = typeof sdkQuery;

let queryOverride: QueryFn | undefined;

/**
 * Where this module's operational log lines go.
 *
 * `index.ts` owns the extension's logger and this module cannot reach it
 * (it is loaded by the hermetic suite, which has no OpenClaw host), so the
 * default is `console.warn` -- the same default the cell gateway's relay uses
 * -- and `__testing.setLog` replaces it. A line nobody can observe is a line
 * that cannot be asserted, and the one line the session hint emits is an
 * acceptance criterion.
 */
let logOverride: ((message: string) => void) | undefined;

function bridgeLog(message: string): void {
  (logOverride ?? console.warn)(message);
}

/**
 * A sink that forwards at most one message.
 *
 * The session hint emits one line per `buildQueryOptions` call, which is the
 * right contract for that function -- but a request may call it several times,
 * because each retry attempt builds its own options. "Logged once" has to mean
 * once per REQUEST: a count that moves with the retry policy cannot be used to
 * tell "this request had no chat session" from "this request had no chat
 * session and the SDK was flaky".
 */
function onceOnly(sink: (message: string) => void): (message: string) => void {
  let used = false;
  return (message) => {
    if (used) return;
    used = true;
    sink(message);
  };
}

async function getQuery(): Promise<QueryFn> {
  if (queryOverride) return queryOverride;
  return (await import("@anthropic-ai/claude-agent-sdk")).query;
}
const MAX_RETRIES = 2;
const RETRY_DELAYS = [1000, 2000];

// Track active queries for cancellation
const activeQueries = new Map<string, AbortController>();

// ── Session Store ───────────────────────────────────────────────────

interface ContextUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadInputTokens: number;
  cacheCreationInputTokens: number;
  contextWindow: number;
  totalTokens: number;
  fillPercent: number;
  costUsd: number;
}

interface SessionEntry {
  claudeSessionId: string;
  lastUsed: number;
  turnCount: number;
  contextUsage?: ContextUsage;
  /** Compacted summary injected into new sessions after rotation */
  compactSummary?: string;
}

const COMPACT_FILL_THRESHOLD = 0.75;

class SessionStore {
  private sessions = new Map<string, SessionEntry>();
  private readonly ttlMs: number;

  constructor(ttlMs = 3_600_000) {
    this.ttlMs = ttlMs;
  }

  get(conversationId: string): SessionEntry | undefined {
    const entry = this.sessions.get(conversationId);
    if (!entry) return undefined;
    if (Date.now() - entry.lastUsed > this.ttlMs) {
      this.sessions.delete(conversationId);
      return undefined;
    }
    // Touch on read to prevent premature TTL expiry
    entry.lastUsed = Date.now();
    return entry;
  }

  getSessionId(conversationId: string): string | undefined {
    return this.get(conversationId)?.claudeSessionId;
  }

  record(conversationId: string, claudeSessionId: string): void {
    const existing = this.sessions.get(conversationId);
    this.sessions.set(conversationId, {
      claudeSessionId,
      lastUsed: Date.now(),
      turnCount: (existing?.turnCount ?? 0) + 1,
      contextUsage: existing?.contextUsage,
      compactSummary: existing?.compactSummary,
    });
  }

  updateContextUsage(conversationId: string, usage: ContextUsage): void {
    const entry = this.sessions.get(conversationId);
    if (entry) {
      entry.contextUsage = usage;
    }
  }

  /** Mark session as needing rotation — store summary for next request */
  setCompactSummary(conversationId: string, summary: string): void {
    const entry = this.sessions.get(conversationId);
    if (entry) {
      entry.compactSummary = summary;
    }
  }

  /** Consume and clear the compact summary (used when starting a new session) */
  consumeCompactSummary(conversationId: string): string | undefined {
    const entry = this.sessions.get(conversationId);
    if (!entry?.compactSummary) return undefined;
    const summary = entry.compactSummary;
    entry.compactSummary = undefined;
    return summary;
  }

  /** Reset session for compaction — clears the SDK session ID so next request starts fresh */
  rotateSession(conversationId: string, summary: string): void {
    const entry = this.sessions.get(conversationId);
    if (entry) {
      entry.compactSummary = summary;
      entry.claudeSessionId = ''; // Force new session on next request
      entry.contextUsage = undefined;
      entry.turnCount = 0;
    }
  }

  needsCompaction(conversationId: string): boolean {
    const entry = this.sessions.get(conversationId);
    if (!entry?.contextUsage) return false;
    return entry.contextUsage.fillPercent >= COMPACT_FILL_THRESHOLD;
  }

  getContextInfo(conversationId: string): ContextUsage | undefined {
    return this.get(conversationId)?.contextUsage;
  }

  getAllSessions(): Array<{ conversationId: string; entry: SessionEntry }> {
    const result: Array<{ conversationId: string; entry: SessionEntry }> = [];
    for (const [conversationId, entry] of this.sessions) {
      if (Date.now() - entry.lastUsed <= this.ttlMs) {
        result.push({ conversationId, entry });
      }
    }
    return result;
  }

  clear(): void {
    this.sessions.clear();
  }
}

// ── Request Queue ───────────────────────────────────────────────────

class RequestQueue {
  private queue: Array<{
    execute: () => Promise<void>;
    resolve: () => void;
    reject: (err: Error) => void;
    enqueued: number;
  }> = [];
  private active = 0;
  private readonly maxConcurrency: number;
  private readonly minDelayMs: number;
  private readonly maxDelayMs: number;
  private readonly queueTimeoutMs: number;
  private lastSpawnTime = 0;

  constructor(maxConcurrency = 1, minDelayMs = 1000, maxDelayMs = 4000, queueTimeoutMs = 60_000) {
    this.maxConcurrency = maxConcurrency;
    this.minDelayMs = minDelayMs;
    this.maxDelayMs = maxDelayMs;
    this.queueTimeoutMs = queueTimeoutMs;
  }

  enqueue(fn: () => Promise<void>): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      this.queue.push({ execute: fn, resolve, reject, enqueued: Date.now() });
      this.drain();
    });
  }

  private async drain(): Promise<void> {
    if (this.active >= this.maxConcurrency || this.queue.length === 0) return;

    const item = this.queue.shift()!;

    if (Date.now() - item.enqueued > this.queueTimeoutMs) {
      item.reject(new Error("Request timed out in queue"));
      this.drain();
      return;
    }

    this.active++;

    const elapsed = Date.now() - this.lastSpawnTime;
    const jitter = this.minDelayMs + Math.random() * (this.maxDelayMs - this.minDelayMs);
    const wait = Math.max(0, jitter - elapsed);
    if (wait > 0) {
      await new Promise((r) => setTimeout(r, wait));
    }

    this.lastSpawnTime = Date.now();

    try {
      await item.execute();
      item.resolve();
    } catch (err: any) {
      item.reject(err);
    } finally {
      this.active--;
      this.drain();
    }
  }
}

// ── Module-level instances ──────────────────────────────────────────

let sessionStore: SessionStore;
let requestQueue: RequestQueue;

// ── Transient error detection ───────────────────────────────────────

const TRANSIENT_PATTERNS = [
  /ECONNRESET/i,
  /ETIMEDOUT/i,
  /socket hang up/i,
  /503/,
  /529/,
  /rate.?limit/i,
  /overloaded/i,
  /too many requests/i,
];

function isTransientError(message: string): boolean {
  return TRANSIENT_PATTERNS.some((p) => p.test(message));
}

// ── Message extraction ──────────────────────────────────────────────

function flattenContent(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((part: any) => {
        if (typeof part === "string") return part;
        if (part?.type === "text" && typeof part.text === "string") return part.text;
        return "";
      })
      .filter(Boolean)
      .join("\n");
  }
  if (content == null) return "";
  return String(content);
}

const PROMPT_HISTORY_MAX_MESSAGES = 24;
const PROMPT_HISTORY_MAX_CHARS = 48_000;

function formatRoleLabel(role: string): string {
  switch (role) {
    case "user":
      return "User";
    case "assistant":
      return "Assistant";
    case "tool":
      return "Tool";
    case "system":
      return "System";
    default:
      return role[0]?.toUpperCase() + role.slice(1);
  }
}

function trimPromptHistory(text: string, maxChars = PROMPT_HISTORY_MAX_CHARS): string {
  if (text.length <= maxChars) return text;
  return `[Earlier conversation truncated]\n\n${text.slice(-maxChars)}`;
}

function extractPromptFromMessages(messages: Array<{ role: string; content: unknown }>): string {
  // Only send the latest user message — the SDK manages conversation
  // history internally via session resume. Sending the full history
  // as a giant prompt triggers Anthropic's third-party detection.
  const userMsgs = messages.filter((m) => m.role === "user");
  if (userMsgs.length === 0) return "";
  return flattenContent(userMsgs[userMsgs.length - 1].content);
}

function extractSystemPrompt(messages: Array<{ role: string; content: unknown }>): string | undefined {
  const systemMsgs = messages.filter((m) => m.role === "system");
  if (systemMsgs.length === 0) return undefined;
  const full = systemMsgs.map((m) => flattenContent(m.content)).filter(Boolean).join("\n\n");
  return full || undefined;
}

// ── Session resolution ──────────────────────────────────────────────

/**
 * Derive a stable conversation ID from the messages array.
 * Hashes the role sequence + all user message content so that
 * different conversations with the same opening message don't collide.
 */
function deriveConversationIdFromMessages(messages: Array<{ role: string; content: unknown }>): string {
  if (messages.length === 0) return "default";
  const fingerprint = messages
    .map((m, i) => {
      const text = m.role === "user" ? flattenContent(m.content).slice(0, 200) : "";
      return `${i}:${m.role}:${text}`;
    })
    .join("|");
  const hash = createHash("sha256").update(fingerprint).digest("hex").slice(0, 16);
  return `derived-${hash}`;
}

/**
 * Header a caller uses to name the chat session a request belongs to.
 *
 * The same name the cell gateway's relay reads
 * (`apps/cell/src/mcp-relay.ts`: `CHAT_SESSION_HEADER = "x-booqi-chat-session"`),
 * so the two ends of the hint are spelled identically and a reader of either
 * finds the other.
 */
const CHAT_SESSION_HEADER = "x-booqi-chat-session";

/**
 * The headers OpenClaw's OpenAI-compatible provider actually sends.
 *
 * MEASURED 2026-10-04 in the running reference cell (OpenClaw
 * 2026.7.1-beta.5), `@openclaw/ai/src/providers/openai-completions.ts:620`:
 * all three are set to the same `options.sessionId`, gated on
 * `compat.sendSessionAffinityHeaders` (default `false` for this provider, so
 * the cell's model entry must opt in).
 *
 * They are read through `chatSessionFromAgentSessionKey`, never directly. That
 * classifier admits TWO shapes and nothing else: the cell's keyed form
 * `agent:<agentId>:<chatSessionId>`, which it unwraps, and a bare OpenClaw
 * session RECORD id -- a uuid -- which it takes verbatim. The second was
 * REFUSED until infra#327 S4, and the refusal was correct for as long as
 * `apps/cell`'s relay had nothing to resolve a uuid against; booqi-app/app#615
 * gave it an alias table, so the uuid now names something the relay can route
 * on. Anything that is neither shape is still refused.
 */
export const SESSION_AFFINITY_HEADERS = ["session_id", "x-client-request-id", "x-session-affinity"] as const;

/**
 * What the session-affinity headers carried, per name, plus the winner.
 *
 * First header that unwraps wins -- unchanged. All three carry the same value
 * in the measured host, so the order is only a tie-break for a host that
 * diverges.
 *
 * Every name is examined even once one has been accepted. That costs three
 * regex runs and buys the only thing that makes the hintless log line
 * readable: whether a name was ABSENT (the host sends nothing -- the remedy is
 * route A, `compat.sendSessionAffinityHeaders`) or present-but-refused (the
 * host sends something we reject -- the remedy is the rule). Before this, both
 * produced the identical line and the two were indistinguishable.
 */
export function examineAffinityChatSession(req: IncomingMessage): {
  chatSessionId: string | undefined;
  examined: AffinityHeaderExamination[];
} {
  const headers = req.headers as unknown as Record<string, unknown>;
  const examined = examineAffinityHeaders(SESSION_AFFINITY_HEADERS, headers);
  let chatSessionId: string | undefined;
  for (const entry of examined) {
    if (entry.verdict.kind !== "accepted") continue;
    // Re-derive the value from the header rather than carrying it on the
    // verdict: the verdict is a logged object and must never hold the
    // identifier. `examineAffinityHeaders` and `chatSessionFromAgentSessionKey`
    // are projections of the same classifier, so this cannot disagree.
    chatSessionId = chatSessionFromAgentSessionKey(headers[entry.header]);
    if (chatSessionId !== undefined) break;
  }
  return { chatSessionId, examined };
}

/** A request's conversation key, and whether anyone but us named it. */
export interface ResolvedConversation {
  /** The session-store key. Always a string, derived if nothing named one. */
  conversationId: string;
  /**
   * The chat session a CALLER named, or `undefined`.
   *
   * `undefined` is a third state and is kept distinct on purpose: it is not
   * "the default session", it is "nobody said". `conversationId` always has a
   * value because the session store needs a key, and reusing it as the chat
   * session would hand the cell gateway a bridge-invented string -- `"default"`
   * for an empty message list, `derived-<hash>` otherwise -- as a tenant
   * routing key. That is the fail-open form of this feature.
   */
  chatSessionId: string | undefined;
  /**
   * The per-header verdicts on the session-affinity headers.
   *
   * Always `SESSION_AFFINITY_HEADERS.length` long, including when a
   * non-affinity channel named the session: "the affinity headers were absent
   * anyway" is itself the measurement this field exists to carry.
   */
  affinityHeaders: AffinityHeaderExamination[];
}

/**
 * MEASURED, 2026-10-04, on the dev host, inside the RUNNING reference cell
 * `/opt/booqi/cells/demo-boekhouding/` (booqi-app/infra#327 item 1).
 *
 * This supersedes the note that stood here from 2026-10-01, which said the
 * OpenClaw host sends no session identifier to an OpenAI-compatible provider.
 * That note was wrong, and wrong in a way that mattered: it searched for
 * `x-session-id`, `x-conversation-id` and `conversation_id`, and the host uses
 * none of those three spellings. OpenClaw 2026.7.1-beta.5 does send one --
 * `@openclaw/ai/src/providers/openai-completions.ts:620-623` sets `session_id`,
 * `x-client-request-id` and `x-session-affinity`, all to `options.sessionId`,
 * behind `compat.sendSessionAffinityHeaders` (line 1389: default `false` for
 * this provider, so the cell's model entry has to ask for it).
 *
 * TWO things therefore have to be true before a hint is written, and only the
 * first of them lives in this repository:
 *
 *  1. this function reads the names the host really uses -- it now does; and
 *  2. the value on those headers names something `apps/cell` can resolve.
 *
 * BOTH ARE NOW TRUE, and (2) was made true in the OTHER direction from the one
 * this block originally foresaw. It expected the host to start sending the
 * cell's `sessionKey`; what landed instead is that the cell learned to resolve
 * what the host already sends. See below.
 *
 * On (2) the measurement is that the host keys agent runs by that string but
 * stores them under a uuid: `agents/boekhouder/sessions/sessions.json` maps
 * `"agent:boekhouder:<chatSessionId>" -> { sessionId: "<uuid>" }`, and the
 * provider call site reads `ctx.params.session.id`. So the headers carry the
 * UUID, not the key.
 *
 * THIS BLOCK USED TO SAY THAT THE REFUSAL OF THAT UUID WAS "THE LOAD-BEARING
 * HALF OF THIS CHANGE". IT NO LONGER IS, AND THE SENTENCE IS REPLACED RATHER
 * THAN LEFT TO MISLEAD THE NEXT READER (review MINOR, b1006-2 loop A). What
 * made the refusal right was a property of the OTHER repository:
 * `apps/cell/src/mcp-relay.ts` logged `bound: hint !== null` while resolving
 * backends through `connectionByChatSession`, which only ever held
 * control-plane chat session ids -- so a uuid in `?session=` bought a
 * `bound: true` log line over a `tenant_unavailable` answer, a false green on
 * exactly the signal infra#327 is diagnosed from.
 *
 * booqi-app/app#615 (MERGED, on `app` main) removed that property: the relay
 * now registers the host session uuid as an ALIAS for the exchange it belongs
 * to (`chatSessionByHostSession`), authored by the cell from `sessions.describe`
 * rather than guessed. The uuid therefore NAMES an exchange, and infra#327 S4
 * relaxed `chatSessionFromAgentSessionKey` to accept it -- strictly narrower
 * than `chatSessionIdSchema`, because a uuid is schema-legal and deferring to
 * the schema would accept arbitrary junk as a routing key.
 *
 * What remains fail-closed is everything else: a value that is neither the
 * keyed form nor uuid-shaped still yields `undefined` and one log line saying
 * so, the same branch a hintless request takes (`tools/list` -> `{tools: []}`).
 * An alias is a LOOKUP, never an authorisation: a uuid-shaped value that no
 * alias knows still serves nothing, which is `app#609` honoured structurally.
 */
export function resolveConversation(
  req: IncomingMessage,
  body: Record<string, any>,
): ResolvedConversation {
  // A caller that names the chat session outright wins: that is an explicit
  // statement of intent, while an affinity header is a side effect of how the
  // host happens to key its agent runs.
  //
  // Each candidate is normalised INDIVIDUALLY. Normalising one `||` chain was a
  // defect (review round 1, MAJOR): `||` short-circuits on the first TRUTHY
  // value while `normaliseChatSessionId` then rejects whitespace, so a blank
  // `x-booqi-chat-session` -- or a non-string truthy `conversation_id` -- ended
  // the search and collapsed the whole chain to `undefined`, skipping a valid
  // later channel. Before the affinity headers below existed that only lost the
  // hint, which is fail-closed; with them it handed the request to a DIFFERENT
  // chat session, which is not.
  // Examined unconditionally, BEFORE the `??` chain, because the chain
  // short-circuits: when an earlier channel names the session the affinity
  // headers are never looked at, and "not looked at" would then be reported as
  // if it were a finding. The examination has no side effects.
  const affinity = examineAffinityChatSession(req);
  const named =
    normaliseChatSessionId(req.headers[CHAT_SESSION_HEADER]) ??
    normaliseChatSessionId(req.headers["x-session-id"]) ??
    normaliseChatSessionId(req.headers["x-conversation-id"]) ??
    normaliseChatSessionId(body.conversation_id) ??
    normaliseChatSessionId(body.metadata?.conversation_id) ??
    affinity.chatSessionId;

  return {
    conversationId: named ?? deriveConversationIdFromMessages(body.messages ?? []),
    chatSessionId: named,
    affinityHeaders: affinity.examined,
  };
}

// ── Request handler ─────────────────────────────────────────────────

async function handleCompletions(
  req: IncomingMessage,
  res: ServerResponse,
  config: BridgeConfig,
): Promise<void> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(chunk as Buffer);
  }
  let body: Record<string, any>;
  try {
    body = JSON.parse(Buffer.concat(chunks).toString());
  } catch {
    res.writeHead(400, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: { message: "Invalid JSON body", type: "invalid_request_error" } }));
    return;
  }

  const messages: Array<{ role: string; content: string }> = body.messages ?? [];
  const stream = body.stream !== false;
  const model = body.model?.replace(/^claude-runner\//, "") ?? "claude-opus-4-5";
  const requestId = `req-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

  const prompt = extractPromptFromMessages(messages);
  const systemPrompt = extractSystemPrompt(messages);
  const { conversationId, chatSessionId, affinityHeaders } = resolveConversation(req, body);

  if (!prompt) {
    res.writeHead(400, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: { message: "No user message found", type: "invalid_request_error" } }));
    return;
  }

  try {
    await requestQueue.enqueue(async () => {
      await executeWithRetries(
        prompt, model, systemPrompt, conversationId, stream, res, requestId, config, chatSessionId,
        affinityHeaders,
      );
    });
  } catch (err: any) {
    if (!res.headersSent) {
      const status = err.message?.includes("timed out in queue") ? 503 : 502;
      res.writeHead(status, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: { message: err.message || "Request failed", type: "server_error" } }));
    }
  }
}

export async function executeWithRetries(
  prompt: string,
  model: string,
  systemPrompt: string | undefined,
  conversationId: string,
  stream: boolean,
  res: ServerResponse,
  requestId: string,
  config: BridgeConfig,
  /**
   * The chat session a caller named, or `undefined` when nobody did.
   *
   * Separate from `conversationId` on purpose; see `ResolvedConversation`.
   */
  chatSessionId?: string,
  /**
   * The per-header affinity verdicts, for the one log line. Defaulted so the
   * unit suite's existing direct callers keep compiling. An empty report is
   * rendered as an explicit `UNAVAILABLE` marker -- deliberately NOT as the
   * pre-S1 string, so a missing report cannot impersonate an undeployed
   * build -- and never as a fabricated `ABSENT`.
   */
  affinityHeaders: readonly AffinityHeaderExamination[] = [],
): Promise<void> {
  const maxRetries = config.maxRetries ?? MAX_RETRIES;
  let lastError = "";

  // One line per request about the session hint, across every attempt.
  const hintLog = onceOnly(bridgeLog);

  // Resolve session — derive stable ID if gateway doesn't send one
  let resumeSessionId: string | undefined;
  let newSessionId: string | undefined;

  const entry = sessionStore.get(conversationId);
  if (entry?.claudeSessionId) {
    resumeSessionId = entry.claudeSessionId;
  } else {
    newSessionId = randomUUID();
  }
  // Consume any pending compact summary. It is put back below if no attempt
  // ever delivered it: consumption happens here, outside the retry loop, so
  // without the restore a request that then fails non-transiently would clear
  // the summary from the store and lose the rotated-away conversation for
  // good. See booqi-app/infra#202.
  const compactSummary = sessionStore.consumeCompactSummary(conversationId);
  let summaryDelivered = false;

  try {
    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      if (attempt > 0) {
        const delay = RETRY_DELAYS[attempt - 1] ?? 2000;
        await new Promise((r) => setTimeout(r, delay));
      }

      try {
        // In `"replace"` mode the system prompt goes out as an OPTION on
        // EVERY turn, resumed or not. The CLI rebuilds it from the current
        // query options each time; `--resume` replays the transcript, not the
        // prompt. Omitting it on a resumed turn therefore does not inherit it,
        // it sends an empty one, and the agent's persona flips silently after
        // turn 1. The rule lives in resolveSystemPrompt so that it is testable
        // without the SDK -- this module imports the SDK at the top level and
        // the hermetic unit suite cannot load it. booqi-app/infra#202.
        let effectiveSystemPrompt = resolveSystemPrompt(systemPrompt, compactSummary, resumeSessionId);
        let effectivePrompt = prompt;

        // `"append"` mode inverts that, and the reasoning above does not carry
        // over: there is no usable system-prompt option on this SDK (see
        // `BridgeConfig.systemPromptMode` for the measurements), so the prompt
        // is delivered as CONTENT on the first turn and the SDK's own transcript
        // carries it from then on. Because `--resume` replays that transcript,
        // resending it would duplicate it on every turn -- the same reasoning
        // that keeps a consumed compaction summary from being replayed. No
        // system-prompt option is set in either case. booqi-app/infra#333.
        if (normaliseSystemPromptMode(config.systemPromptMode) === "append" && effectiveSystemPrompt) {
          // Gate on DELIVERY, not on `!resumeSessionId` alone.
          //
          // A pending compaction summary MUST go out even on a resumed turn.
          // `resolveSystemPrompt` folds the summary into `effectiveSystemPrompt`
          // regardless of the resume id (it `void`s that argument), and the
          // summary has already been CONSUMED from the store by this point. So
          // a resumed turn that skipped the block sent the summary nowhere --
          // no instructions block and, two lines below, no system-prompt option
          // either -- while success still set `summaryDelivered = true`, which
          // suppresses the `finally` restore. The only record of a rotated-away
          // conversation was then gone for good.
          //
          // That state is reachable: `rotateSession` clears `claudeSessionId`,
          // but the restore path calls `setCompactSummary`, which does NOT, so a
          // pending summary can coexist with a live resumable id. Measured
          // before this fix: in `"append"` mode such a turn dispatched exactly
          // `"hello"` with no `systemPrompt` key, where `"replace"` on the same
          // path dispatched the summary in the option.
          //
          // Re-sending the instructions costs one duplicated system prompt in
          // the transcript, on the rare turn where a summary is pending. Losing
          // the summary costs the conversation. booqi-app/infra#333.
          if (!resumeSessionId || compactSummary) {
            effectivePrompt = wrapSystemPromptAsInstructions(effectiveSystemPrompt, prompt);
          }
          effectiveSystemPrompt = undefined;
        }

        if (stream) {
          await handleStreamingResponse(
            effectivePrompt, model, effectiveSystemPrompt, resumeSessionId, newSessionId, conversationId,
            res, requestId, config, chatSessionId, hintLog, affinityHeaders,
          );
        } else {
          await handleNonStreamingResponse(
            effectivePrompt, model, effectiveSystemPrompt, resumeSessionId, newSessionId, conversationId,
            res, requestId, config, chatSessionId, hintLog, affinityHeaders,
          );
        }
        summaryDelivered = true;
        return;
      } catch (err: any) {
        lastError = err.message ?? String(err);

        if (res.headersSent) {
          // Output already reached the client, so the SDK query ran with this
          // summary in its prompt. Replaying it next turn would duplicate it.
          summaryDelivered = true;
          return;
        }

        // Stale session — retry with fresh.
        //
        // The error text is read with the session hint REMOVED first. Since
        // this bridge writes `?session=<id>` into the `mcpServers` URL it
        // hands the SDK, and an MCP transport error routinely quotes the URL
        // it failed to reach, the bare /session/i below would otherwise read
        // the bridge's OWN hint as evidence that the SDK session is stale --
        // and the branch it guards drops `resumeSessionId`, mints a new id and
        // OVERWRITES the store, i.e. it discards the user's conversation. The
        // regex itself is left as it was: narrowing it would risk missing a
        // genuine stale-session text, and the defect is the new collision, not
        // the breadth. booqi-app/app#459 part C.
        const errorWithoutHint = lastError.replace(/[?&]session=[^&\s"'\\]*/gi, "");
        if (resumeSessionId && /no conversation found|session/i.test(errorWithoutHint)) {
          resumeSessionId = undefined;
          newSessionId = randomUUID();
          sessionStore.record(conversationId, newSessionId);
          continue;
        }

        if (!isTransientError(lastError)) {
          break;
        }
      }
    }

    if (!res.headersSent) {
      res.writeHead(502, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: { message: lastError || "SDK query failed after retries", type: "server_error" } }));
    }
  } finally {
    // Put the summary back unless it was delivered. `consumeCompactSummary`
    // clears it from the store before the first attempt, so without this a
    // request that then fails non-transiently -- one `break` away, below --
    // would drop the only record of the rotated-away conversation. Retries
    // are unaffected: they reuse the local `compactSummary`.
    //
    // This condition deliberately does NOT read `res.headersSent`. The 502
    // above is written INSIDE the try, and `writeHead` flips `headersSent`
    // synchronously, so by the time this runs it is already `true` on exactly
    // the failure path the restore exists for -- which made the first version
    // of this block dead code. `summaryDelivered` is set at each point where
    // the summary actually reached the SDK, and nowhere else.
    //
    // Only restore when the store has no summary: a compaction that ran during
    // this request may have written a newer one, which must not be clobbered.
    if (compactSummary && !summaryDelivered
        && !sessionStore.get(conversationId)?.compactSummary) {
      sessionStore.setCompactSummary(conversationId, compactSummary);
    }
  }
}

// ── Streaming response ──────────────────────────────────────────────

async function handleStreamingResponse(
  prompt: string,
  model: string,
  systemPrompt: string | undefined,
  resumeSessionId: string | undefined,
  newSessionId: string | undefined,
  conversationId: string,
  res: ServerResponse,
  requestId: string,
  config: BridgeConfig,
  chatSessionId: string | undefined,
  hintLog: (message: string) => void,
  affinityHeaders: readonly AffinityHeaderExamination[],
): Promise<void> {
  const abortController = new AbortController();
  const options = buildQueryOptions(
    model, systemPrompt, resumeSessionId, newSessionId, config, abortController,
    { chatSessionId, affinityHeaders, log: hintLog },
  );

  const q = (await getQuery())({ prompt, options });
  activeQueries.set(requestId, abortController);

  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
  });

  const sendSSE = (data: object) => {
    res.write(`data: ${JSON.stringify(data)}\n\n`);
  };

  // Initial role chunk
  sendSSE({
    id: requestId,
    object: "chat.completion.chunk",
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [{ index: 0, delta: { role: "assistant", content: "" }, finish_reason: null }],
  });

  let resultText = "";
  let streamedDelta = false;

  try {
    for await (const msg of q) {
      // Token-level streaming deltas
      if (msg.type === "stream_event") {
        const event = (msg as any).event;
        if (event?.type === "content_block_delta" && event.delta?.type === "text_delta" && event.delta.text) {
          streamedDelta = true;
          sendSSE({
            id: requestId,
            object: "chat.completion.chunk",
            created: Math.floor(Date.now() / 1000),
            model,
            choices: [{ index: 0, delta: { content: event.delta.text }, finish_reason: null }],
          });
        }
      }

      // Full assistant message (fallback)
      if (msg.type === "assistant") {
        const content = (msg as any).message?.content;
        if (Array.isArray(content)) {
          for (const block of content) {
            if (block.type === "text" && block.text && !streamedDelta) {
              resultText = block.text;
            }
          }
        }
      }

      // Result — session ID, completion, and context usage
      if (msg.type === "result") {
        const result = msg as any;
        if (result.session_id) {
          sessionStore.record(conversationId, result.session_id);
        }
        if (result.subtype === "success" && result.result && !streamedDelta) {
          resultText = result.result;
        }

        // Extract context usage from SDK result
        if (result.modelUsage) {
          const usage = extractContextUsage(result.modelUsage);
          if (usage) {
            sessionStore.updateContextUsage(conversationId, usage);

            // Check if compaction is needed
            if (sessionStore.needsCompaction(conversationId)) {
              scheduleCompaction(conversationId, result.result ?? resultText);
            }
          }
        }
      }
    }
  } catch (err: any) {
    if (!res.writableEnded) {
      sendSSE({
        id: requestId,
        object: "chat.completion.chunk",
        created: Math.floor(Date.now() / 1000),
        model,
        choices: [{ index: 0, delta: { content: `\n\nError: ${err.message}` }, finish_reason: "stop" }],
      });
    }
  } finally {
    activeQueries.delete(requestId);
  }

  if (!res.writableEnded) {
    // Fallback: send result as one chunk if no streaming deltas came through
    if (resultText && !streamedDelta) {
      sendSSE({
        id: requestId,
        object: "chat.completion.chunk",
        created: Math.floor(Date.now() / 1000),
        model,
        choices: [{ index: 0, delta: { content: resultText }, finish_reason: null }],
      });
    }

    // Append context status bar as final text delta -- unless configuration
    // switched it off (`contextBar: false`, booqi-app/infra#363).
    if (readContextBar(config.contextBar)) {
      const contextBar = buildContextBar(conversationId);
      sendSSE({
        id: requestId,
        object: "chat.completion.chunk",
        created: Math.floor(Date.now() / 1000),
        model,
        choices: [{ index: 0, delta: { content: contextBar }, finish_reason: null }],
      });
    }

    // Include context usage in the final SSE chunk
    const contextInfo = sessionStore.getContextInfo(conversationId);

    sendSSE({
      id: requestId,
      object: "chat.completion.chunk",
      created: Math.floor(Date.now() / 1000),
      model,
      choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
      ...(contextInfo ? {
        usage: {
          prompt_tokens: contextInfo.inputTokens,
          completion_tokens: contextInfo.outputTokens,
          total_tokens: contextInfo.totalTokens,
        },
        context: {
          fill_percent: contextInfo.fillPercent,
          context_window: contextInfo.contextWindow,
          total_tokens: contextInfo.totalTokens,
        },
      } : {}),
    });
    res.write("data: [DONE]\n\n");
    res.end();
  }
}

// ── Non-streaming response ──────────────────────────────────────────

async function handleNonStreamingResponse(
  prompt: string,
  model: string,
  systemPrompt: string | undefined,
  resumeSessionId: string | undefined,
  newSessionId: string | undefined,
  conversationId: string,
  res: ServerResponse,
  requestId: string,
  config: BridgeConfig,
  chatSessionId: string | undefined,
  hintLog: (message: string) => void,
  affinityHeaders: readonly AffinityHeaderExamination[],
): Promise<void> {
  const abortController = new AbortController();
  const options = buildQueryOptions(
    model, systemPrompt, resumeSessionId, newSessionId, config, abortController,
    { chatSessionId, affinityHeaders, log: hintLog },
  );

  const q = (await getQuery())({ prompt, options });
  activeQueries.set(requestId, abortController);

  let resultText = "";

  try {
    for await (const msg of q) {
      if (msg.type === "result") {
        const result = msg as any;
        if (result.session_id) {
          sessionStore.record(conversationId, result.session_id);
        }
        if (result.subtype === "success") {
          resultText = result.result ?? "";
        } else {
          const errors = result.errors?.join("; ") ?? "Unknown error";
          throw new Error(errors);
        }

        // Extract context usage
        if (result.modelUsage) {
          const usage = extractContextUsage(result.modelUsage);
          if (usage) {
            sessionStore.updateContextUsage(conversationId, usage);
            if (sessionStore.needsCompaction(conversationId)) {
              scheduleCompaction(conversationId, resultText);
            }
          }
        }
      }
    }
  } finally {
    activeQueries.delete(requestId);
  }

  // Append context status bar to response -- unless configuration switched it
  // off (`contextBar: false`, booqi-app/infra#363).
  if (readContextBar(config.contextBar)) {
    resultText += buildContextBar(conversationId);
  }

  const contextInfo = sessionStore.getContextInfo(conversationId);

  res.writeHead(200, {
    "Content-Type": "application/json",
    ...(contextInfo ? {
      "X-Context-Fill-Percent": String(Math.round(contextInfo.fillPercent * 100)),
      "X-Context-Window": String(contextInfo.contextWindow),
    } : {}),
  });
  res.end(
    JSON.stringify({
      id: requestId,
      object: "chat.completion",
      created: Math.floor(Date.now() / 1000),
      model,
      choices: [
        {
          index: 0,
          message: { role: "assistant", content: resultText },
          finish_reason: "stop",
        },
      ],
      usage: {
        prompt_tokens: contextInfo?.inputTokens ?? 0,
        completion_tokens: contextInfo?.outputTokens ?? 0,
        total_tokens: contextInfo?.totalTokens ?? 0,
      },
      ...(contextInfo ? {
        context: {
          fill_percent: contextInfo.fillPercent,
          context_window: contextInfo.contextWindow,
          total_tokens: contextInfo.totalTokens,
        },
      } : {}),
    }),
  );
}

// ── Context status bar ────────────────────────────────────────────

function buildContextBar(conversationId: string): string {
  const entry = sessionStore.get(conversationId);
  const info = entry?.contextUsage;
  const turn = entry?.turnCount ?? 0;

  if (!info) {
    return `\n\u2591\u2591\u2591\u2591\u2591\u2591\u2591\u2591\u2591\u2591 0% \u00b7 Turn ${turn}`;
  }

  const fillPct = Math.round(info.fillPercent * 100);
  const filled = Math.round(fillPct / 10);
  const bar = "\u2588".repeat(filled) + "\u2591".repeat(10 - filled);
  const tokensK = (info.totalTokens / 1000).toFixed(1);
  const windowK = (info.contextWindow / 1000).toFixed(0);

  const parts = [`${bar} ${fillPct}%`, `Turn ${turn}`, `${tokensK}k / ${windowK}k tokens`];

  if (sessionStore.needsCompaction(conversationId)) {
    parts.push("\u26a0 compacting soon");
  }

  return `\n${parts.join(" \u00b7 ")}`;
}

// ── Context usage extraction ───────────────────────────────────────

function extractContextUsage(modelUsage: Record<string, any>): ContextUsage | undefined {
  // modelUsage is keyed by model name — aggregate across all models
  let inputTokens = 0;
  let outputTokens = 0;
  let cacheReadInputTokens = 0;
  let cacheCreationInputTokens = 0;
  let contextWindow = 1_000_000;
  let costUsd = 0;

  // Known 1M context models — the SDK may underreport as 200K
  const KNOWN_1M_MODELS = ["claude-opus-4-6"];

  for (const [modelKey, usage] of Object.entries(modelUsage)) {
    inputTokens += usage.inputTokens ?? 0;
    outputTokens += usage.outputTokens ?? 0;
    cacheReadInputTokens += usage.cacheReadInputTokens ?? 0;
    cacheCreationInputTokens += usage.cacheCreationInputTokens ?? 0;
    if (usage.contextWindow) {
      const is1M = KNOWN_1M_MODELS.some((m) => modelKey.includes(m));
      contextWindow = is1M ? 1_000_000 : usage.contextWindow;
    }
    costUsd += usage.costUSD ?? 0;
  }

  const totalTokens = inputTokens + outputTokens;
  if (totalTokens === 0) return undefined;

  return {
    inputTokens,
    outputTokens,
    cacheReadInputTokens,
    cacheCreationInputTokens,
    contextWindow,
    totalTokens,
    fillPercent: totalTokens / contextWindow,
    costUsd,
  };
}

// ── Compaction ─────────────────────────────────────────────────────

function scheduleCompaction(conversationId: string, lastResult: string): void {
  // Generate a summary request to compact the conversation.
  // We rotate the session immediately — the next request will start
  // a fresh session with the summary injected as system prompt context.
  const summary = [
    "The conversation was compacted due to high context usage.",
    "Key context from the previous conversation:",
    lastResult ? `Last assistant response: ${lastResult.slice(0, 2000)}` : "",
  ].filter(Boolean).join("\n");

  sessionStore.rotateSession(conversationId, summary);
}

// ── Server lifecycle ────────────────────────────────────────────────

/**
 * Test seam. Not used by the runtime.
 *
 * `sessionStore` and `requestQueue` are module-level and are normally created
 * by `startBridgeServer`, which also binds a socket. A unit test wants neither
 * a socket nor the SDK, so this exposes exactly the two things it needs: a way
 * to create the module instances, and a way to replace `query`.
 */
export const __testing = {
  initialiseStores(config: BridgeConfig): { sessionStore: SessionStore } {
    sessionStore = new SessionStore(config.sessionTtlMs);
    requestQueue = new RequestQueue(
      config.queueMaxConcurrency ?? 1,
      config.queueMinDelayMs ?? 1000,
      config.queueMaxDelayMs ?? 4000,
    );
    return { sessionStore };
  },
  setQuery(fn: QueryFn | undefined): void {
    queryOverride = fn;
  },
  /** Replaces this module's log sink, so the one line per request is readable. */
  setLog(fn: ((message: string) => void) | undefined): void {
    logOverride = fn;
  },
  /**
   * The real HTTP entry point, exposed so the JOIN can be tested.
   *
   * `handleCompletions` is the ONLY place in production where
   * `resolveConversation().affinityHeaders` reaches `executeWithRetries`.
   * Before this was exposed, deleting that one argument left all arms green
   * while the deployed log line silently reverted to the pre-S1 string -- a
   * surviving mutant on the entire purpose of the slice, catchable only by the
   * deploy-and-read step it exists to serve. (Review finding, b1006-1 loop F.)
   */
  handleCompletions,
};

export function startBridgeServer(config: BridgeConfig): Promise<ReturnType<typeof createServer>> {
  // Refuse an unusable `contextBar` before a socket is bound. The handlers read
  // it again at the END of each answer, and a throw there -- after the answer
  // has streamed -- would leave the stream without its `[DONE]`. Validating
  // here makes that throw unreachable for any config this server accepts.
  readContextBar(config.contextBar);
  sessionStore = new SessionStore(config.sessionTtlMs);
  requestQueue = new RequestQueue(
    config.queueMaxConcurrency ?? 1,
    config.queueMinDelayMs ?? 1000,
    config.queueMaxDelayMs ?? 4000,
  );

  return new Promise((resolve, reject) => {
    const server = createServer(async (req, res) => {
      res.setHeader("Access-Control-Allow-Origin", "*");
      res.setHeader("Access-Control-Allow-Methods", "POST, GET, OPTIONS");
      res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization, X-Session-Id, X-Conversation-Id");
      res.setHeader("Access-Control-Expose-Headers", "X-Context-Fill-Percent, X-Context-Window");

      if (req.method === "OPTIONS") {
        res.writeHead(204);
        res.end();
        return;
      }

      if (req.url === "/health" || req.url === "/v1/health") {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ status: "ok", activeQueries: activeQueries.size }));
        return;
      }

      if (req.url === "/v1/models" && req.method === "GET") {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(
          JSON.stringify({
            object: "list",
            data: [
              { id: "claude-opus-4-6", object: "model", owned_by: "anthropic" },
              { id: "claude-opus-4-5", object: "model", owned_by: "anthropic" },
              { id: "claude-sonnet-4-6", object: "model", owned_by: "anthropic" },
              { id: "claude-sonnet-4", object: "model", owned_by: "anthropic" },
              { id: "claude-haiku-4-5", object: "model", owned_by: "anthropic" },
            ],
          }),
        );
        return;
      }

      // Session context info endpoint
      if (req.url?.startsWith("/v1/sessions") && req.method === "GET") {
        const sessionId = req.url.split("/v1/sessions/")[1];
        if (sessionId) {
          // Single session context info
          const info = sessionStore.getContextInfo(sessionId);
          const entry = sessionStore.get(sessionId);
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({
            session_id: sessionId,
            turn_count: entry?.turnCount ?? 0,
            context: info ? {
              fill_percent: info.fillPercent,
              fill_percent_display: `${Math.round(info.fillPercent * 100)}%`,
              context_window: info.contextWindow,
              input_tokens: info.inputTokens,
              output_tokens: info.outputTokens,
              total_tokens: info.totalTokens,
              cost_usd: info.costUsd,
            } : null,
            needs_compaction: sessionStore.needsCompaction(sessionId),
          }));
        } else {
          // List all sessions
          const sessions = sessionStore.getAllSessions().map(({ conversationId, entry }) => ({
            session_id: conversationId,
            turn_count: entry.turnCount,
            last_used: entry.lastUsed,
            context: entry.contextUsage ? {
              fill_percent: entry.contextUsage.fillPercent,
              fill_percent_display: `${Math.round(entry.contextUsage.fillPercent * 100)}%`,
              context_window: entry.contextUsage.contextWindow,
              total_tokens: entry.contextUsage.totalTokens,
            } : null,
          }));
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ sessions }));
        }
        return;
      }

      // Manual compaction endpoint
      if (req.url?.startsWith("/v1/sessions/") && req.url.endsWith("/compact") && req.method === "POST") {
        const sessionId = req.url.slice("/v1/sessions/".length, -"/compact".length);
        const entry = sessionStore.get(sessionId);
        if (!entry) {
          res.writeHead(404, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "Session not found" }));
        } else {
          scheduleCompaction(sessionId, "Manual compaction requested by user.");
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ status: "compacted", session_id: sessionId }));
        }
        return;
      }

      if (req.url === "/v1/chat/completions" && req.method === "POST") {
        try {
          await handleCompletions(req, res, config);
        } catch (err: any) {
          if (!res.headersSent) {
            res.writeHead(500, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ error: { message: err.message, type: "server_error" } }));
          }
        }
        return;
      }

      res.writeHead(404, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: { message: "Not found", type: "invalid_request_error" } }));
    });

    server.listen(config.port, "127.0.0.1", () => {
      resolve(server);
    });

    server.on("error", reject);
  });
}

export function stopBridgeServer(server: ReturnType<typeof createServer>): Promise<void> {
  // Abort all active queries
  for (const [, controller] of activeQueries) {
    controller.abort();
  }
  activeQueries.clear();
  sessionStore.clear();

  return new Promise((resolve) => {
    server.close(() => resolve());
  });
}
