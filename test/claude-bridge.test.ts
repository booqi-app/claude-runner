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
import { buildQueryOptions, type BridgeConfig } from "../src/bridge-config.ts";

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

// ── OpenClaw's session-affinity headers (booqi-app/infra#327 item 1) ──────
//
// MEASURED on the dev host, 2026-10-04, inside the running reference cell
// `/opt/booqi/cells/demo-boekhouding/` (OpenClaw 2026.7.1-beta.5):
//
//   /app/node_modules/@openclaw/ai/src/providers/openai-completions.ts:620
//     if (sessionId && compat.sendSessionAffinityHeaders) {
//       headers.session_id = sessionId;
//       headers["x-client-request-id"] = sessionId;
//       headers["x-session-affinity"] = sessionId;
//     }
//
// So the host DOES send a session identifier to an OpenAI-compatible provider
// -- under three names none of which this bridge used to read. That corrects
// the claim this file and `resolveConversation` carried since 2026-10-01.
//
// What it does NOT send is the cell's `sessionKey`. The value is OpenClaw's own
// session RECORD id: `agents/boekhouder/sessions/sessions.json` maps the key
// `agent:boekhouder:<chatSessionId>` onto `{ sessionId: "<uuid>" }`, and the
// provider call site reads `ctx.params.session.id`. A uuid is meaningless to
// `apps/cell`'s relay, whose `connectionByChatSession` map is keyed by the
// control plane's chat session id.
//
// Hence the rule these tests pin: an affinity header is honoured ONLY when it
// carries the `agent:<agentId>:<chatSessionId>` key shape, and an opaque value
// is refused. Writing `?session=<uuid>` instead would make the relay log
// `bound: true` while `backendFor` still resolved to nothing -- a tool call
// answered `tenant_unavailable` behind a log line claiming it was bound. The
// fail-closed branch is diagnosable; that one is not.

test("an affinity header carrying the cell's session key yields the chat session", () => {
  for (const header of ["session_id", "x-client-request-id", "x-session-affinity"]) {
    const resolved = resolveConversation(reqWith({ [header]: "agent:boekhouder:chat-7" }), {});
    assert.equal(resolved.chatSessionId, "chat-7", `not unwrapped from ${header}`);
    assert.equal(resolved.conversationId, "chat-7", `conversation key wrong for ${header}`);
  }
});

test("an opaque OpenClaw session id on an affinity header is refused, not written", () => {
  // The literal uuid measured in the reference cell's sessions.json.
  for (const header of ["session_id", "x-client-request-id", "x-session-affinity"]) {
    const resolved = resolveConversation(
      reqWith({ [header]: "b66bdf67-0f4d-46d8-8051-4c9251fdde62" }),
      {},
    );
    assert.equal(resolved.chatSessionId, undefined, `uuid accepted from ${header}`);
    assert.equal(resolved.conversationId, "default");
  }
});

test("a caller-named chat session wins over an affinity header", () => {
  const resolved = resolveConversation(
    reqWith({
      "x-booqi-chat-session": "chat-named",
      "session_id": "agent:boekhouder:chat-affinity",
    }),
    {},
  );
  assert.equal(resolved.chatSessionId, "chat-named");
});

test("a session key with no chat session left in it is absent, not empty", () => {
  for (const value of ["agent:boekhouder:", "agent:boekhouder:   ", "agent:boekhouder", "agent:", "boekhouder:chat-7"]) {
    const resolved = resolveConversation(reqWith({ session_id: value }), {});
    assert.equal(resolved.chatSessionId, undefined, `accepted: ${JSON.stringify(value)}`);
  }
});

test("a blank earlier caller header does not hand the request to an affinity header", () => {
  // Review round 1, MAJOR. `||` short-circuits on the first TRUTHY value, but
  // `normaliseChatSessionId` then rejects whitespace -- so a blank
  // `x-booqi-chat-session` used to collapse the whole caller chain to
  // `undefined` and let the affinity header decide, SKIPPING a valid
  // `x-session-id`. Before this file read affinity headers at all that only
  // lost the hint, which is fail-closed; now it would route the request at a
  // DIFFERENT chat session, which is not.
  const resolved = resolveConversation(
    reqWith({
      "x-booqi-chat-session": " ",
      "x-session-id": "chat-caller-named",
      "session_id": "agent:boekhouder:chat-affinity",
    }),
    {},
  );
  assert.equal(resolved.chatSessionId, "chat-caller-named");
  assert.equal(resolved.conversationId, "chat-caller-named");
});

test("a non-string truthy caller value does not shadow a later valid one", () => {
  // Same root cause, body edition: `conversation_id: 12345` is truthy, so the
  // `||` chain stopped there and `metadata.conversation_id` was never read.
  const resolved = resolveConversation(reqWith(), {
    conversation_id: 12345,
    metadata: { conversation_id: "chat-meta" },
  });
  assert.equal(resolved.chatSessionId, "chat-meta");
});

test("every caller channel is tried in turn, not just the first truthy one", () => {
  // The precedence order itself, pinned channel by channel: each one wins over
  // the ones after it, and a blank value in any earlier channel is skipped
  // rather than being allowed to end the search.
  const channels: Array<[string, Record<string, string>, Record<string, any>]> = [
    ["x-booqi-chat-session", { "x-booqi-chat-session": "chat-win" }, {}],
    ["x-session-id", { "x-booqi-chat-session": "  ", "x-session-id": "chat-win" }, {}],
    [
      "x-conversation-id",
      { "x-booqi-chat-session": "  ", "x-session-id": " ", "x-conversation-id": "chat-win" },
      {},
    ],
    ["conversation_id", { "x-session-id": " " }, { conversation_id: "chat-win" }],
    ["metadata.conversation_id", { "x-session-id": " " }, { metadata: { conversation_id: "chat-win" } }],
  ];
  for (const [label, headers, body] of channels) {
    const resolved = resolveConversation(reqWith(headers), body);
    assert.equal(resolved.chatSessionId, "chat-win", `channel not reached: ${label}`);
  }
});

test("a duplicated affinity header is refused rather than fabricating an id", () => {
  // Review round 1, P2 raised by two reviewers independently. Node joins
  // repeated headers of these names with ", " into ONE string, so two copies
  // arrive as `agent:b:chat-A, agent:b:chat-B` and the greedy tail would hand
  // the relay `chat-A, agent:b:chat-B` -- an id belonging to nobody, written
  // into `?session=`, which is the exact `bound: true` + `tenant_unavailable`
  // false green the key-shape guard exists to prevent.
  //
  // Not reachable from the measured host (it assigns the three headers from an
  // object literal), but a proxy or retry layer that appends a second copy is
  // all it takes.
  const resolved = resolveConversation(
    reqWith({ "x-session-affinity": "agent:boekhouder:chat-A, agent:boekhouder:chat-B" }),
    {},
  );
  assert.equal(resolved.chatSessionId, undefined);
  assert.equal(resolved.conversationId, "default");
});

test("a nested session key is refused, not unwrapped one level", () => {
  const resolved = resolveConversation(
    reqWith({ session_id: "agent:boekhouder:agent:other:chat-9" }),
    {},
  );
  assert.equal(resolved.chatSessionId, undefined);
});

test("a session key on a CALLER channel is taken verbatim, not unwrapped", () => {
  // Pinned on purpose rather than changed. The unwrap is applied ONLY to the
  // affinity headers, because those are known to carry OpenClaw's identity
  // while a caller channel carries whatever the caller chose -- and the cell
  // does not sanitise the chat session id, so a value that merely LOOKS like a
  // session key could be a real chat session id.
  //
  // The consequence is deliberate and is the thing this test exists to make
  // visible: if infra#327 option (A) ever lands by having the host send its
  // session KEY on one of these names, the bridge would write
  // `?session=agent:boekhouder:chat-7` and regress to the false green. Whoever
  // implements (A) must make that choice explicitly, and this test will fail
  // and force them to.
  const resolved = resolveConversation(
    reqWith({ "x-booqi-chat-session": "agent:boekhouder:chat-7" }),
    {},
  );
  assert.equal(resolved.chatSessionId, "agent:boekhouder:chat-7");
});

test("a tail that is not a conformant chat session id is refused", () => {
  // Review round 2 REPLACED a test that asserted the opposite of this one. It
  // said "a chat session id containing colons survives the unwrap whole", on
  // the stated ground that the cell does not sanitise the id. That ground was
  // wrong: `apps/cell/src/openclaw.ts` indeed does not, but the control plane
  // does, upstream of everything that reaches the binding map --
  // `chatSessionIdSchema` (`packages/shared/src/chat.ts`,
  // `/^[A-Za-z0-9_-]+$/`, 1..200) is applied to `params.sessionId` on BOTH
  // `chat.send` and `chat.history` (`apps/cell/src/protocol.ts`). So `a:b:c` is
  // not a conversation worth preserving; it is unbindable by construction, and
  // forwarding it would buy a `bound: true` over a `tenant_unavailable`.
  const refused = [
    "agent:boekhouder:a:b:c",
    "agent:boekhouder:chat-A, agent:boekhouder:chat-B", // Node's duplicate-header join
    "agent:boekhouder:chat-A, chat-B",
    "agent:boekhouder:AGENT:other:chat-9", // nesting in another case
    "agent:boekhouder:chat 7",
    "agent:boekhouder:a/b",
    "agent:boekhouder:a.b",
    `agent:boekhouder:${"a".repeat(201)}`,
  ];
  for (const value of refused) {
    const resolved = resolveConversation(reqWith({ session_id: value }), {});
    assert.equal(resolved.chatSessionId, undefined, `accepted: ${JSON.stringify(value)}`);
    assert.equal(resolved.conversationId, "default");
  }
});

test("a session key with anything before `agent:` is refused", () => {
  // Review round 2, surviving mutant S1. Dropping the `^` anchor from
  // AGENT_SESSION_KEY left the suite green at 125/125 while really changing
  // behaviour: `sess-of-agent:b:chat-9` would unwrap to `chat-9`. That is the
  // fabrication boundary this guard exists to hold -- a value that merely
  // CONTAINS a session key is not one -- so it is pinned here rather than left
  // to the next reader to rediscover.
  for (const value of [
    "sess-of-agent:boekhouder:chat-9",
    "xxagent:boekhouder:chat-9",
    "x agent:boekhouder:chat-9",
    "1agent:boekhouder:chat-9",
  ]) {
    // NOTE: a prefix of pure WHITESPACE is deliberately absent from this list.
    // `" agent:b:chat-9"` is trimmed by `normaliseChatSessionId` before the
    // pattern is applied and then legitimately IS a session key -- Node strips
    // surrounding header whitespace too. Asserting a refusal there would pin a
    // bug, not a guard; I wrote that case first and the suite caught it.
    const resolved = resolveConversation(reqWith({ session_id: value }), {});
    assert.equal(resolved.chatSessionId, undefined, `accepted: ${JSON.stringify(value)}`);
  }
});

test("whitespace inside the unwrapped tail is trimmed, not routed on", () => {
  // Review round 2, surviving mutant S2. The existing "no chat session left in
  // it" test only exercises TRAILING whitespace, which the outer
  // `normaliseChatSessionId` already strips -- so dropping the INNER trim of
  // the captured tail stayed green while yielding " chat-7" as a routing key.
  for (const value of ["agent:boekhouder: chat-7", "agent:boekhouder:\tchat-7", "agent:boekhouder:chat-7 "]) {
    const resolved = resolveConversation(reqWith({ session_id: value }), {});
    assert.equal(resolved.chatSessionId, "chat-7", `not trimmed: ${JSON.stringify(value)}`);
  }
});

test("an earlier caller channel wins over a later one that also names a session", () => {
  // Review round 2, surviving mutant S3. The precedence test above only ever
  // makes the EARLIER channels blank, so it pins "a later channel is
  // reachable" and not "the earlier one wins" -- swapping two channels stayed
  // green. `x-booqi-chat-session` is the relay's own canonical header and
  // `x-session-id` is generic, so a silent reorder would be a misroute.
  const ladder: Array<[string, Record<string, string>, Record<string, any>]> = [
    [
      "x-booqi-chat-session over x-session-id",
      { "x-booqi-chat-session": "chat-win", "x-session-id": "chat-lose" },
      {},
    ],
    [
      "x-session-id over x-conversation-id",
      { "x-session-id": "chat-win", "x-conversation-id": "chat-lose" },
      {},
    ],
    [
      "x-conversation-id over conversation_id",
      { "x-conversation-id": "chat-win" },
      { conversation_id: "chat-lose" },
    ],
    [
      "conversation_id over metadata.conversation_id",
      {},
      { conversation_id: "chat-win", metadata: { conversation_id: "chat-lose" } },
    ],
    [
      "every caller channel over every affinity header",
      {
        "metadata-placeholder": "x",
        session_id: "agent:boekhouder:chat-lose",
        "x-client-request-id": "agent:boekhouder:chat-lose",
        "x-session-affinity": "agent:boekhouder:chat-lose",
      },
      { metadata: { conversation_id: "chat-win" } },
    ],
  ];
  for (const [label, headers, body] of ladder) {
    const resolved = resolveConversation(reqWith(headers), body);
    assert.equal(resolved.chatSessionId, "chat-win", `precedence wrong: ${label}`);
  }
});

test("a conformant chat session id at the edges of the schema is accepted", () => {
  // The other half of the guard: it must not refuse what the control plane
  // would issue. Absent this, "refuse everything" would pass the test above.
  for (const id of ["a", "0", "chat-7", "abc_DEF-123", "default", "a".repeat(200)]) {
    const resolved = resolveConversation(
      reqWith({ session_id: `agent:boekhouder:${id}` }),
      {},
    );
    assert.equal(resolved.chatSessionId, id, `refused: ${JSON.stringify(id)}`);
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

// ── The ruling's load-bearing invariant: one URL per SDK session ──────
//
// The reader binds the hint ONCE, when the MCP session is created
// (`apps/cell/src/mcp-relay.ts`, inside `createSession`), so the hint only
// takes effect on the request that opens that session. The owner's ruling --
// one chat session is one agent session -- therefore rests on the hint being
// constant for the life of an SDK session. Today that holds because
// `resolveConversation` makes the two identifiers coincide when a caller names
// one (`conversationId: named ?? derived`, `chatSessionId: named`), so two
// requests sharing a session-store key necessarily carry the same hint.
//
// Nothing pinned that coupling. A refactor that keyed the store differently --
// a tenant prefix, say -- would let two requests share one RESUMED SDK session
// while carrying two different hints, and no test would have reddened.

test("two requests on one conversation key send one and the same hinted URL", () => {
  const first = resolveConversation(reqWith({ "x-booqi-chat-session": "chat-7" }), {
    messages: [{ role: "user", content: "hello" }],
  });
  const second = resolveConversation(reqWith({ "x-booqi-chat-session": "chat-7" }), {
    messages: [{ role: "user", content: "a completely different second turn" }],
  });

  // Same store key, so the SDK session is resumed rather than restarted...
  assert.equal(first.conversationId, second.conversationId);
  // ...and the hint the store key implies is the hint that gets written.
  assert.equal(first.chatSessionId, second.chatSessionId);
  assert.equal(first.chatSessionId, first.conversationId);

  const urlFor = (hint: string | undefined) => {
    const opts = buildQueryOptions(
      "claude-opus-4-6", undefined, undefined, "sdk-1", configWithMcp, new AbortController(),
      { chatSessionId: hint },
    );
    return opts.mcpServers.booqi.url as string;
  };

  assert.equal(urlFor(first.chatSessionId), urlFor(second.chatSessionId));
  assert.equal(urlFor(first.chatSessionId), `${MCP_URL}?session=chat-7`);
});

// ── The hint must not be mistaken for a stale SDK session ─────────────

test("an SDK error quoting the hinted URL does not discard the conversation", async () => {
  // The stale-session retry arm matches /no conversation found|session/i and,
  // when it fires, drops `resumeSessionId`, mints a new SDK session id and
  // OVERWRITES the store -- i.e. it throws the user's conversation away. This
  // PR is what puts the substring `session=` into the URL the bridge hands the
  // SDK, and an MCP transport error routinely quotes the URL it could not
  // reach. Without the guard the bridge would read its OWN hint as evidence
  // that the session had expired.
  const retrying: BridgeConfig = { ...configWithMcp, maxRetries: 0 };
  const { sessionStore } = __testing.initialiseStores(retrying);
  sessionStore.record("conv-1", "live-sdk-session");

  const captured: Captured[] = [];
  __testing.setQuery((({ options }: any) => {
    captured.push({ options });
    return (async function* () {
      // The shape an MCP transport failure takes: the URL, verbatim, hint and all.
      throw new Error(`MCP server "booqi" failed to connect: GET ${MCP_URL}?session=chat-7 ECONNREFUSED`);
    })();
  }) as unknown as QueryFn);
  __testing.setLog(() => {});
  const res = fakeRes();

  try {
    await executeWithRetries(
      "hello", "claude-opus-4-6", "you are a bookkeeper", "conv-1",
      false, res, "req-1", retrying, "chat-7",
    );
  } finally {
    __testing.setQuery(undefined);
    __testing.setLog(undefined);
  }

  // The conversation survived: the store still points at the live SDK session.
  assert.equal(
    sessionStore.get("conv-1")?.claudeSessionId, "live-sdk-session",
    "the bridge read its own session hint as a stale SDK session and discarded the conversation",
  );
  // And a genuine stale-session text is still recognised -- the fix removes
  // the collision, it does not narrow the rule.
  assert.equal(captured.length, 1);
});

test("a genuine stale-session error is still recognised", async () => {
  const retrying: BridgeConfig = { ...configWithMcp, maxRetries: 1 };
  const { sessionStore } = __testing.initialiseStores(retrying);
  sessionStore.record("conv-1", "stale-sdk-session");

  const captured: Captured[] = [];
  __testing.setQuery(fakeQueryFailingOnce(captured));
  __testing.setLog(() => {});
  const res = fakeRes();

  try {
    await executeWithRetries(
      "hello", "claude-opus-4-6", "you are a bookkeeper", "conv-1",
      false, res, "req-1", retrying, "chat-7",
    );
  } finally {
    __testing.setQuery(undefined);
    __testing.setLog(undefined);
  }

  // "no conversation found for session" still triggers the fresh-session retry.
  assert.ok(captured.length >= 2, `expected the stale-session retry, saw ${captured.length} call(s)`);
  assert.notEqual(sessionStore.get("conv-1")?.claudeSessionId, "stale-sdk-session");
});
