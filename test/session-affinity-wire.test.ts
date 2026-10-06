/**
 * Slice S2' of booqi-app/infra#327 — route A, WIRE-LEVEL.
 *
 * WHY THIS FILE EXISTS IN THIS SHAPE, AND WHY THE PREVIOUS ONE WAS WORTHLESS.
 * The first attempt at this slice declared the session-affinity override in
 * `openclaw.plugin.json` and proved it with 12 manifest-level arms. The
 * manifest loaded, normalised, passed every assertion — and changed nothing on
 * the wire, because the live `discovery.run` this plugin registers makes
 * OpenClaw's provider-discovery runtime (`:510-523`) discard the synthetic
 * manifest provider. CI was green over an inert artefact. A human review caught
 * it; the battery structurally could not.
 *
 * So this battery asserts nothing about manifests, nothing about files parsing,
 * and nothing about an identifier appearing in a source file. It:
 *
 *   1. loads the REAL plugin (`index.ts`, imported, never re-typed),
 *   2. runs the REAL `register` and keeps the REAL registered provider,
 *   3. invokes the REAL `discovery.run` for BOTH of its branches,
 *   4. feeds the resulting models through the measured OpenClaw consumer gate
 *      and sends the computed headers over a REAL TCP socket to a real
 *      `node:http` server, asserting on the headers THAT SERVER RECEIVED,
 *   5. and runs the REAL auth flow to assert the flag did NOT also land on the
 *      strict `configPatch` path — the arm that fails if the flag is moved to
 *      `index.ts`'s `configPatch.models.providers[...]`, which is the shape
 *      that crashes the gateway with exit 78.
 *
 * The consumer gate in `wireHeadersFor` is a re-implementation of
 * OpenClaw 2026.7.1-beta.5 `packages/ai/src/providers/openai-completions.ts`:
 *   :1389        default                   sendSessionAffinityHeaders: false
 *   :1426-1427   resolution    model.compat.sendSessionAffinityHeaders ?? detected
 *   :620-624     emission      if (sessionId && compat.sendSessionAffinityHeaders)
 *                                headers.session_id            = sessionId
 *                                headers["x-client-request-id"] = sessionId
 *                                headers["x-session-affinity"]  = sessionId
 *   :644         those headers become the OpenAI client's `defaultHeaders`
 * OpenClaw is not installable in this job (no dependencies, no network), so the
 * gate is reproduced rather than imported. It is kept honest by NEGATIVE
 * CONTROLS: arms N1/N2 below drive the same fixture with the flag absent and
 * with no session id, and assert the three headers are then NOT received. A
 * fixture that cannot produce a red result proves nothing, so those arms are
 * what make the positive ones mean something.
 */

import { strict as assert } from "node:assert";
import { createServer } from "node:http";
import { registerHooks } from "node:module";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { test } from "node:test";
import { DEFAULT_PORT } from "../src/bridge-config.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, "..");
const PROVIDER_ID = "claude-runner";
const AFFINITY_HEADERS = ["session_id", "x-client-request-id", "x-session-affinity"] as const;

/** Every arm asserts; this is the count the self-check at the bottom enforces. */
const EXPECTED_ARMS = 28;
let armsRun = 0;
const arm = (name: string, fn: () => void | Promise<void>) =>
  test(name, async () => {
    armsRun += 1;
    await fn();
  });

// index.ts and src/*.ts import each other with `.js` specifiers, which is how
// OpenClaw's own loader resolves them. Node's bare type stripping does not
// remap the extension, so the plugin is unimportable without this hook. It is
// a loader detail only: it changes which FILE a specifier resolves to and
// nothing about the code under test.
//
// The SAME hook also redirects `./src/claude-bridge.js` -- and only that
// specifier -- to a two-function stub, because the real `startBridgeServer`
// binds a TCP socket on a FIXED port (`DEFAULT_PORT` 7779). On any machine
// where something already holds that port -- a dev host running the real
// gateway, for instance -- the real bridge start throws EADDRINUSE and
// `discovery.run` rethrows, so a battery that bound it would pass in CI and
// fail for the next reviewer. The seam is narrow and it is PROVED LIVE: arm E1
// asserts the stub was actually called, with the port the REAL
// `buildBridgeOptions` resolved. `src/bridge-config.ts` is untouched and real.
const BRIDGE_STUB_URL =
  "data:text/javascript," +
  encodeURIComponent(
    "export const calls = [];\n" +
      "export async function startBridgeServer(config) { calls.push(config); return { stub: true }; }\n" +
      "export async function stopBridgeServer() {}\n",
  );

registerHooks({
  resolve(spec, ctx, next) {
    if (spec.startsWith(".") && spec.endsWith(".js") && ctx.parentURL) {
      const asTs = new URL(spec, ctx.parentURL).href.replace(/\.js$/, ".ts");
      if (asTs.endsWith("/src/claude-bridge.ts")) {
        return { url: BRIDGE_STUB_URL, shortCircuit: true };
      }
      if (existsSync(fileURLToPath(asTs))) return { url: asTs, shortCircuit: true };
    }
    return next(spec, ctx);
  },
});

type AnyRec = Record<string, any>;

/**
 * The measured consumer gate. Returns the header bag that OpenClaw would hand
 * to the model client as `defaultHeaders` for this model and session id.
 */
function wireHeadersFor(model: AnyRec, sessionId: string | undefined): AnyRec {
  const detected = { sendSessionAffinityHeaders: false }; // :1389
  const resolved =
    model.compat?.sendSessionAffinityHeaders ?? detected.sendSessionAffinityHeaders; // :1426-1427
  const headers: AnyRec = { ...(model.headers ?? {}) };
  if (sessionId && resolved) {
    headers.session_id = sessionId;
    headers["x-client-request-id"] = sessionId;
    headers["x-session-affinity"] = sessionId;
  }
  return headers;
}

/** Sends the header bag over a real socket and returns what the server read. */
async function overTheWire(headers: AnyRec): Promise<AnyRec> {
  let received: AnyRec = {};
  const server = createServer((req, res) => {
    received = { ...req.headers };
    res.writeHead(200, { "content-type": "application/json" });
    res.end("{}");
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  try {
    const addr = server.address();
    if (!addr || typeof addr === "string") throw new Error("no port");
    const res = await fetch(`http://127.0.0.1:${addr.port}/v1/chat/completions`, {
      method: "POST",
      headers: { ...headers, "content-type": "application/json", connection: "close" },
      body: "{}",
    });
    assert.equal(res.status, 200);
    await res.text();
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
  return received;
}

async function loadPlugin() {
  const mod: AnyRec = await import(pathToFileURL(join(REPO, "index.ts")).href);
  return mod.default as AnyRec;
}

type Registered = { provider: AnyRec; services: AnyRec[] };

async function registerPlugin(): Promise<Registered> {
  const plugin = await loadPlugin();
  const out: Registered = { provider: {}, services: [] };
  plugin.register({
    registerService: (s: AnyRec) => out.services.push(s),
    registerProvider: (p: AnyRec) => {
      out.provider = p;
    },
  });
  assert.equal(out.provider.id, PROVIDER_ID, "the real register must register this provider");
  return out;
}

type Logs = { info: string[]; error: string[] };
const makeLogger = () => {
  const logs: Logs = { info: [], error: [] };
  return {
    logs,
    logger: {
      info: (v: string) => logs.info.push(v),
      error: (v: string) => logs.error.push(v),
    },
  };
};
const silentLogger = { info: () => {}, error: () => {} };

/** The config shape the reference cell actually has: written by the auth flow. */
function cellLikeConfig(models: AnyRec[]) {
  return {
    models: {
      providers: {
        [PROVIDER_ID]: {
          baseUrl: "http://127.0.0.1:7779/v1",
          apiKey: "claude-runner-local",
          api: "openai-completions",
          authHeader: false,
          models,
        },
      },
    },
    plugins: { entries: { "claude-runner": { enabled: true } } },
  };
}

async function runDiscoveryLogged(config: AnyRec): Promise<{ out: AnyRec | null; logs: Logs }> {
  const reg = await registerPlugin();
  const { logs, logger } = makeLogger();
  try {
    const result = await reg.provider.discovery.run({
      config,
      logger,
      workspaceDir: join(REPO, ".test-workspace"),
    });
    return { out: result as AnyRec | null, logs };
  } finally {
    // In a `finally`, deliberately. `index.ts` keeps `bridgeServer` in a MODULE
    // global, so an arm that threw before this ran would leave it non-null,
    // every later `ensureBridgeRunning` would short-circuit, and E1 would fail
    // with a message pointing at the wrong arm.
    for (const svc of reg.services) await svc.stop?.({ logger: silentLogger });
  }
}

async function runDiscovery(config: AnyRec): Promise<AnyRec | null> {
  return (await runDiscoveryLogged(config)).out;
}

async function runAuth(): Promise<AnyRec> {
  const reg = await registerPlugin();
  const method = reg.provider.auth.find((a: AnyRec) => a.id === "local");
  assert.ok(method, "the real provider must expose the `local` auth method");
  return (await method.run({
    prompter: { text: async () => "7779" },
    logger: silentLogger,
  })) as AnyRec;
}

const SESSION = "11111111-2222-4333-8444-555555555555";

// ---------------------------------------------------------------------------
// A. the plugin-enabled branch (no explicit models in config)
// ---------------------------------------------------------------------------

arm("A1 the plugin-enabled provider return carries the affinity override on every model", async () => {
  const out = await runDiscovery({ plugins: { entries: { "claude-runner": { enabled: true } } } });
  assert.ok(out?.provider, "discovery.run must return a provider on the plugin-enabled branch");
  const models = out.provider.models as AnyRec[];
  assert.ok(models.length > 0, "the branch must advertise models");
  for (const m of models) {
    assert.equal(
      m.compat?.sendSessionAffinityHeaders,
      true,
      `model ${m.id} reaches the model layer without the override`,
    );
  }
});

arm("A2 every model that branch advertises arrives over the wire with all three headers", async () => {
  const out = await runDiscovery({ plugins: { entries: { "claude-runner": { enabled: true } } } });
  const models = out!.provider.models as AnyRec[];
  for (const m of models) {
    const received = await overTheWire(wireHeadersFor(m, SESSION));
    for (const h of AFFINITY_HEADERS) {
      assert.equal(received[h], SESSION, `model ${m.id}: header ${h} never arrived`);
    }
  }
});

// ---------------------------------------------------------------------------
// B. the explicit-config branch — THE ONE THE REFERENCE CELL TAKES
// ---------------------------------------------------------------------------

arm("B1 the explicit-config provider return carries the override, though the config has none", async () => {
  const configModels = [
    { id: "claude-opus-4-6", api: "openai-completions", contextWindow: 200000, maxTokens: 16384 },
    { id: "claude-haiku-4-5", api: "openai-completions", contextWindow: 200000, maxTokens: 8192 },
  ];
  const config = cellLikeConfig(configModels);
  const out = await runDiscovery(config);
  const models = out!.provider.models as AnyRec[];
  assert.equal(models.length, configModels.length);
  for (const m of models) {
    assert.equal(m.compat?.sendSessionAffinityHeaders, true, `model ${m.id} lost the override`);
  }
});

arm("B2 the explicit-config branch arrives over the wire with all three headers", async () => {
  const out = await runDiscovery(
    cellLikeConfig([{ id: "claude-opus-4-6", api: "openai-completions" }]),
  );
  const received = await overTheWire(wireHeadersFor((out!.provider.models as AnyRec[])[0], SESSION));
  for (const h of AFFINITY_HEADERS) assert.equal(received[h], SESSION, `header ${h} never arrived`);
});

arm("B3 the explicit-config branch is not mutated in place: the caller's config object is untouched", async () => {
  const configModels = [{ id: "claude-opus-4-6", api: "openai-completions" }];
  const config = cellLikeConfig(configModels);
  const before = JSON.stringify(config);
  await runDiscovery(config);
  assert.equal(JSON.stringify(config), before, "discovery.run wrote the override back into config");
  assert.equal(
    JSON.stringify(config).includes("sendSessionAffinityHeaders"),
    false,
    "the flag reached the config object, which is the strict path that exits 78",
  );
});

arm("B4 an operator's other compat keys survive; only this one is forced", async () => {
  const config = cellLikeConfig([
    { id: "claude-opus-4-6", api: "openai-completions", compat: { noParallelToolCalls: true } },
  ]);
  const out = await runDiscovery(config);
  const m = (out!.provider.models as AnyRec[])[0];
  assert.equal(m.compat.noParallelToolCalls, true, "an unrelated compat key was dropped");
  assert.equal(m.compat.sendSessionAffinityHeaders, true);
});

arm("B7 a non-object row in the config models array is handed back untouched", async () => {
  // Before this slice the array was passed through whole, so a malformed row
  // never got dereferenced on this path. A string row spread into an object
  // becomes {"0":"j","1":"u",...} and a null row throws -- both would be new
  // failure modes introduced by decorating the array.
  const out = await runDiscovery(
    cellLikeConfig([
      { id: "claude-opus-4-6", api: "openai-completions" },
      null,
      "junk",
      5,
    ] as AnyRec[]),
  );
  const models = out!.provider.models as AnyRec[];
  assert.equal(models.length, 4);
  assert.equal(models[0].compat.sendSessionAffinityHeaders, true);
  assert.equal(models[1], null, "a null row was mangled instead of passed through");
  assert.equal(models[2], "junk", "a string row was spread into an object");
  assert.equal(models[3], 5, "a numeric row was spread into an object");
});

arm("B6 a pre-existing FALSE value on the config model is overridden, not honoured", async () => {
  // The only way that value can be in `openclaw.json` is the strict path, which
  // crash-loops the gateway before this code runs, so a false found here is not
  // a considered operator choice. This arm pins the merge ORDER: ours last.
  const out = await runDiscovery(
    cellLikeConfig([
      {
        id: "claude-opus-4-6",
        api: "openai-completions",
        compat: { sendSessionAffinityHeaders: false },
      },
    ]),
  );
  assert.equal((out!.provider.models as AnyRec[])[0].compat.sendSessionAffinityHeaders, true);
});

arm("B5 the branch still resolves baseUrl/api/apiKey, so the override did not displace them", async () => {
  const out = await runDiscovery(
    cellLikeConfig([{ id: "claude-opus-4-6", api: "openai-completions" }]),
  );
  assert.equal(out!.provider.api, "openai-completions");
  assert.equal(out!.provider.apiKey, "claude-runner-local");
  assert.match(String(out!.provider.baseUrl), /^http:\/\/127\.0\.0\.1:\d+\/v1$/);
  assert.equal(out!.provider.authHeader, false);
});

// ---------------------------------------------------------------------------
// C. coverage — a newly advertised model cannot silently lose the override
// ---------------------------------------------------------------------------

arm("C1 the plugin-enabled branch covers exactly the ids the explicit branch would, and all carry it", async () => {
  const out = await runDiscovery({ plugins: { entries: { "claude-runner": { enabled: true } } } });
  const ids = (out!.provider.models as AnyRec[]).map((m) => m.id).sort();
  assert.ok(ids.length >= 4, `expected the advertised model set, got ${JSON.stringify(ids)}`);
  const withFlag = (out!.provider.models as AnyRec[])
    .filter((m) => m.compat?.sendSessionAffinityHeaders === true)
    .map((m) => m.id)
    .sort();
  assert.deepEqual(withFlag, ids, "some advertised model is not covered by the override");
});

arm("C2 every advertised id also carries the dimensions the model layer requires", async () => {
  // NOTE, corrected in review: the `if (!row.contextWindow || !row.maxTokens)`
  // gate at `provider-discovery.runtime.ts:167` drops a row lacking EITHER
  // dimension, and it lives in `modelDefinitionFromManifestRow`, i.e. on the
  // MANIFEST path this PR reverts. `grep -an contextWindow` over that file
  // returns only :167 and :181, so there is no equivalent gate on the
  // provider-return path used here. This arm is kept as a plain regression
  // guard on `MODELS`, not as a claim about that gate.
  const out = await runDiscovery({ plugins: { entries: { "claude-runner": { enabled: true } } } });
  for (const m of out!.provider.models as AnyRec[]) {
    assert.equal(typeof m.contextWindow, "number", `model ${m.id} has no contextWindow`);
    assert.equal(typeof m.maxTokens, "number", `model ${m.id} has no maxTokens`);
  }
});

// ---------------------------------------------------------------------------
// D. THE PATH-DISTINGUISHING ARMS
// These fail if the flag is placed on `configPatch.models.providers[...]`
// (the auth flow's `configPatch`) instead of on the provider return. That placement reaches
// `openclaw.json`, where the per-model `compat` object is `.strict()` over 24
// enumerated keys, and an unknown key there crash-loops the gateway at exit 78.
// ---------------------------------------------------------------------------

arm("D1 the auth configPatch carries the flag nowhere at all", async () => {
  const res = await runAuth();
  const serialised = JSON.stringify(res.configPatch);
  assert.equal(
    serialised.includes("sendSessionAffinityHeaders"),
    false,
    "the flag is on the configPatch path -- that is the exit-78 shape",
  );
});

arm("D2 no configPatch model carries a `compat` object at all", async () => {
  const res = await runAuth();
  const models = res.configPatch.models.providers[PROVIDER_ID].models as AnyRec[];
  assert.ok(models.length > 0, "the auth flow must still patch in the models");
  for (const m of models) {
    assert.equal("compat" in m, false, `configPatch model ${m.id} carries compat`);
  }
});

arm("D3 configPatch model keys stay inside the set that validates, byte for byte", async () => {
  const allowed = ["id", "name", "reasoning", "input", "cost", "contextWindow", "maxTokens", "api"];
  const res = await runAuth();
  const models = res.configPatch.models.providers[PROVIDER_ID].models as AnyRec[];
  for (const m of models) {
    const extra = Object.keys(m).filter((k) => !allowed.includes(k));
    assert.deepEqual(extra, [], `configPatch model ${m.id} grew key(s) ${JSON.stringify(extra)}`);
  }
});

arm("D4 the two surfaces genuinely disagree: return has the flag, configPatch does not", async () => {
  const auth = await runAuth();
  const disc = await runDiscovery({ plugins: { entries: { "claude-runner": { enabled: true } } } });
  const patched = auth.configPatch.models.providers[PROVIDER_ID].models as AnyRec[];
  const returned = disc!.provider.models as AnyRec[];
  // Same model population on both surfaces, so this is a real comparison and
  // not an artefact of one side being empty.
  assert.deepEqual(
    patched.map((m) => m.id).sort(),
    returned.map((m) => m.id).sort(),
    "the two surfaces advertise different models, so they cannot be compared",
  );
  assert.deepEqual(
    patched.filter((m) => m.compat?.sendSessionAffinityHeaders === true).map((m) => m.id),
    [],
    "configPatch side carries the flag",
  );
  assert.deepEqual(
    returned.filter((m) => m.compat?.sendSessionAffinityHeaders === true).map((m) => m.id).sort(),
    returned.map((m) => m.id).sort(),
    "provider-return side is missing the flag",
  );
});

// ---------------------------------------------------------------------------
// E. the seam is live, not silently bypassed
// ---------------------------------------------------------------------------

arm("E1 the real discovery.run really did start the bridge, at the real resolved port", async () => {
  const stub: AnyRec = await import(BRIDGE_STUB_URL);
  const before = stub.calls.length;
  await runDiscovery({ plugins: { entries: { "claude-runner": { enabled: true } } } });
  assert.ok(
    stub.calls.length > before,
    "startBridgeServer was never called: discovery.run did not take the real path",
  );
  const cfg = stub.calls[stub.calls.length - 1];
  // Port-AGNOSTIC on purpose: `register()` reads a gitignored `config.json`
  // from the extension dir, so pinning DEFAULT_PORT would go red for a
  // reviewer who has one -- the same "green in CI, red for the next reader"
  // class the bridge stub exists to kill. What matters is that the port came
  // from the real `buildBridgeOptions` and is the one the provider advertises.
  assert.equal(typeof cfg.port, "number", "the port did not come from the real buildBridgeOptions");
  assert.ok(cfg.port > 0 && cfg.port < 65536, `implausible port ${cfg.port}`);
  const advertised = await runDiscovery({ plugins: { entries: { "claude-runner": { enabled: true } } } });
  assert.equal(String(advertised!.provider.baseUrl), `http://127.0.0.1:${cfg.port}/v1`);
  assert.equal(typeof cfg.workDir, "string");
});

arm("E2 a disabled plugin with no explicit models discovers nothing", async () => {
  // The null branch, so A1/B1 are evidence that the override rides a provider
  // that was genuinely built and not that the function always returns one.
  const out = await runDiscovery({ models: { providers: {} }, plugins: { entries: {} } });
  assert.equal(out, null);
});

// ---------------------------------------------------------------------------
// H. THE HOST MERGE — the hop the first two batteries on this slice were blind to
//
// Round 1's battery stopped at the manifest. Round 2's stopped at the value
// `discovery.run` RETURNS. Both were green and both were upstream of the gate
// that threw the value away. These arms reproduce the measured host merge and
// assert on what comes OUT of it, so the battery's observation point is now
// past every hop a reviewer identified as a drop.
//
// Reproduced from OpenClaw 2026.7.1-beta.5:
//   src/agents/models-config.providers.implicit.ts
//     :46-53     PROVIDER_IMPLICIT_MERGERS — only `ollama`; a plugin cannot
//                register into this host-side table
//     :278-294   the merge itself, incl. `models: existing.models.length > 0
//                ? existing.models : implicit.models`
//   src/agents/models-config.merge.ts
//     :80-118    mergeProviderModels — rebuilds each row from `explicitModel`
//                and copies ONLY input/reasoning/contextWindow/contextTokens/
//                maxTokens off the implicit row. `compat` is not in that list.
// ---------------------------------------------------------------------------

/** implicit.ts:46-53 — the host-side table, with its real single entry. */
const HOST_IMPLICIT_MERGERS = new Set(["ollama"]);

/** merge.ts:80-118 — the wildcard path. Note what it does NOT copy. */
function hostMergeProviderModels(implicit: AnyRec, explicit: AnyRec): AnyRec {
  const implicitById = new Map<string, AnyRec>(
    (implicit.models ?? []).map((m: AnyRec) => [m.id, m] as const),
  );
  const seen = new Set<string>();
  const merged: AnyRec[] = (explicit.models ?? []).map((em: AnyRec) => {
    if (!em.id) return em;
    seen.add(em.id);
    const im = implicitById.get(em.id);
    if (!im) return em;
    return Object.assign(
      {},
      em,
      {
        input: "input" in em ? em.input : im.input,
        reasoning: "reasoning" in em ? em.reasoning : im.reasoning,
      },
      "contextWindow" in em || im.contextWindow === undefined
        ? {}
        : { contextWindow: im.contextWindow },
      "maxTokens" in em || im.maxTokens === undefined ? {} : { maxTokens: im.maxTokens },
    );
  });
  for (const im of implicit.models ?? []) {
    if (!im.id || seen.has(im.id)) continue;
    seen.add(im.id);
    merged.push(im);
  }
  return { ...implicit, ...explicit, models: merged };
}

/** implicit.ts:278-294 — what the host actually does with a discovery return. */
function hostMergeImplicitProvider(params: {
  providerId: string;
  existing: AnyRec | undefined;
  implicit: AnyRec;
  dynamicProviderModels?: boolean;
}): AnyRec {
  const { providerId, existing, implicit } = params;
  if (!existing) return implicit;
  if (HOST_IMPLICIT_MERGERS.has(providerId)) return implicit;
  if (params.dynamicProviderModels) return hostMergeProviderModels(implicit, existing);
  return {
    ...implicit,
    ...existing,
    models:
      Array.isArray(existing.models) && existing.models.length > 0
        ? existing.models
        : implicit.models,
  };
}

/**
 * The reference cell's own provider entry, read off the dev host at
 * 2026-10-06T09:07Z: 3 rows, no `compat`, no `api`, and `timeoutSeconds` set.
 * Hard-coded rather than fetched: CI has no access to that host, and the point
 * is to pin the SHAPE that was measured, not to re-measure it here.
 */
const CELL_PROVIDER_ENTRY = {
  baseUrl: "http://127.0.0.1:7779/v1",
  apiKey: "claude-runner-local",
  authHeader: false,
  timeoutSeconds: 600,
  models: [
    { id: "claude-opus-4-6", name: "Claude Opus 4.6 (SDK)", reasoning: true, input: ["text", "image"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 200000, maxTokens: 16384 },
    { id: "claude-sonnet-4-6", name: "Claude Sonnet 4.6 (SDK)", reasoning: true, input: ["text", "image"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 200000, maxTokens: 16384 },
    { id: "claude-haiku-4-5", name: "Claude Haiku 4.5 (SDK)", reasoning: false, input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 200000, maxTokens: 8192 },
  ],
};

const cellConfig = () => ({
  models: { providers: { [PROVIDER_ID]: structuredClone(CELL_PROVIDER_ENTRY) } },
  plugins: { entries: { "claude-runner": { enabled: true } } },
});

arm("H1 plugin-advertised route: the flag survives the host merge and reaches the wire", async () => {
  const config = { plugins: { entries: { "claude-runner": { enabled: true } } } };
  const out = await runDiscovery(config);
  const mergedProvider = hostMergeImplicitProvider({
    providerId: PROVIDER_ID,
    existing: undefined,
    implicit: out!.provider,
  });
  const models = mergedProvider.models as AnyRec[];
  assert.ok(models.length > 0);
  for (const m of models) {
    assert.equal(m.compat?.sendSessionAffinityHeaders, true, `${m.id} lost the flag in the merge`);
    const received = await overTheWire(wireHeadersFor(m, SESSION));
    for (const h of AFFINITY_HEADERS) {
      assert.equal(received[h], SESSION, `${m.id}: header ${h} never arrived`);
    }
  }
});

arm("H2 config-declared route: the host DISCARDS the flag and nothing reaches the wire", async () => {
  // This arm asserts the DEFECT, measured. It is red if the host merge ever
  // stops preferring the config array -- which is the day this slice's
  // config-declared branch starts working and the log line has to change.
  const config = cellConfig();
  const out = await runDiscovery(config);
  const mergedProvider = hostMergeImplicitProvider({
    providerId: PROVIDER_ID,
    existing: config.models.providers[PROVIDER_ID],
    implicit: out!.provider,
  });
  const models = mergedProvider.models as AnyRec[];
  assert.equal(models.length, 3, "the cell's three rows should come through the merge");
  for (const m of models) {
    assert.equal(
      m.compat?.sendSessionAffinityHeaders,
      undefined,
      `${m.id} unexpectedly kept the flag: re-read implicit.ts:287-294`,
    );
    const received = await overTheWire(wireHeadersFor(m, SESSION));
    for (const h of AFFINITY_HEADERS) {
      assert.equal(received[h], undefined, `${m.id}: ${h} arrived after all`);
    }
  }
});

arm("H3 the wildcard path is a second, independent drop", async () => {
  const config = cellConfig();
  const out = await runDiscovery(config);
  const mergedProvider = hostMergeImplicitProvider({
    providerId: PROVIDER_ID,
    existing: config.models.providers[PROVIDER_ID],
    implicit: out!.provider,
    dynamicProviderModels: true,
  });
  for (const m of mergedProvider.models as AnyRec[]) {
    assert.equal(
      m.compat?.sendSessionAffinityHeaders,
      undefined,
      `${m.id} kept the flag through mergeProviderModels: re-read merge.ts:80-118`,
    );
  }
});

arm("H4 the host-merge fixture is not vacuous: with no config rows the implicit models win", async () => {
  // Without this arm H2/H3 could pass against a fixture that drops everything.
  const out = await runDiscovery({ plugins: { entries: { "claude-runner": { enabled: true } } } });
  const mergedProvider = hostMergeImplicitProvider({
    providerId: PROVIDER_ID,
    existing: { baseUrl: "http://127.0.0.1:7779/v1", models: [] },
    implicit: out!.provider,
  });
  const models = mergedProvider.models as AnyRec[];
  assert.ok(models.length > 0, "the fixture dropped the implicit models too");
  for (const m of models) assert.equal(m.compat?.sendSessionAffinityHeaders, true);
});

// ---------------------------------------------------------------------------
// R. the plugin REPORTS the route rather than failing silently
// ---------------------------------------------------------------------------

arm("R1 config-declared route logs on the ERROR channel, with 0 effective and the remedy", async () => {
  const { logs } = await runDiscoveryLogged(cellConfig());
  const line = logs.error.find((l) => l.includes("session-affinity override"));
  assert.ok(line, `no session-affinity verdict on the error channel; got ${JSON.stringify(logs)}`);
  assert.match(line!, /WILL BE DISCARDED/);
  assert.match(line!, /examined 3 model rows: 0 effective, 3 discarded-by-host\./);
  assert.match(line!, /REMEDY: delete the "models" array/);
  assert.equal(
    logs.info.some((l) => l.includes("session-affinity override ACTIVE")),
    false,
    "it also claimed the override was active",
  );
});

arm("R2 plugin-advertised route logs on the INFO channel and leaves the error channel clean", async () => {
  const { out, logs } = await runDiscoveryLogged({
    plugins: { entries: { "claude-runner": { enabled: true } } },
  });
  const count = (out!.provider.models as AnyRec[]).length;
  const line = logs.info.find((l) => l.includes("session-affinity override"));
  assert.ok(line, `no session-affinity verdict on the info channel; got ${JSON.stringify(logs)}`);
  assert.match(line!, /ACTIVE on the plugin-advertised model catalog/);
  assert.ok(
    line!.includes(`examined ${count} model rows: ${count} effective, 0 discarded-by-host.`),
    `count disagrees with the advertised catalog (${count}): ${line}`,
  );
  assert.equal(
    logs.error.some((l) => l.includes("session-affinity override")),
    false,
    "it reported a discard on the route where the override works",
  );
});

arm("R3 the verdict counts the rows the HOST will use, not the rows the plugin knows", async () => {
  // The cell declares 3; the plugin advertises 4. A report that counted its own
  // catalog would say 4 and be wrong about the cell.
  const { out, logs } = await runDiscoveryLogged(cellConfig());
  assert.equal((out!.provider.models as AnyRec[]).length, 3);
  const line = logs.error.find((l) => l.includes("session-affinity override"))!;
  assert.match(line, /examined 3 model rows/);
  const advertised = await runDiscovery({ plugins: { entries: { "claude-runner": { enabled: true } } } });
  assert.notEqual(
    (advertised!.provider.models as AnyRec[]).length,
    3,
    "the two catalogues happen to be the same size, so this arm proves nothing",
  );
});

// ---------------------------------------------------------------------------
// N. NEGATIVE CONTROLS on the wire fixture itself
// ---------------------------------------------------------------------------

arm("N1 without the override the same fixture puts none of the three on the wire", async () => {
  const received = await overTheWire(
    wireHeadersFor({ id: "no-compat", api: "openai-completions" }, SESSION),
  );
  for (const h of AFFINITY_HEADERS) {
    assert.equal(received[h], undefined, `fixture emitted ${h} with no override: it cannot fail`);
  }
});

arm("N2 with the override but no session id the fixture still emits nothing", async () => {
  const received = await overTheWire(
    wireHeadersFor({ id: "x", compat: { sendSessionAffinityHeaders: true } }, undefined),
  );
  for (const h of AFFINITY_HEADERS) assert.equal(received[h], undefined, `${h} emitted anyway`);
});

arm("N3 an explicit compat:false on the model is still honoured by the gate", async () => {
  // Proves the gate reads the value rather than the key's presence, so A2/B2
  // are evidence about the value `true` and not about the object existing.
  const received = await overTheWire(
    wireHeadersFor({ id: "x", compat: { sendSessionAffinityHeaders: false } }, SESSION),
  );
  for (const h of AFFINITY_HEADERS) assert.equal(received[h], undefined, `${h} emitted anyway`);
});

arm("N4 the socket really is the observation point: a control header does arrive", async () => {
  const received = await overTheWire({ "x-booqi-control": "present" });
  assert.equal(received["x-booqi-control"], "present", "the server observes nothing at all");
});

// ---------------------------------------------------------------------------
// self-check: a parse/registration break must not read as "0 failed"
// ---------------------------------------------------------------------------

test("battery self-check: every declared arm ran", () => {
  assert.equal(
    armsRun,
    EXPECTED_ARMS,
    `expected ${EXPECTED_ARMS} arms to run, ${armsRun} did`,
  );
});
