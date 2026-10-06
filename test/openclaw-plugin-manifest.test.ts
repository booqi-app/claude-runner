import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

/**
 * S2 / route A of booqi-app/infra#327: declare the session-affinity header
 * override for the claude-runner provider in the PLUGIN MANIFEST.
 *
 * WHY THIS FILE EXISTS, AND WHY THE SHAPE BELOW MUST NOT BE "SIMPLIFIED":
 *
 * OpenClaw 2026.7.1-beta.5 has TWO config paths, and they disagree about
 * `compat.sendSessionAffinityHeaders`:
 *
 *  (1) THE STRICT PATH - the user config (`openclaw.json`), i.e.
 *      `models.providers.<id>.models[]`. Validated by a zod schema whose
 *      per-model object ends in `.strict()`, with `compat: ModelCompatSchema`
 *      at src/config/zod-schema.core.ts:416. ModelCompatSchema is defined at
 *      src/config/zod-schema.core.ts:221-250, is `.strict()` at :250, and
 *      enumerates 24 compat fields - `sendSessionAffinityHeaders` is NOT one
 *      of them. An unrecognized key on a `.strict()` zod object is a
 *      validation ERROR, which is why putting this flag on a model entry in
 *      `openclaw.json` makes the gateway exit 78 and crash-loop (measured in
 *      block b1005-3). DO NOT MOVE THIS FLAG ONTO THAT PATH.
 *
 *  (2) THE PERMISSIVE PATH - the plugin manifest (`openclaw.plugin.json`),
 *      i.e. `modelCatalog.providers.<id>.models[]`. It is NOT zod-validated:
 *      src/plugins/manifest.ts:1786 runs it through
 *      `normalizeModelCatalog(raw.modelCatalog, { ownedProviders: ... })`.
 *      That normalizer copies compat flags from an explicit ALLOWLIST at
 *      packages/model-catalog-core/src/model-catalog-normalize.ts:373-395,
 *      and `"sendSessionAffinityHeaders"` IS in that allowlist, at line 388.
 *      `modelCatalog` does not appear in zod-schema.core.ts at all.
 *
 * So the flag is legal in `openclaw.plugin.json` and illegal in
 * `openclaw.json`. That asymmetry is why the declaration below LOADS at all,
 * and why it needs no patch to OpenClaw itself.
 *
 * ---------------------------------------------------------------------------
 * READ THIS BEFORE TRUSTING A GREEN RUN HERE.
 *
 * Loading is NOT the same as taking effect. Two independent reviews of this
 * change established that for THIS plugin the declaration below does not
 * currently reach a request, for a reason no arm in this file can see:
 * `index.ts` registers a live `discovery.run` hook, so
 * src/plugins/provider-discovery.runtime.ts:510-523 loads the REAL plugin
 * provider and DISCARDS the synthetic provider built from this manifest.
 * `resolvePluginProviders` wins; the manifest catalog loses.
 *
 * These arms are therefore MANIFEST-LEVEL only. They prove the declaration is
 * present, well-formed, owned by this manifest, dimensioned, and able to
 * survive `normalizeModelCatalog`. They prove NOTHING about a header on the
 * wire. The measured next step is to carry the flag on the provider RETURN in
 * index.ts (which is in-memory and never zod-validated) rather than through
 * `configPatch`, which lands in `openclaw.json` and would be rejected at
 * src/config/validation.ts:1055 - the b1005-3 exit-78 crash. See
 * booqi-app/infra#327.
 * ---------------------------------------------------------------------------
 *
 * The flag is what gates the headers at the transport. For an
 * `openai-completions` provider (which is what this plugin registers - see
 * index.ts, `api: "openai-completions"`) the consumer is
 * packages/ai/src/providers/openai-completions.ts:620-624:
 *
 *     if (sessionId && compat.sendSessionAffinityHeaders) {
 *       headers.session_id = sessionId;
 *       headers["x-client-request-id"] = sessionId;
 *       headers["x-session-affinity"] = sessionId;
 *     }
 *
 * Those are exactly the three header names S1's diagnostic examines, and S1
 * measured all three ABSENT on the reference cell (infra#327 comment
 * 6011336539) - because this flag defaulted to false.
 *
 * THE SILENT-DROP HAZARD these arms exist to catch:
 * `normalizeModelCatalogProviders`
 * (packages/model-catalog-core/src/model-catalog-normalize.ts:566-585)
 * skips any provider it does not own - `continue` at line 577, guarded by
 * `if (!providerId || !ownedProviders.has(providerId))`. `ownedProviders` is
 * built at src/plugins/manifest.ts:1787 from this manifest's own
 * `providers` + `cliBackends`. A typo in the provider key therefore yields a
 * manifest that LOADS CLEAN AND DOES NOTHING - no error, no warning.
 * Likewise `normalizeModelCatalogProvider` (:543-563) returns undefined when
 * `models` is not an array or normalizes to length 0, and
 * `normalizeModelCatalogModel` (:494-500) drops any entry without a string
 * `id`. Each of those silent drops gets an arm below.
 */

const manifestPath = join(dirname(fileURLToPath(import.meta.url)), "..", "openclaw.plugin.json");
const manifestRaw = readFileSync(manifestPath, "utf-8");
const manifest = JSON.parse(manifestRaw) as Record<string, any>;

const PROVIDER_ID = "claude-runner";
const AFFINITY_FLAG = "sendSessionAffinityHeaders";

/** The compat flags normalizeModelCatalogCompat will copy (allowlist at :373-395). */
const NORMALIZER_BOOLEAN_ALLOWLIST = new Set([
  "supportsStore",
  "supportsPromptCacheKey",
  "supportsDeveloperRole",
  "supportsReasoningEffort",
  "supportsUsageInStreaming",
  "supportsTools",
  "supportsStrictMode",
  "requiresStringContent",
  "strictMessageKeys",
  "requiresToolResultName",
  "requiresAssistantAfterToolResult",
  "requiresThinkingAsText",
  "requiresReasoningContentOnAssistantMessages",
  "zaiToolStream",
  "sendSessionAffinityHeaders",
  "sendSessionIdHeader",
  "supportsEagerToolInputStreaming",
  "supportsLongCacheRetention",
  "nativeWebSearchTool",
  "requiresMistralToolIds",
  "requiresOpenAiAnthropicToolPayload",
]);

/**
 * The 24 compat keys the STRICT openclaw.json schema accepts
 * (src/config/zod-schema.core.ts:221-249). Anything we declare that is NOT in
 * here would be fatal on that path - which is why this manifest must never be
 * copied into openclaw.json wholesale.
 */
const STRICT_SCHEMA_COMPAT_KEYS = new Set([
  "supportsStore",
  "supportsPromptCacheKey",
  "supportsDeveloperRole",
  "supportsReasoningEffort",
  "supportsUsageInStreaming",
  "supportsTools",
  "supportsStrictMode",
  "requiresStringContent",
  "strictMessageKeys",
  "visibleReasoningDetailTypes",
  "supportedReasoningEfforts",
  "reasoningEffortMap",
  "maxTokensField",
  "thinkingFormat",
  "requiresToolResultName",
  "requiresAssistantAfterToolResult",
  "requiresThinkingAsText",
  "requiresReasoningContentOnAssistantMessages",
  "toolSchemaProfile",
  "unsupportedToolSchemaKeywords",
  "nativeWebSearchTool",
  "toolCallArgumentsEncoding",
  "requiresMistralToolIds",
  "requiresOpenAiAnthropicToolPayload",
]);

/** Model ids this plugin advertises to OpenClaw, read out of index.ts. */
function readAdvertisedModelIdsFromIndex(): string[] {
  const indexPath = join(dirname(fileURLToPath(import.meta.url)), "..", "index.ts");
  const source = readFileSync(indexPath, "utf-8");
  const start = source.indexOf("const MODELS = [");
  assert.ok(start >= 0, "index.ts no longer declares `const MODELS = [` - update this test");
  const end = source.indexOf("\n];", start);
  assert.ok(end > start, "could not find the end of the MODELS array in index.ts");
  const block = source.slice(start, end);
  const ids = [...block.matchAll(/id:\s*"([^"]+)"/g)].map((m) => m[1]);
  assert.ok(ids.length > 0, "parsed zero model ids out of index.ts MODELS - reader is broken");
  return ids;
}

let armsRun = 0;
function arm(name: string, body: () => void) {
  test(name, () => {
    body();
    armsRun += 1;
  });
}

// ---------------------------------------------------------------------------
// AC-2 arm 1: the affinity override is declared, in the shape proved to load.
// Delete the key -> RED.
// ---------------------------------------------------------------------------

arm("AC-2.1: modelCatalog declares the affinity override for the claude-runner provider", () => {
  const catalog = manifest.modelCatalog;
  assert.ok(catalog, "openclaw.plugin.json has no `modelCatalog` - route A is not declared");
  const provider = catalog.providers?.[PROVIDER_ID];
  assert.ok(provider, `modelCatalog.providers["${PROVIDER_ID}"] is missing`);
  assert.ok(Array.isArray(provider.models), "provider.models must be an ARRAY");
  assert.ok(provider.models.length > 0, "provider.models is empty -> provider is silently dropped");
  for (const model of provider.models) {
    assert.equal(
      model?.compat?.[AFFINITY_FLAG],
      true,
      `model "${model?.id}" does not set compat.${AFFINITY_FLAG} === true`,
    );
  }
});

arm("AC-2.1b: the override covers EVERY model id this plugin advertises in index.ts", () => {
  const advertised = readAdvertisedModelIdsFromIndex();
  const declared = new Set(
    (manifest.modelCatalog?.providers?.[PROVIDER_ID]?.models ?? []).map((m: any) => m?.id),
  );
  // We cannot read the reference cell's hand-written openclaw.json from CI, so
  // we cannot know WHICH model it selects. Covering all advertised ids is the
  // mitigation; this arm keeps a newly added model from silently losing the
  // override.
  for (const id of advertised) {
    assert.ok(declared.has(id), `model "${id}" is advertised in index.ts but has no affinity override`);
  }
});

// ---------------------------------------------------------------------------
// AC-2 arm 2: the provider key must be OWNED, or normalizeModelCatalogProviders
// drops it silently (`continue`, model-catalog-normalize.ts:577).
// Typo the id -> RED.
// ---------------------------------------------------------------------------

arm("AC-2.2: every modelCatalog provider id is a member of the manifest's own owned providers", () => {
  const owned = new Set<string>([
    ...((manifest.providers ?? []) as string[]),
    ...((manifest.cliBackends ?? []) as string[]),
  ]);
  assert.ok(owned.size > 0, "manifest declares no providers/cliBackends - nothing can be owned");
  const declaredProviderIds = Object.keys(manifest.modelCatalog?.providers ?? {});
  assert.ok(declaredProviderIds.length > 0, "modelCatalog.providers is empty");
  for (const id of declaredProviderIds) {
    assert.ok(
      owned.has(id),
      `modelCatalog.providers["${id}"] is not in the manifest's providers/cliBackends ` +
        `(owned: ${[...owned].join(", ")}). normalizeModelCatalogProviders would SILENTLY DROP ` +
        `it at model-catalog-normalize.ts:577 - the manifest would load clean and do nothing.`,
    );
  }
  assert.ok(
    declaredProviderIds.includes(PROVIDER_ID),
    `the provider carrying the override must be "${PROVIDER_ID}"`,
  );
});

arm("AC-2.2b: the provider id is byte-exact, so normalizeModelCatalogProviderId cannot alter it", () => {
  // normalizeModelCatalogProviderId lower-cases/trims. If the key needed
  // normalizing, the key and the owned entry could disagree in a way the
  // membership arm above would not notice.
  for (const id of Object.keys(manifest.modelCatalog?.providers ?? {})) {
    assert.equal(id, id.trim().toLowerCase(), `provider key "${id}" is not already normalized`);
  }
});

// ---------------------------------------------------------------------------
// AC-2 arm 3: pin the SHAPE that was proved to load, citing the source lines.
// Any "simplification" toward the exit-78 shape -> RED.
// ---------------------------------------------------------------------------

arm("AC-2.3: the override lives under modelCatalog (permissive path), NOT on a bare model entry", () => {
  // The exit-78 shape. `models` (not `modelCatalog`) is the strict
  // openclaw.json key; it must never appear in this manifest.
  assert.equal(
    manifest.models,
    undefined,
    "openclaw.plugin.json declares a top-level `models` key. That is the STRICT " +
      "openclaw.json shape validated by zod-schema.core.ts:416 against a .strict() " +
      "ModelCompatSchema (:221-250) that does NOT allow sendSessionAffinityHeaders. " +
      "This is the b1005-3 exit-78 crash-loop shape. Keep the override under `modelCatalog`.",
  );
  assert.ok(
    manifest.modelCatalog?.providers?.[PROVIDER_ID],
    "the override must sit under modelCatalog.providers.<id>.models[].compat",
  );
});

arm("AC-2.3b: the flag is a real boolean true and nests under `compat`", () => {
  for (const model of manifest.modelCatalog.providers[PROVIDER_ID].models) {
    assert.equal(
      typeof model.compat,
      "object",
      `model "${model.id}": compat must be an object; normalizeModelCatalogCompat ` +
        "(model-catalog-normalize.ts:368-372) returns undefined for a non-record.",
    );
    assert.equal(
      typeof model.compat[AFFINITY_FLAG],
      "boolean",
      `model "${model.id}": the flag must be a BOOLEAN. The normalizer copies the ` +
        'field only when `typeof value[field] === "boolean"` ' +
        "(model-catalog-normalize.ts:396-399), so the string \"true\" is silently dropped.",
    );
    assert.equal(
      model[AFFINITY_FLAG],
      undefined,
      `model "${model.id}": the flag must not be flattened onto the model entry; ` +
        "only `compat.*` is read.",
    );
  }
});

arm("AC-2.3c: every compat key we declare is in the normalizer's allowlist (:373-395)", () => {
  for (const model of manifest.modelCatalog.providers[PROVIDER_ID].models) {
    for (const key of Object.keys(model.compat)) {
      assert.ok(
        NORMALIZER_BOOLEAN_ALLOWLIST.has(key),
        `model "${model.id}": compat key "${key}" is not in the ` +
          "normalizeModelCatalogCompat boolean allowlist at " +
          "model-catalog-normalize.ts:373-395, so it would be silently discarded.",
      );
    }
  }
});

arm("AC-2.3d: the affinity flag is deliberately OUTSIDE the strict schema's key set", () => {
  // This arm documents the asymmetry that makes route A possible. If a future
  // OpenClaw adds sendSessionAffinityHeaders to ModelCompatSchema, this arm
  // goes red and route A can be simplified on purpose rather than by accident.
  assert.equal(
    STRICT_SCHEMA_COMPAT_KEYS.has(AFFINITY_FLAG),
    false,
    `${AFFINITY_FLAG} is now listed as accepted by the strict openclaw.json ` +
      "ModelCompatSchema. Re-read src/config/zod-schema.core.ts:221-250 and " +
      "re-decide where this override belongs.",
  );
  assert.equal(
    NORMALIZER_BOOLEAN_ALLOWLIST.has(AFFINITY_FLAG),
    true,
    `${AFFINITY_FLAG} must be in the permissive normalizer allowlist, else the ` +
      "manifest override cannot load at all.",
  );
});

arm("AC-2.3e: the api declared for the provider is one the affinity consumer honours", () => {
  // openai-completions.ts:620 and anthropic.ts:1270 are the two consumers of
  // the flag. Declaring an api outside that pair would make the override inert.
  const api = manifest.modelCatalog.providers[PROVIDER_ID].api;
  assert.ok(
    api === "openai-completions" || api === "anthropic-messages",
    `modelCatalog provider api is "${api}"; the flag is only read by ` +
      "openai-completions.ts:620 and anthropic.ts:1270.",
  );
  // index.ts registers the live provider as openai-completions; they must agree.
  const indexSource = readFileSync(
    join(dirname(fileURLToPath(import.meta.url)), "..", "index.ts"),
    "utf-8",
  );
  assert.ok(
    indexSource.includes(`api: "${api}"`),
    `index.ts does not register the provider with api: "${api}" - the manifest ` +
      "catalog and the runtime provider registration disagree.",
  );
});

arm("AC-2.3f: runtimeAugment is declared true", () => {
  // model.static-catalog.ts:237 gates manifest-catalog runtime augmentation on
  // `catalog?.runtimeAugment !== true`, and providers.ts:122 treats it as the
  // explicit opt-in. Declaring it keeps route A working if this plugin is ever
  // shipped bundled, where the non-bundled fallback at providers.ts:122 would
  // no longer apply.
  assert.equal(manifest.modelCatalog.runtimeAugment, true);
});

// ---------------------------------------------------------------------------
// AC-2 arm 4: `baseUrl` is MANDATORY or the whole catalog provider is dropped.
//
// The non-bundled route by which this manifest actually reaches a request is
// src/plugins/provider-discovery.runtime.ts: `resolveManifestModelCatalogProviders`
// (:211-243) builds a synthetic provider whose compat is copied at :186
// (`...(row.compat ? { compat: row.compat } : {})`). It calls
// `providerConfigFromManifestRows` (:191-209), which opens with:
//
//     const firstRow = rows[0];
//     if (!firstRow?.baseUrl || !firstRow.api) {
//       return undefined;
//     }
//
// A row's baseUrl is `model.baseUrl ?? provider.baseUrl`
// (packages/model-catalog-core/src/model-catalog-normalize.ts:719, provider
// value read at :709). So omitting baseUrl means this provider is skipped and
// the affinity override NEVER reaches a request - another "loads clean and
// does nothing" outcome, with no error.
//
// (The other request-time route, the bundled static catalog at
// src/agents/embedded-agent-runner/model.static-catalog.ts:98, is closed to
// this plugin: :149-151 returns [] unless `record.origin === "bundled"`, and
// claude-runner is installed, not bundled.)
// ---------------------------------------------------------------------------

arm("AC-2.4: the catalog provider declares baseUrl, without which it is silently skipped", () => {
  const provider = manifest.modelCatalog.providers[PROVIDER_ID];
  const baseUrl = provider.baseUrl ?? provider.models?.[0]?.baseUrl;
  assert.ok(
    typeof baseUrl === "string" && baseUrl.length > 0,
    "modelCatalog provider has no baseUrl. providerConfigFromManifestRows " +
      "(provider-discovery.runtime.ts:193) returns undefined for a row without one, " +
      "so the affinity override would never reach a request.",
  );
});

arm("AC-2.4b: the catalog baseUrl matches DEFAULT_PORT in src/bridge-config.ts", () => {
  const cfgSource = readFileSync(
    join(dirname(fileURLToPath(import.meta.url)), "..", "src", "bridge-config.ts"),
    "utf-8",
  );
  const m = cfgSource.match(/export const DEFAULT_PORT\s*=\s*(\d+)/);
  assert.ok(m, "could not read DEFAULT_PORT out of src/bridge-config.ts");
  const expected = `http://127.0.0.1:${m![1]}/v1`;
  assert.equal(
    manifest.modelCatalog.providers[PROVIDER_ID].baseUrl,
    expected,
    `the manifest catalog baseUrl must match the bridge's default port (${m![1]}). ` +
      "index.ts registers the live provider as `http://127.0.0.1:${port}/v1`; a cell " +
      "that overrides `port` supplies its own baseUrl through configPatch, which takes " +
      "precedence, but the manifest default must not point somewhere else.",
  );
});

// ---------------------------------------------------------------------------
// AC-2.5: a model row without BOTH contextWindow and maxTokens is dropped.
//
// `modelDefinitionFromManifestRow` (src/plugins/provider-discovery.runtime.ts:163-188)
// opens with:
//
//     if (!row.contextWindow || !row.maxTokens) {
//       return undefined;
//     }
//
// at :166-168. Every dropped row shrinks the `models` array, and
// `providerConfigFromManifestRows` then returns undefined once it is empty
// (:201-203), so the provider is never built. The first version of this slice
// declared only `id` + `compat` and was INERT for exactly this reason - caught
// in review, not by these arms, which is why the arm now exists.
// ---------------------------------------------------------------------------

arm("AC-2.5: every model row declares contextWindow and maxTokens, or it is dropped", () => {
  for (const model of manifest.modelCatalog.providers[PROVIDER_ID].models) {
    assert.ok(
      typeof model.contextWindow === "number" && model.contextWindow > 0,
      `model "${model.id}" has no positive contextWindow; ` +
        "provider-discovery.runtime.ts:166-168 drops the row.",
    );
    assert.ok(
      typeof model.maxTokens === "number" && model.maxTokens > 0,
      `model "${model.id}" has no positive maxTokens; ` +
        "provider-discovery.runtime.ts:166-168 drops the row.",
    );
  }
});

// ---------------------------------------------------------------------------
// AC-2.6: `discovery` must not mark this provider runtime/refreshable.
//
// resolveManifestModelCatalogProviders skips an entry whose discovery mode is
// "runtime" or "refreshable" (src/plugins/provider-discovery.runtime.ts:220-226),
// which would close the only route this manifest has. A reviewer demonstrated a
// mutant adding `"discovery": {"claude-runner": "runtime"}` that passed every
// other arm while silently disabling the override - same silent-drop family as
// AC-2.2 and AC-2.4.
// ---------------------------------------------------------------------------

arm("AC-2.6: discovery does not mark this provider runtime/refreshable", () => {
  const discovery = manifest.modelCatalog?.discovery ?? {};
  for (const [provider, mode] of Object.entries(discovery)) {
    assert.ok(
      !(provider === PROVIDER_ID && (mode === "runtime" || mode === "refreshable")),
      `modelCatalog.discovery["${provider}"] = "${mode}" makes ` +
        "resolveManifestModelCatalogProviders skip this provider " +
        "(provider-discovery.runtime.ts:220-226), silently disabling the override.",
    );
  }
});

// ---------------------------------------------------------------------------
// The battery asserts its own arm total, so a malformed file that yields zero
// assertions cannot read as "0 failed".
//
// NOTE on what this battery does and does not establish. These arms are
// MANIFEST-LEVEL: they prove the declaration is present, well-formed, owned,
// and survives `normalizeModelCatalog`. They do NOT prove the flag reaches a
// request. Two independent reviews established that for THIS plugin it
// currently does not: `index.ts` registers a live `discovery.run` hook, so
// provider-discovery.runtime.ts:510-523 loads the real plugin provider and
// DISCARDS the synthetic provider built from this manifest. Do not read a green
// run here as evidence that the session-affinity header is on the wire.
// See booqi-app/infra#327.
// ---------------------------------------------------------------------------

const EXPECTED_ARMS = 14;

test("battery self-check: all S2 manifest arms ran", () => {
  assert.equal(
    armsRun,
    EXPECTED_ARMS,
    `expected ${EXPECTED_ARMS} S2 manifest arms to run and pass, but ${armsRun} did. ` +
      "A mutant that breaks parsing can otherwise show up as zero failures.",
  );
});
