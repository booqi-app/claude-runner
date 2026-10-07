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
 * with, recorded by a stand-in base function.
 *
 * 🔴 AND WHAT THIS BATTERY'S POPULATION IS, STATED UP FRONT, because round 1
 * shipped an 8-of-8 mutation kill rate over the WRONG population: every mutant
 * was applied inside `src/bridge-config.ts` and none at the registration site,
 * so the one line that actually wires the carrier into the host was uncovered
 * and a mutant deleting it survived a green suite. A kill rate is a statement
 * about a population.
 *
 *   COVERED HERE:      the carrier and its decision plan — what the base
 *                      `streamFn` receives, per existing-header state, per
 *                      session-id state, per context state, per per-call model.
 *   COVERED ELSEWHERE: the WIRING. `test/session-affinity-wire.test.ts` arms
 *                      `H6-bis` / `H6-ter` / `H6-quater` own the registration
 *                      on the plugin object, its survival of the host's two
 *                      resolution steps, and the hand-off to the bridge's
 *                      `examineAgentSessionKey` classifier. Those are NOT here
 *                      on purpose: this file imports the hook function directly
 *                      and therefore structurally cannot see the plugin object.
 *   COVERED NOWHERE:   the gateway-driven turn. ONGEMETEN, and not claimed.
 */
import { strict as assert } from "node:assert";
import { test } from "node:test";
import {
  CARRIER_PROVIDER_ID,
  SESSION_AFFINITY_HEADER_NAMES,
  applySessionAffinityHeaders,
  examineAffinityHeaders,
  planSessionAffinityHeaders,
  wrapClaudeRunnerStreamFn,
  type ProviderStreamOptions,
} from "../src/bridge-config.ts";
import { SESSION_AFFINITY_HEADERS } from "../src/claude-bridge.ts";

/** A bare lower-case uuid: the shape the host actually supplies. */
const UUID = "4f0a1c2e-7b3d-4e8a-9c61-25d7f8ab9013";

/**
 * Every arm asserts, and the self-check at the bottom enforces this count.
 * Ported from `test/session-affinity-wire.test.ts:59-66` — the repo's real
 * version of this guard. Round 1 shipped an arm NAMED "every declared arm ran"
 * that only re-read a constant's length, which is false assurance in precisely
 * the repo that was bitten by false green.
 */
const EXPECTED_ARMS = 21;
let armsRun = 0;
const arm = (name: string, fn: () => void | Promise<void>) =>
  test(name, async () => {
    armsRun += 1;
    await fn();
  });

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
    provider: CARRIER_PROVIDER_ID,
    streamFn: rec.fn,
    modelId: "sonnet",
    ...overrides,
  });
  assert.equal(typeof hook, "function", "the hook must return a replacement stream function");
  return { rec, call: hook as NonNullable<typeof hook> };
}

/* --- the load-bearing arm: the identifier REACHES the base function -------- */

arm("A1 the session id the transport would have dropped arrives in the headers the base streamFn receives", () => {
  const { rec, call } = wrapped();
  const out = call("model-x", { turn: 1 }, { sessionId: UUID, headers: { "content-type": "application/json" } });

  assert.equal(rec.calls.length, 1, "the base streamFn must still be called exactly once");
  const seen = rec.calls[0]!.options!;
  assert.equal(seen.headers?.session_id, UUID);
  for (const name of SESSION_AFFINITY_HEADER_NAMES) {
    assert.equal(seen.headers?.[name], UUID, `header ${name} must carry the session id`);
  }
  assert.equal(seen.headers?.["content-type"], "application/json");
  assert.equal(seen.sessionId, UUID);
  assert.equal(out, "BASE_RETURN");
});

arm("A2 every other argument is forwarded unchanged, including arguments the host cannot currently produce", () => {
  const { rec, call } = wrapped();
  const model = { id: "m" };
  const context = { c: 1 };
  // Forward-tolerance only: every host layer between the agent core and the
  // transport passes exactly three arguments today, so `...rest` cannot fire in
  // production. Pinned so a future host argument is forwarded, not dropped.
  call(model, context, { sessionId: UUID }, "future-arg", 7);
  const c = rec.calls[0]!;
  assert.equal(c.model, model, "model must be forwarded by identity");
  assert.equal(c.context, context, "context must be forwarded by identity");
  assert.deepEqual(c.rest, ["future-arg", 7], "unknown trailing arguments must not be dropped");
});

arm("A3 the caller's own options bag is not mutated — the host keeps reading its object", () => {
  const { rec, call } = wrapped();
  const original: ProviderStreamOptions = { sessionId: UUID, headers: { a: "1" } };
  const originalHeaders = original.headers;
  call("m", {}, original);
  assert.deepEqual(original.headers, { a: "1" }, "the caller's headers must be untouched");
  assert.equal(original.headers, originalHeaders, "the caller's headers object must not be replaced");
  assert.notEqual(rec.calls[0]!.options, original, "the base must receive a copy, not the caller's bag");
});

arm("A5 a valid id with an EMPTY header bag is carried (the bag is created, not required)", () => {
  const { rec, call } = wrapped();
  call("m", {}, { sessionId: UUID, headers: {} });
  for (const name of SESSION_AFFINITY_HEADER_NAMES) {
    assert.equal(rec.calls[0]!.options!.headers![name], UUID);
  }
});

/* --- MAJOR 3: the THREE states of an existing header, each distinguished --- */

arm("H1 ABSENT: a name the host never sent is written into", () => {
  const plan = planSessionAffinityHeaders({ sessionId: UUID, headers: {} });
  assert.equal(plan.written, 3);
  assert.deepEqual(
    plan.decisions.map((d) => d.decision),
    ["written-into-absent", "written-into-absent", "written-into-absent"],
  );
});

arm("H2 PRESENT-AND-EMPTY: a name the host sent carrying nothing is written over, under the host's own key", () => {
  // The state round 1 could not distinguish: `A4` covered only present-and-real
  // and absent, so `if (held !== undefined) continue;` survived the battery.
  const plan = planSessionAffinityHeaders({
    sessionId: UUID,
    headers: { session_id: "", "x-client-request-id": "   " },
  });
  const byName = new Map(plan.decisions.map((d) => [d.header, d.decision]));
  assert.equal(byName.get("session_id"), "written-over-empty", "an empty host header is not a value");
  assert.equal(plan.headers?.session_id, UUID);
  // A whitespace-only value is NOT empty: it is a real (if useless) string the
  // host sent, so it is kept and the bridge refuses it visibly. Collapsing
  // "blank" into "absent" here would move an admission decision out of
  // `examineAgentSessionKey`, which owns it.
  assert.equal(byName.get("x-client-request-id"), "host-value-kept");
  assert.equal(plan.headers?.["x-client-request-id"], "   ");
});

arm("H3 PRESENT-AND-REAL: a host-set value is authoritative and is kept", () => {
  const { rec, call } = wrapped();
  call("m", {}, { sessionId: UUID, headers: { session_id: "HOST_SET" } });
  const h = rec.calls[0]!.options!.headers!;
  assert.equal(h.session_id, "HOST_SET", "an existing non-empty host value wins");
  assert.equal(h["x-session-affinity"], UUID, "the names the host left absent are still filled");
});

arm("H4 the three states are reported as three, not inferred from a total", () => {
  const plan = planSessionAffinityHeaders({
    sessionId: UUID,
    headers: { session_id: "HOST_SET", "x-client-request-id": "" },
  });
  assert.deepEqual(
    plan.decisions,
    [
      { header: "session_id", decision: "host-value-kept" },
      { header: "x-client-request-id", decision: "written-over-empty" },
      { header: "x-session-affinity", decision: "written-into-absent" },
    ],
    "the plan must name what it examined per header, never only a count",
  );
  assert.equal(plan.written, 2);
});

arm("H5 a host header is recognised CASE-INSENSITIVELY, so its value is not silently overridden", () => {
  // Header names are case-insensitive and the host dedupes them that way with
  // caller-wins. An exact-key lookup would miss `Session_Id`, we would add
  // `session_id`, and the host's merge would keep OURS -- the inverse of the
  // guarantee H3 states.
  const { rec, call } = wrapped();
  call("m", {}, { sessionId: UUID, headers: { Session_Id: "HOST_SET" } });
  const h = rec.calls[0]!.options!.headers!;
  assert.equal(h.Session_Id, "HOST_SET", "the host's value must survive under its own spelling");
  assert.equal(h.session_id, undefined, "a second, lower-cased duplicate must not be added");
});

arm("H6 an empty header under a DIFFERENT case is written under the host's spelling, not a second key", () => {
  const plan = planSessionAffinityHeaders({ sessionId: UUID, headers: { "X-Session-Affinity": "" } });
  assert.equal(plan.headers?.["X-Session-Affinity"], UUID, "written under the host's own key");
  assert.equal(plan.headers?.["x-session-affinity"], undefined, "no duplicate key was created");
});

/* --- the inert arms: absent / unusable identifiers change NOTHING --------- */

arm("B1 with no session id the options bag reaches the base BY IDENTITY — the wrapper is observably inert", () => {
  const { rec, call } = wrapped();
  const original: ProviderStreamOptions = { headers: { a: "1" } };
  call("m", {}, original);
  assert.equal(rec.calls[0]!.options, original, "an untouched path must not even reallocate");
});

arm("B2 an empty-string or non-string session id is NOT carried — absent, present-and-empty and present-and-wrong-type are all distinguished from a real value", () => {
  for (const bad of ["", 0, 1, true, false, null, {}, [], undefined]) {
    const { rec, call } = wrapped();
    call("m", {}, { sessionId: bad, headers: {} });
    const h = rec.calls[0]!.options!.headers!;
    for (const name of SESSION_AFFINITY_HEADER_NAMES) {
      assert.equal(h[name], undefined, `sessionId=${JSON.stringify(bad)} must not produce ${name}`);
    }
  }
});

arm("B3 an absent options argument is forwarded as absent, not invented", () => {
  const { rec, call } = wrapped();
  call("m", {});
  assert.equal(rec.calls[0]!.options, undefined);
  assert.equal(rec.calls.length, 1);
});

arm("B4 when all three names are already host-set the bag is returned BY IDENTITY — the second inertness path", () => {
  // `wrote === 0`. Round 1's docstring promised this was asserted and it was
  // not: deleting the guard left the battery green.
  const { rec, call } = wrapped();
  const original: ProviderStreamOptions = {
    sessionId: UUID,
    headers: { session_id: "a", "x-client-request-id": "b", "x-session-affinity": "c" },
  };
  call("m", {}, original);
  assert.equal(rec.calls[0]!.options, original, "nothing was written, so nothing may be reallocated");
  assert.equal(planSessionAffinityHeaders(original).written, 0);
});

arm("B5 a non-plain header bag is passed through UNTOUCHED rather than spread into an empty object", () => {
  // A `Headers` or `Map` spreads to `{}`, which would DROP every header the
  // host set -- including authorization -- on the GOOD path. We decline a shape
  // we cannot write into rather than destroy it.
  for (const exotic of [new Map([["authorization", "Bearer x"]]), ["authorization", "Bearer x"]]) {
    const { rec, call } = wrapped();
    const original = { sessionId: UUID, headers: exotic as never };
    call("m", {}, original);
    assert.equal(rec.calls[0]!.options, original, "a non-plain header bag must pass through by identity");
    assert.equal(planSessionAffinityHeaders(original).written, 0);
  }
  // ...while a null-prototype object IS a plain bag and is carried.
  const np = Object.create(null) as Record<string, unknown>;
  assert.equal(planSessionAffinityHeaders({ sessionId: UUID, headers: np }).written, 3);
});

arm("B6 `headers: null` is ABSENT, not an unwritable shape — it CARRIES", () => {
  // Round 2 briefly regressed this: the non-plain-bag guard tested only
  // `!== undefined`, so `null` took the decline path and the identifier was
  // silently dropped -- the defect this carrier exists to fix, reintroduced.
  // `{...null}` is `{}` and destroys nothing, so `null` means "nothing there"
  // exactly as `undefined` does. The host preserves a falsy `headers` verbatim.
  const { rec, call } = wrapped();
  call("m", {}, { sessionId: UUID, headers: null as never });
  for (const name of SESSION_AFFINITY_HEADER_NAMES) {
    assert.equal(rec.calls[0]!.options!.headers![name], UUID, `headers:null must still carry ${name}`);
  }
  assert.equal(planSessionAffinityHeaders({ sessionId: UUID, headers: null as never }).written, 3);
  // ...and it is symmetric with `undefined`, which has always carried.
  assert.equal(planSessionAffinityHeaders({ sessionId: UUID }).written, 3);
});

/* --- the per-call model does NOT gate the carrier, and that is a DECISION --- */

arm("C3 the per-call model is forwarded by identity and does NOT gate the carrier, whatever its provider says", () => {
  // This pins a REMOVED guard. A `perCallModelIsForeign` check was added in
  // round 2 to close reviewer A's MN-1 and removed in the same round: the leak
  // it closed is unreachable on this host version, while the silent DECLINE it
  // introduced is reachable, because `model.provider` is an ONGEMETEN field and
  // the resolved model may legitimately carry the api, the upstream vendor, or
  // a composite id. Fail-closed on an unmeasured field would reintroduce
  // exactly the `"bound": false` this carrier exists to fix.
  //
  // So: the carrier is gated by `ctx.provider` at install time and by nothing
  // else, and this arm fails the moment someone re-adds a per-call gate without
  // first measuring the field.
  for (const model of [
    { provider: "openai", id: "gpt" },
    { provider: "anthropic" },
    { provider: "openai-completions" },
    { provider: "claude-runner/claude-opus-4-6" },
    { provider: CARRIER_PROVIDER_ID },
    { id: "m" },
    { provider: 7 },
    null,
    "a string model",
    undefined,
  ]) {
    const { rec, call } = wrapped();
    call(model, {}, { sessionId: UUID, headers: {} });
    assert.equal(
      rec.calls[0]!.options!.headers!.session_id,
      UUID,
      `a per-call model of ${JSON.stringify(model)} must not disable the carrier`,
    );
    assert.equal(rec.calls[0]!.model, model, "the model must be forwarded by identity");
  }
});

/* --- the hook's own contract with the host -------------------------------- */

arm("C1 the hook declines (returns undefined) for anything it has no business in, which is the host's leave-it-alone answer", () => {
  const rec = recorder();
  const declines: [string, unknown][] = [
    ["another provider", { provider: "openai", streamFn: rec.fn }],
    ["a NEAR-MISS provider id", { provider: "claude-runner-v2", streamFn: rec.fn }],
    ["a prefixed provider id", { provider: "xclaude-runner", streamFn: rec.fn }],
    ["an absent provider", { streamFn: rec.fn }],
    ["a non-string provider", { provider: 7, streamFn: rec.fn }],
    ["a non-function streamFn", { provider: CARRIER_PROVIDER_ID, streamFn: "nope" }],
    ["an absent streamFn", { provider: CARRIER_PROVIDER_ID }],
    ["a null context", null],
    ["an undefined context", undefined],
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

arm("C2 the provider id is matched the way the HOST normalises it, not by exact key", () => {
  for (const variant of [CARRIER_PROVIDER_ID, "Claude-Runner", "  claude-runner  ", "CLAUDE-RUNNER"]) {
    const { rec, call } = wrapped({ provider: variant });
    call("m", {}, { sessionId: UUID });
    assert.equal(
      rec.calls[0]!.options!.headers!.session_id,
      UUID,
      `provider spelling ${JSON.stringify(variant)} must still be recognised`,
    );
  }
});

/* --- the duplications are not trusted ------------------------------------- */

arm("D1 the header names this module writes are exactly the ones the bridge examines, AND the bridge accepts them", () => {
  assert.deepEqual(
    [...SESSION_AFFINITY_HEADER_NAMES],
    [...SESSION_AFFINITY_HEADERS],
    "src/bridge-config.ts duplicates this list from src/claude-bridge.ts; a divergence means we write headers the bridge does not read",
  );
  // The constant agreeing is not enough: what matters is that the names are the
  // ones the CLASSIFIER renders a verdict on. Asserted through the classifier.
  const { rec, call } = wrapped();
  call("m", {}, { sessionId: UUID, headers: {} });
  const examined = examineAffinityHeaders([...SESSION_AFFINITY_HEADERS], rec.calls[0]!.options!.headers!);
  assert.equal(examined.length, 3, "the classifier examined a smaller population than it was given");
  for (const e of examined) {
    assert.equal(e.verdict.kind, "accepted", `the bridge does not accept what we wrote on ${e.header}`);
  }
});

/* --- the pure helper, so a mutant in it cannot hide behind the wrapper ---- */

arm("E1 applySessionAffinityHeaders returns a non-object argument by identity rather than inventing a bag", () => {
  assert.equal(applySessionAffinityHeaders(undefined), undefined);
  assert.equal(applySessionAffinityHeaders(null as never), null);
  assert.equal(planSessionAffinityHeaders(undefined).written, 0);
  assert.deepEqual(planSessionAffinityHeaders(undefined).decisions, []);
});

// ---------------------------------------------------------------------------
// self-check: a parse/registration break must not read as "0 failed"
// ---------------------------------------------------------------------------

test("battery self-check: every declared arm ran", () => {
  assert.equal(armsRun, EXPECTED_ARMS, `expected ${EXPECTED_ARMS} arms to run, ${armsRun} did`);
});
