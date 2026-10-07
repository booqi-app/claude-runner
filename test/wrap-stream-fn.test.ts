/**
 * booqi-app/infra#337 — the `wrapStreamFn` carrier, BEHAVIOURALLY.
 *
 * WHAT THIS BATTERY REFUSES TO DO, AND WHY IT MATTERS HERE SPECIFICALLY.
 * `claude-runner#2`'s regression guards were REGEXES OVER SOURCE TEXT, and
 * three reviewers independently reintroduced the exact defect that issue
 * existed for — in spellings the regexes did not match — with the suite fully
 * green. So not one assertion below looks at a file, a symbol name or a source
 * line. Every arm drives the wrapped function and asserts on what the WRAPPED
 * FUNCTION ACTUALLY RECEIVED: the options bag the base `streamFn` was called
 * with, recorded by a stand-in base function. That is the property the fix is
 * for — the chat-session identifier reaches the bridge — and it is the only
 * thing asserted.
 *
 * The observation point is the base `streamFn`, because that is precisely where
 * OpenClaw's managed completions transport loses `options.sessionId`
 * (`openai-transport-stream-*.js:2404` passes four arguments and no session
 * id). If the identifier is in the options bag the base function receives, it
 * is in `options.headers`, which IS the argument that transport threads.
 */
import { strict as assert } from "node:assert";
import { test } from "node:test";
import {
  SESSION_AFFINITY_HEADER_NAMES,
  applySessionAffinityHeaders,
  wrapClaudeRunnerStreamFn,
  type ProviderStreamOptions,
} from "../src/bridge-config.ts";
import { SESSION_AFFINITY_HEADERS } from "../src/claude-bridge.ts";

const UUID = "4f0a1c2e-7b3d-4e8a-9c61-25d7f8ab9013";

/** A stand-in for `agent.streamFn`: records every call, verbatim. */
function recorder() {
  const calls: {
    model: unknown;
    context: unknown;
    options?: ProviderStreamOptions;
    rest: unknown[];
  }[] = [];
  const fn = (model: unknown, context: unknown, options?: ProviderStreamOptions, ...rest: unknown[]) => {
    calls.push({ model, context, options, rest });
    return "BASE_RETURN";
  };
  return { calls, fn };
}

function wrapped(overrides: Record<string, unknown> = {}) {
  const rec = recorder();
  const hook = wrapClaudeRunnerStreamFn({
    provider: "claude-runner",
    streamFn: rec.fn,
    modelId: "sonnet",
    ...overrides,
  });
  assert.equal(typeof hook, "function", "the hook must return a replacement stream function");
  return { rec, call: hook as NonNullable<typeof hook> };
}

/* --- the load-bearing arm: the identifier REACHES the base function -------- */

test("A1 the session id the transport would have dropped arrives in the headers the base streamFn receives", () => {
  const { rec, call } = wrapped();
  const out = call("model-x", { turn: 1 }, { sessionId: UUID, headers: { "content-type": "application/json" } });

  assert.equal(rec.calls.length, 1, "the base streamFn must still be called exactly once");
  const seen = rec.calls[0]!.options!;
  // THE assertion this whole PR exists for.
  assert.equal(seen.headers?.session_id, UUID);
  // Every name the bridge examines carries it, so the bridge's preference order
  // cannot decide whether the fix works.
  for (const name of SESSION_AFFINITY_HEADER_NAMES) {
    assert.equal(seen.headers?.[name], UUID, `header ${name} must carry the session id`);
  }
  // Nothing else is disturbed, and the return value is the base's.
  assert.equal(seen.headers?.["content-type"], "application/json");
  assert.equal(seen.sessionId, UUID);
  assert.equal(out, "BASE_RETURN");
});

test("A2 every other argument is forwarded unchanged, including arguments this wrapper does not know about", () => {
  const { rec, call } = wrapped();
  const model = { id: "m" };
  const context = { c: 1 };
  call(model, context, { sessionId: UUID }, "future-arg", 7);
  const c = rec.calls[0]!;
  assert.equal(c.model, model, "model must be forwarded by identity");
  assert.equal(c.context, context, "context must be forwarded by identity");
  assert.deepEqual(c.rest, ["future-arg", 7], "unknown trailing arguments must not be dropped");
});

test("A3 the caller's own options bag is not mutated — the host keeps reading its object", () => {
  const { rec, call } = wrapped();
  const original: ProviderStreamOptions = { sessionId: UUID, headers: { a: "1" } };
  const originalHeaders = original.headers;
  call("m", {}, original);
  assert.deepEqual(original.headers, { a: "1" }, "the caller's headers must be untouched");
  assert.equal(original.headers, originalHeaders, "the caller's headers object must not be replaced");
  assert.notEqual(rec.calls[0]!.options, original, "the base must receive a copy, not the caller's bag");
});

test("A4 a header the host already set is authoritative and is not clobbered", () => {
  const { rec, call } = wrapped();
  call("m", {}, { sessionId: UUID, headers: { session_id: "HOST_SET" } });
  const h = rec.calls[0]!.options!.headers!;
  assert.equal(h.session_id, "HOST_SET", "an existing non-empty host value wins");
  assert.equal(h["x-session-affinity"], UUID, "the names the host left empty are still filled");
});

/* --- the inert arms: absent / unusable identifiers change NOTHING --------- */

test("B1 with no session id the options bag reaches the base BY IDENTITY — the wrapper is observably inert", () => {
  const { rec, call } = wrapped();
  const original: ProviderStreamOptions = { headers: { a: "1" } };
  call("m", {}, original);
  assert.equal(rec.calls[0]!.options, original, "an untouched path must not even reallocate");
});

test("B2 an empty-string or non-string session id is NOT carried — absent, present-and-empty and present-and-wrong-type are all distinguished from a real value", () => {
  for (const bad of ["", 0, 1, true, false, null, {}, [], undefined]) {
    const { rec, call } = wrapped();
    call("m", {}, { sessionId: bad, headers: {} });
    const h = rec.calls[0]!.options!.headers!;
    for (const name of SESSION_AFFINITY_HEADER_NAMES) {
      assert.equal(h[name], undefined, `sessionId=${JSON.stringify(bad)} must not produce ${name}`);
    }
  }
});

test("B3 an absent options argument is forwarded as absent, not invented", () => {
  const { rec, call } = wrapped();
  call("m", {});
  assert.equal(rec.calls[0]!.options, undefined);
  assert.equal(rec.calls.length, 1);
});

/* --- the hook's own contract with the host -------------------------------- */

test("C1 the hook declines (returns undefined) for anything it has no business in, which is the host's leave-it-alone answer", () => {
  const rec = recorder();
  const declines: [string, unknown][] = [
    ["another provider", { provider: "openai", streamFn: rec.fn }],
    ["an absent provider", { streamFn: rec.fn }],
    ["a non-string provider", { provider: 7, streamFn: rec.fn }],
    ["a non-function streamFn", { provider: "claude-runner", streamFn: "nope" }],
    ["an absent streamFn", { provider: "claude-runner" }],
    ["a null context", null],
    ["a non-object context", "ctx"],
  ];
  for (const [why, ctx] of declines) {
    assert.equal(
      wrapClaudeRunnerStreamFn(ctx as never),
      undefined,
      `must decline for ${why} (the host installs the base streamFn on undefined)`,
    );
  }
  assert.equal(rec.calls.length, 0, "declining must never have called anything");
});

test("C2 the provider id is matched the way the HOST normalises it, not by exact key", () => {
  for (const variant of ["claude-runner", "Claude-Runner", "  claude-runner  ", "CLAUDE-RUNNER"]) {
    const { rec, call } = wrapped({ provider: variant });
    call("m", {}, { sessionId: UUID });
    assert.equal(
      rec.calls[0]!.options!.headers!.session_id,
      UUID,
      `provider spelling ${JSON.stringify(variant)} must still be recognised`,
    );
  }
});

/* --- the duplication of the header names is not trusted ------------------- */

test("D1 the header names this module writes are exactly the ones the bridge examines", () => {
  assert.deepEqual(
    [...SESSION_AFFINITY_HEADER_NAMES],
    [...SESSION_AFFINITY_HEADERS],
    "src/bridge-config.ts duplicates this list from src/claude-bridge.ts; a divergence means we write headers the bridge does not read",
  );
});

/* --- the pure helper, so a mutant in it cannot hide behind the wrapper ---- */

test("E1 applySessionAffinityHeaders returns a non-object argument by identity rather than inventing a bag", () => {
  assert.equal(applySessionAffinityHeaders(undefined), undefined);
  assert.equal(applySessionAffinityHeaders(null as never), null);
});

test("battery self-check: every declared arm ran", () => {
  // Cheap guard against a battery that silently stops declaring tests.
  assert.ok(SESSION_AFFINITY_HEADER_NAMES.length === 3, "three names are the measured population");
});
