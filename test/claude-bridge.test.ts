/**
 * Behavioural tests for the transport, `src/claude-bridge.ts`.
 *
 * WHY THIS FILE EXISTS. The first round of booqi-app/infra#202 proved the
 * transport only with regexes over its own source text, because the module
 * imported the Agent SDK at the top level and the hermetic suite could not
 * load it. Three independent reviewers each re-introduced the very defect the
 * issue exists to fix, in a spelling those regexes did not match, with all 55
 * tests green:
 *
 *   - sever the prompt at both `buildQueryOptions` call sites
 *   - `const p = resolveSystemPrompt(...); const eff = resumeSessionId ? undefined : p;`
 *   - invert the compaction-summary restore guard, or `if (false && ...)`
 *
 * A regex can pin one spelling of a bug. It cannot pin a property. So the SDK
 * import was made lazy and injectable (`__testing.setQuery`) and these tests
 * assert what the transport actually hands to the SDK. Each test below names
 * the mutant it kills.
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  __testing,
  executeWithRetries,
  resolveConversation,
  type QueryFn,
} from "../src/claude-bridge.ts";
import type { BridgeConfig } from "../src/bridge-config.ts";

const config: BridgeConfig = {
  port: 7779,
  workDir: "/home/agent/.openclaw/workspace",
  skipPermissions: true,
  maxRetries: 0,
  queueMinDelayMs: 0,
  queueMaxDelayMs: 0,
};

/** The options object the fake `query()` was handed, per call. */
type Captured = { options: Record<string, any> };

/** A fake `query()` that records its options and then behaves as told. */
function fakeQuery(captured: Captured[], behaviour: "success" | "fail"): QueryFn {
  return (({ options }: any) => {
    captured.push({ options });
    return (async function* () {
      if (behaviour === "fail") {
        // A non-transient SDK failure, before anything reaches the client.
        throw new Error("invalid request: model refused");
      }
      yield {
        type: "result",
        subtype: "success",
        result: "ok",
        session_id: "sdk-session-1",
      } as any;
    })();
  }) as unknown as QueryFn;
}

/**
 * Minimal ServerResponse stand-in: only what the handlers touch.
 *
 * `headersSent` flips synchronously in `writeHead`, as node:http does -- that
 * fidelity is the whole point, since the bug this file exists to catch was a
 * restore condition that re-read `headersSent` after the 502 had set it.
 * `writableEnded` is modelled too: the streaming handler branches on it three
 * times, and an `undefined` there would make those branches pass by luck.
 *
 * `failEndAfterHeaders` simulates the client disconnecting between
 * `writeHead` and `end` (EPIPE), which is the only way to reach the catch
 * block's `res.headersSent` arm.
 */
function fakeRes(opts: { failEndAfterHeaders?: boolean } = {}) {
  return {
    headersSent: false,
    writableEnded: false,
    statusCode: 0,
    body: "",
    setHeader() {},
    writeHead(status: number) {
      this.statusCode = status;
      this.headersSent = true;
      return this;
    },
    write(chunk: string) {
      this.body += chunk;
      return true;
    },
    end(chunk?: string) {
      if (opts.failEndAfterHeaders) throw new Error("EPIPE: client went away");
      if (chunk) this.body += chunk;
      this.headersSent = true;
      this.writableEnded = true;
    },
  } as any;
}

async function run(opts: {
  systemPrompt: string | undefined;
  resumeSessionId?: string;
  compactSummary?: string;
  behaviour: "success" | "fail";
  /**
   * `true` exercises `handleStreamingResponse`. This matters more than it
   * looks: `claude-bridge.ts` computes `const stream = body.stream !== false`,
   * so STREAMING IS THE PRODUCTION DEFAULT. A round of these tests that only
   * drove `stream: false` left the streaming `buildQueryOptions` call site
   * pinned by nothing, and severing the prompt there alone kept the suite
   * green. Every assertion about what the SDK receives runs for both.
   */
  stream?: boolean;
  failEndAfterHeaders?: boolean;
  /** The chat session a caller named, or nothing -- booqi-app/app#459 part C. */
  chatSessionId?: string;
  /** Configuration the request runs with. Defaults to the module `config`. */
  bridgeConfig?: BridgeConfig;
}) {
  const runConfig = opts.bridgeConfig ?? config;
  const { sessionStore } = __testing.initialiseStores(runConfig);
  const conversationId = "conv-1";
  const logs: string[] = [];

  if (opts.resumeSessionId) sessionStore.record(conversationId, opts.resumeSessionId);
  if (opts.compactSummary) {
    if (!opts.resumeSessionId) sessionStore.record(conversationId, "");
    sessionStore.setCompactSummary(conversationId, opts.compactSummary);
  }

  const captured: Captured[] = [];
  __testing.setQuery(fakeQuery(captured, opts.behaviour));
  __testing.setLog((message) => logs.push(message));
  const res = fakeRes({ failEndAfterHeaders: opts.failEndAfterHeaders });

  try {
    await executeWithRetries(
      "hello", "claude-opus-4-6", opts.systemPrompt, conversationId,
      opts.stream ?? false, res, "req-1", runConfig, opts.chatSessionId,
    );
  } finally {
    __testing.setQuery(undefined);
    __testing.setLog(undefined);
  }

  return { captured, res, sessionStore, conversationId, logs };
}

// ── AC-1: the prompt actually leaves the transport ──────────────────

// Both transports, every time. `handleStreamingResponse` and
// `handleNonStreamingResponse` each build their own options with their own
// `buildQueryOptions(...)` call, so a test that drives only one of them pins
// only one of them -- and streaming is the production default.
for (const stream of [false, true]) {
  const via = stream ? "streaming" : "non-streaming";

  test(`the caller's system prompt reaches the SDK query options (${via})`, async () => {
    // KILLS the mutant that severs the prompt at a buildQueryOptions call
    // site: `buildQueryOptions(model, undefined, ...)`. Nothing observed the
    // value that actually left executeWithRetries before this.
    const { captured } = await run({ systemPrompt: "you are a bookkeeper", behaviour: "success", stream });

    assert.equal(captured.length, 1);
    assert.equal(captured[0].options.systemPrompt, "you are a bookkeeper");
  });

  test(`a RESUMED turn still carries the system prompt into the SDK options (${via})`, async () => {
    const { captured } = await run({
      systemPrompt: "you are a bookkeeper",
      resumeSessionId: "sdk-session-9",
      behaviour: "success",
      stream,
    });

    assert.equal(captured[0].options.resume, "sdk-session-9", "precondition: this is a resumed turn");
    assert.equal(
      captured[0].options.systemPrompt, "you are a bookkeeper",
      "a resumed turn went out with no system prompt -- the persona flips after turn 1 (booqi-app/infra#202)",
    );
  });

  test(`a compaction summary reaches the SDK prompt (${via})`, async () => {
    const { captured } = await run({
      systemPrompt: "P", compactSummary: "SUMMARY-TEXT", behaviour: "success", stream,
    });

    assert.ok(
      String(captured[0].options.systemPrompt).includes("SUMMARY-TEXT"),
      "the summary never reached the model",
    );
  });

  test(`systemPromptMode append sends the preset form through the transport (${via})`, async () => {
    __testing.initialiseStores(config);
    const captured: Captured[] = [];
    __testing.setQuery(fakeQuery(captured, "success"));

    try {
      await executeWithRetries(
        "hello", "claude-opus-4-6", "P", `conv-append-${via}`, stream, fakeRes(), "req-2",
        { ...config, systemPromptMode: "append" },
      );
    } finally {
      __testing.setQuery(undefined);
    }

    assert.deepEqual(captured[0].options.systemPrompt, {
      type: "preset", preset: "claude_code", append: "P",
    });
  });
}

// ── AC-2: every turn, resumed or not ────────────────────────────────

test("the first turn and a resumed turn send an identical system prompt", async () => {
  const first = await run({ systemPrompt: "P", behaviour: "success" });
  const resumed = await run({ systemPrompt: "P", resumeSessionId: "sdk-session-9", behaviour: "success" });

  assert.deepEqual(resumed.captured[0].options.systemPrompt, first.captured[0].options.systemPrompt);
});

// ── AC-5: the compaction summary survives a failed request ──────────

test("a compaction summary is restored when the request fails without reaching the client", async () => {
  // KILLS both the inverted guard and `if (false && ...)`, and it is the test
  // that catches the bug the first round shipped: the restore was conditioned
  // on `!res.headersSent`, but the 502 is written inside the try and
  // `writeHead` sets `headersSent` synchronously, so the restore was dead code
  // on exactly the path it existed for.
  const { res, sessionStore, conversationId } = await run({
    systemPrompt: "P", compactSummary: "SUMMARY-TEXT", behaviour: "fail",
  });

  assert.equal(res.statusCode, 502, "precondition: the request failed without reaching the client");
  assert.equal(
    sessionStore.get(conversationId)?.compactSummary, "SUMMARY-TEXT",
    "the rotated-away conversation's summary was consumed and then lost",
  );
});

test("a delivered compaction summary is NOT restored after success", async () => {
  const { sessionStore, conversationId } = await run({
    systemPrompt: "P", compactSummary: "SUMMARY-TEXT", behaviour: "success",
  });

  assert.equal(
    sessionStore.get(conversationId)?.compactSummary, undefined,
    "the summary was replayed into the next turn although this one delivered it",
  );
});

test("a summary is not restored when the turn succeeded but res.end() then failed", async () => {
  // The delivery point that nothing held: the catch block's
  // `if (res.headersSent)` arm. The SDK query succeeded, so the summary DID
  // reach the model; the client then went away during res.end(). Without
  // `summaryDelivered = true` on that arm the finally puts the summary back
  // and the next turn's system prompt carries it a second time.
  const { res, sessionStore, conversationId } = await run({
    systemPrompt: "P", compactSummary: "SUMMARY-TEXT",
    behaviour: "success", failEndAfterHeaders: true,
  });

  assert.equal(res.headersSent, true, "precondition: headers were sent before the failure");
  // `headersSent` alone is also true on the happy path, so it cannot tell the
  // two apart. `writableEnded` stays false only when end() threw, which pins
  // that this test really took the EPIPE path -- without it, neutering the
  // fake's throw silently turns this into a duplicate of the success test.
  assert.equal(res.writableEnded, false, "precondition: res.end() threw, so this is the EPIPE path");
  assert.equal(
    sessionStore.get(conversationId)?.compactSummary, undefined,
    "the summary was restored although the SDK query had already consumed it -- "
      + "it will be duplicated in the next turn's system prompt",
  );
});

test("a newer summary written during the request is not clobbered by the restore", async () => {
  // KILLS the mutant that drops `&& !sessionStore.get(cid)?.compactSummary`
  // from the restore condition. `scheduleCompaction` runs synchronously inside
  // both handlers and `rotateSession` writes a FRESH summary into the store
  // during the very request whose finally then runs, so restoring the stale
  // one unconditionally silently reverts the compaction.
  const { sessionStore } = __testing.initialiseStores(config);
  const conversationId = "conv-clobber";
  sessionStore.record(conversationId, "");
  sessionStore.setCompactSummary(conversationId, "OLD-SUMMARY");

  __testing.setQuery((() => (async function* () {
    // Stand in for scheduleCompaction()/rotateSession() firing mid-request.
    sessionStore.setCompactSummary(conversationId, "NEWER-SUMMARY");
    throw new Error("invalid request: model refused");
  })()) as unknown as QueryFn);

  const res = fakeRes();
  try {
    await executeWithRetries(
      "hello", "claude-opus-4-6", "P", conversationId, false, res, "req-3", config,
    );
  } finally {
    __testing.setQuery(undefined);
  }

  assert.equal(res.statusCode, 502, "precondition: the request failed without reaching the client");
  assert.equal(
    sessionStore.get(conversationId)?.compactSummary, "NEWER-SUMMARY",
    "the restore clobbered a newer summary with the stale one, reverting the compaction",
  );
});

test("a resumed turn also carries the compaction summary", async () => {
  const { captured } = await run({
    systemPrompt: "P", compactSummary: "SUMMARY-TEXT",
    resumeSessionId: "sdk-session-9", behaviour: "success",
  });

  const sent = String(captured[0].options.systemPrompt);
  assert.ok(sent.includes("P"));
  assert.ok(sent.includes("SUMMARY-TEXT"));
});

// ── the mode actually reaches the wire ──────────────────────────────


// ── The session hint on the wire (booqi-app/app#459, AC-C1, AC-C2, AC-C6) ──
//
// `bridge-config.test.ts` asserts the options object `buildQueryOptions`
// returns. These assert what the SDK CALL receives, through the real transport,
// for BOTH transports -- `handleStreamingResponse` and
// `handleNonStreamingResponse` each build their own options with their own
// `buildQueryOptions(...)` call, and streaming is the production default
// (`const stream = body.stream !== false`). A round that drove only one of them
// would leave the other pinned by nothing, which is precisely how the
// system-prompt defect survived three reviewers on this file.

const MCP_URL = "http://127.0.0.1:3004/mcp";

const configWithMcp: BridgeConfig = {
  ...config,
  mcpServers: { booqi: { type: "http", url: MCP_URL } },
};

for (const stream of [false, true]) {
  const via = stream ? "streaming" : "non-streaming";

  test(`the SDK call receives the hinted MCP url (${via})`, async () => {
    const { captured } = await run({
      systemPrompt: "you are a bookkeeper",
      behaviour: "success",
      stream,
      chatSessionId: "chat-42",
      bridgeConfig: configWithMcp,
    });

    assert.equal(captured.length, 1);
    const url: string = captured[0].options.mcpServers.booqi.url;
    assert.equal(url, `${MCP_URL}?session=chat-42`);
    // Read it back the way the cell gateway's relay does.
    assert.equal(new URL(url).searchParams.get("session"), "chat-42");
  });

  test(`a hintless request sends the url unchanged and logs once (${via})`, async () => {
    const { captured, logs } = await run({
      systemPrompt: "you are a bookkeeper",
      behaviour: "success",
      stream,
      bridgeConfig: configWithMcp,
    });

    assert.equal(captured[0].options.mcpServers.booqi.url, MCP_URL);
    assert.equal(new URL(captured[0].options.mcpServers.booqi.url).searchParams.get("session"), null);
    assert.equal(logs.length, 1, `expected one line, got ${logs.length}: ${logs}`);
    assert.match(logs[0], /no chat-session hint written/);
  });

  test(`no log line on the wire carries the identifier (${via})`, async () => {
    const identifier = "chat-cafe1234-secret";
    const { logs } = await run({
      systemPrompt: "you are a bookkeeper",
      behaviour: "success",
      stream,
      chatSessionId: identifier,
      bridgeConfig: configWithMcp,
    });

    assert.equal(logs.length, 1);
    for (const line of logs) {
      assert.equal(line.includes(identifier), false, `log discloses the identifier: ${line}`);
    }
  });
}

// ── Provenance: the bridge never hints with an id it invented itself ──
//
// This is the fail-OPEN form of the whole feature and the reason
// `chatSessionId` is a separate value from `conversationId`. The session store
// needs a key for every request, so `conversationId` is always a string --
// `"default"` for an empty message list, `derived-<hash>` otherwise. Handing
// either to the cell gateway as a tenant routing key would route every
// hintless request at one guessable exchange. `absent` must stay absent.

function reqWith(headers: Record<string, string> = {}): any {
  return { headers };
}

test("a caller-named chat session becomes the hint, by header or by body", () => {
  for (const [label, req, body] of [
    ["x-booqi-chat-session", reqWith({ "x-booqi-chat-session": "chat-7" }), {}],
    ["x-session-id", reqWith({ "x-session-id": "chat-7" }), {}],
    ["x-conversation-id", reqWith({ "x-conversation-id": "chat-7" }), {}],
    ["conversation_id", reqWith(), { conversation_id: "chat-7" }],
    ["metadata.conversation_id", reqWith(), { metadata: { conversation_id: "chat-7" } }],
  ] as Array<[string, any, Record<string, any>]>) {
    const resolved = resolveConversation(req, body);
    assert.equal(resolved.chatSessionId, "chat-7", `not carried by ${label}`);
    assert.equal(resolved.conversationId, "chat-7", `conversation key wrong for ${label}`);
  }
});

test("a derived conversation id is NOT offered as a chat session", () => {
  // Non-empty messages: `derived-<hash>`.
  const derived = resolveConversation(reqWith(), {
    messages: [{ role: "user", content: "hello" }],
  });
  assert.equal(derived.chatSessionId, undefined);
  assert.match(derived.conversationId, /^derived-[0-9a-f]{16}$/);

  // Empty messages: the literal "default", which is exactly the value that
  // must never leave this process as a routing key.
  const fallback = resolveConversation(reqWith(), {});
  assert.equal(fallback.chatSessionId, undefined);
  assert.equal(fallback.conversationId, "default");
  assert.notEqual(fallback.chatSessionId, "default");
});

test("an empty or blank caller value is absent, not a chat session", () => {
  for (const value of ["", "   "]) {
    const resolved = resolveConversation(reqWith({ "x-booqi-chat-session": value }), {});
    assert.equal(resolved.chatSessionId, undefined, `blank accepted: ${JSON.stringify(value)}`);
    assert.equal(resolved.conversationId, "default");
  }
});

test("a derived id reaches the SDK as no hint at all, end to end", async () => {
  // The two halves joined: what `resolveConversation` refuses is what the SDK
  // then does not receive. Without this, the refusal above and the writer in
  // bridge-config could each be right while the wiring between them was not.
  const derived = resolveConversation(reqWith(), { messages: [{ role: "user", content: "hi" }] });
  const { captured, logs } = await run({
    systemPrompt: "you are a bookkeeper",
    behaviour: "success",
    stream: true,
    chatSessionId: derived.chatSessionId,
    bridgeConfig: configWithMcp,
  });

  const url: string = captured[0].options.mcpServers.booqi.url;
  assert.equal(url, MCP_URL);
  assert.equal(url.includes("session="), false);
  assert.equal(url.includes(derived.conversationId), false);
  assert.equal(logs.length, 1);
});

/**
 * A fake `query()` whose first call fails with a stale-session error and whose
 * later calls succeed, so the retry loop of `executeWithRetries` is really
 * entered. Records one entry per call, like `fakeQuery`.
 */
function fakeQueryFailingOnce(captured: Captured[]): QueryFn {
  let calls = 0;
  return (({ options }: any) => {
    captured.push({ options });
    calls += 1;
    const failThis = calls === 1;
    return (async function* () {
      if (failThis) throw new Error("no conversation found for session");
      yield {
        type: "result", subtype: "success", result: "ok", session_id: "sdk-session-2",
      } as any;
    })();
  }) as unknown as QueryFn;
}

test("AC-C2: a retried request logs the missing hint ONCE, not once per attempt", async () => {
  // `once` has to mean once per REQUEST. Each retry builds its own options
  // with its own `buildQueryOptions(...)` call, so the naive wiring emits one
  // line per SDK attempt -- and a count that moves with the retry policy
  // cannot be used to tell "the hint is missing" from "the hint is missing a
  // lot". The logged fact is a property of the request, not of the attempt.
  const retrying: BridgeConfig = { ...configWithMcp, maxRetries: 2 };
  const { sessionStore } = __testing.initialiseStores(retrying);
  sessionStore.record("conv-1", "stale-sdk-session");

  const captured: Captured[] = [];
  const logs: string[] = [];
  __testing.setQuery(fakeQueryFailingOnce(captured));
  __testing.setLog((message) => logs.push(message));
  const res = fakeRes();

  try {
    await executeWithRetries(
      // The NON-streaming transport: `handleStreamingResponse` writes its 200
      // header before it iterates the query, so a failure there sets
      // `res.headersSent` and the retry loop returns instead of retrying.
      // Driving the retry at all requires the transport that fails before any
      // header is written.
      "hello", "claude-opus-4-6", "you are a bookkeeper", "conv-1",
      false, res, "req-1", retrying, undefined,
    );
  } finally {
    __testing.setQuery(undefined);
    __testing.setLog(undefined);
  }

  // The retry really happened -- otherwise this test proves nothing.
  assert.ok(captured.length >= 2, `expected a retry, saw ${captured.length} SDK call(s)`);
  for (const call of captured) {
    assert.equal(call.options.mcpServers.booqi.url, MCP_URL);
  }
  assert.equal(logs.length, 1, `expected one line across ${captured.length} attempts, got ${logs.length}: ${logs}`);
});
