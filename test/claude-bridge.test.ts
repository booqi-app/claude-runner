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

import { __testing, executeWithRetries, type QueryFn } from "../src/claude-bridge.ts";
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

/** Minimal ServerResponse stand-in: only what the handlers touch. */
function fakeRes() {
  return {
    headersSent: false,
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
      if (chunk) this.body += chunk;
      this.headersSent = true;
    },
  } as any;
}

async function run(opts: {
  systemPrompt: string | undefined;
  resumeSessionId?: string;
  compactSummary?: string;
  behaviour: "success" | "fail";
}) {
  const { sessionStore } = __testing.initialiseStores(config);
  const conversationId = "conv-1";

  if (opts.resumeSessionId) sessionStore.record(conversationId, opts.resumeSessionId);
  if (opts.compactSummary) {
    if (!opts.resumeSessionId) sessionStore.record(conversationId, "");
    sessionStore.setCompactSummary(conversationId, opts.compactSummary);
  }

  const captured: Captured[] = [];
  __testing.setQuery(fakeQuery(captured, opts.behaviour));
  const res = fakeRes();

  try {
    await executeWithRetries(
      "hello", "claude-opus-4-6", opts.systemPrompt, conversationId,
      false, res, "req-1", config,
    );
  } finally {
    __testing.setQuery(undefined);
  }

  return { captured, res, sessionStore, conversationId };
}

// ── AC-1: the prompt actually leaves the transport ──────────────────

test("the caller's system prompt reaches the SDK query options", async () => {
  // KILLS the mutant that severs the prompt at the buildQueryOptions call
  // sites: `buildQueryOptions(model, undefined, ...)`. Nothing in the old
  // suite observed the value that actually left executeWithRetries.
  const { captured } = await run({ systemPrompt: "you are a bookkeeper", behaviour: "success" });

  assert.equal(captured.length, 1);
  assert.equal(captured[0].options.systemPrompt, "you are a bookkeeper");
});

// ── AC-2: every turn, resumed or not ────────────────────────────────

test("a RESUMED turn still carries the system prompt into the SDK options", async () => {
  // THE regression test for the coupled defect. KILLS every spelling of the
  // resume gate -- `if (!resumeSessionId)`, `resumeSessionId ? undefined : p`,
  // `resumeSessionId === undefined ? p : undefined` -- because it asserts the
  // value the SDK receives, not the shape of the source.
  const { captured } = await run({
    systemPrompt: "you are a bookkeeper",
    resumeSessionId: "sdk-session-9",
    behaviour: "success",
  });

  assert.equal(captured[0].options.resume, "sdk-session-9", "precondition: this is a resumed turn");
  assert.equal(
    captured[0].options.systemPrompt, "you are a bookkeeper",
    "a resumed turn went out with no system prompt -- the persona flips after turn 1 (booqi-app/infra#202)",
  );
});

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

test("a compaction summary reaches the SDK prompt and is NOT restored after success", async () => {
  const { captured, sessionStore, conversationId } = await run({
    systemPrompt: "P", compactSummary: "SUMMARY-TEXT", behaviour: "success",
  });

  assert.ok(
    String(captured[0].options.systemPrompt).includes("SUMMARY-TEXT"),
    "the summary never reached the model",
  );
  assert.equal(
    sessionStore.get(conversationId)?.compactSummary, undefined,
    "the summary was replayed into the next turn although this one delivered it",
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

test("systemPromptMode append sends the preset form through the transport", async () => {
  const { sessionStore } = __testing.initialiseStores(config);
  void sessionStore;
  const captured: Captured[] = [];
  __testing.setQuery(fakeQuery(captured, "success"));

  try {
    await executeWithRetries(
      "hello", "claude-opus-4-6", "P", "conv-append", false, fakeRes(), "req-2",
      { ...config, systemPromptMode: "append" },
    );
  } finally {
    __testing.setQuery(undefined);
  }

  assert.deepEqual(captured[0].options.systemPrompt, {
    type: "preset", preset: "claude_code", append: "P",
  });
});
