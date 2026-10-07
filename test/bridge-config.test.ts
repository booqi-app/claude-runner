/**
 * Unit tests for the `mcpServers` passthrough.
 *
 * What these prove: a value named `mcpServers` in cell configuration reaches
 * the options object the bridge hands to the Agent SDK's `query()`, unchanged.
 * That is the only path by which the SDK session of a cell learns about the
 * Tool API MCP server its gateway serves on the container loopback -- a
 * `.mcp.json` in the workspace is not relied on.
 *
 * These are deliberately hermetic: `src/bridge-config.ts` imports nothing, so
 * the assertions need neither the SDK installed nor a listening bridge.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import {
  affinityExaminationSummary,
  applySessionHint,
  buildBridgeOptions,
  chatSessionFromAgentSessionKey,
  examineAffinityHeaders,
  examineAgentSessionKey,
  type AffinityRefusalRule,
  buildQueryOptions,
  droppedMcpServersMessage,
  normaliseChatSessionId,
  sessionHintMessage,
  SESSION_HINT_PARAM,
  unhintedMcpServersMessage,
  COMPACT_SUMMARY_HEADING,
  DEFAULT_SYSTEM_PROMPT_MODE,
  isUnknownSystemPromptMode,
  normaliseSystemPromptMode,
  KNOWN_NON_SDK_OPTIONS,
  KNOWN_NON_SDK_OPTION_NAMES,
  readMcpServers,
  readTools,
  DEFAULT_TOOLS_WHEN_ABSENT,
  unusableToolsMessage,
  resolveSystemPrompt,
  wrapSystemPromptAsInstructions,
  AGENT_INSTRUCTIONS_TAG,
  SDK_OPTION_NAMES,
  summariseMcpServers,
  type BridgeConfig,
} from "../src/bridge-config.ts";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");

/** The shape a cell actually ships: one streamable-HTTP server on loopback. */
const CELL_MCP_SERVERS = {
  booqi: { type: "http", url: "http://127.0.0.1:3010/mcp" },
};

function baseConfig(overrides: Partial<BridgeConfig> = {}): BridgeConfig {
  return {
    port: 7779,
    workDir: "/home/agent/.openclaw/workspace",
    skipPermissions: true,
    ...overrides,
  };
}

function optionsFor(config: BridgeConfig): Record<string, any> {
  return buildQueryOptions(
    "claude-opus-4-6",
    undefined,
    undefined,
    "session-1",
    config,
    new AbortController(),
    // Explicitly nothing: no chat session named, no log sink. The parameter is
    // required precisely so that this is a visible choice rather than an
    // omission that looks the same.
    {},
  );
}

/**
 * Source text with comments removed.
 *
 * A structural assertion over raw source is satisfied by a comment containing
 * the string it looks for, which makes commenting a line out invisible to it.
 */
function sourceOf(...parts: string[]): string {
  return readFileSync(join(repoRoot, ...parts), "utf-8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:"'`\\])\/\/.*$/gm, "$1");
}

// ── The criterion itself ────────────────────────────────────────────

test("an mcpServers value from configuration reaches the SDK query options", () => {
  const opts = optionsFor(baseConfig({ mcpServers: CELL_MCP_SERVERS }));

  assert.ok(
    Object.prototype.hasOwnProperty.call(opts, "mcpServers"),
    "the options object handed to query() carries no mcpServers key",
  );
  assert.deepEqual(opts.mcpServers, CELL_MCP_SERVERS);
});

test("the loopback URL survives verbatim -- the bridge rewrites nothing", () => {
  const opts = optionsFor(baseConfig({ mcpServers: CELL_MCP_SERVERS }));

  assert.equal(opts.mcpServers.booqi.url, "http://127.0.0.1:3010/mcp");
  assert.equal(opts.mcpServers.booqi.type, "http");
});

test("server names reach the options object verbatim", () => {
  // The SDK derives tool names from the key as mcp__<name>__<tool>, which is
  // what infra#166 AC-4's `mcp__booqi__*` restriction matches on. Normalising
  // a name here would break every tool call while the URL still looked right.
  const named = { "Booqi-Tool_API": { type: "http", url: "http://127.0.0.1:3010/mcp" } };
  const opts = optionsFor(baseConfig({ mcpServers: named }));

  assert.deepEqual(Object.keys(opts.mcpServers), ["Booqi-Tool_API"]);
});

test("an unknown transport shape is passed through, not narrowed away", () => {
  // The SDK owns transport validation. If this repository starts filtering
  // keys it does not recognise, every new SDK transport becomes a patch here.
  // Deliberately a URL transport and not a stdio { command, args } one: a test
  // asserting that a process-spawning entry survives would pin an arbitrary
  // execution path as a contract, and whoever later constrains it would have
  // to delete a green test to do so.
  const future = { booqi: { type: "ws", url: "http://127.0.0.1:3010/ws", retries: 3 } };
  const opts = optionsFor(baseConfig({ mcpServers: future }));

  assert.deepEqual(opts.mcpServers, future);
});

test("a deeply nested transport object is passed through untouched", () => {
  const nested = {
    booqi: { type: "http", url: "http://127.0.0.1:3010/mcp", opts: { retry: { max: 3, on: ["503"] } } },
  };

  assert.deepEqual(optionsFor(baseConfig({ mcpServers: nested })).mcpServers, nested);
});

test("several servers all reach the options object", () => {
  const many = {
    booqi: { type: "http", url: "http://127.0.0.1:3010/mcp" },
    other: { type: "sse", url: "http://127.0.0.1:3011/sse" },
  };
  const opts = optionsFor(baseConfig({ mcpServers: many }));

  assert.deepEqual(Object.keys(opts.mcpServers).sort(), ["booqi", "other"]);
});

// ── Absence stays absence ───────────────────────────────────────────

test("no mcpServers in configuration leaves the key off the options object", () => {
  const opts = optionsFor(baseConfig());

  assert.equal(
    Object.prototype.hasOwnProperty.call(opts, "mcpServers"),
    false,
    "an absent value must not become an mcpServers key",
  );
});

test("an empty map is treated as absent", () => {
  const opts = optionsFor(baseConfig({ mcpServers: {} }));

  assert.equal(Object.prototype.hasOwnProperty.call(opts, "mcpServers"), false);
});

// ── Only the configured servers are used ────────────────────────────

test("strictMcpConfig defaults to true, with and without a configured server", () => {
  // Set even when nothing is configured: that is the case where an MCP
  // configuration lying around on the filesystem matters most.
  assert.equal(optionsFor(baseConfig()).strictMcpConfig, true);
  assert.equal(optionsFor(baseConfig({ mcpServers: CELL_MCP_SERVERS })).strictMcpConfig, true);
});

test("strictMcpConfig can be turned off explicitly", () => {
  assert.equal(optionsFor(baseConfig({ strictMcpConfig: false })).strictMcpConfig, false);
});

// ── readMcpServers, the value reader ────────────────────────────────

test("readMcpServers refuses values that are not a map of objects", () => {
  for (const bad of [undefined, null, 42, "http://127.0.0.1:3010/mcp", true, [], [{}]]) {
    assert.equal(readMcpServers(bad), undefined, `accepted ${JSON.stringify(bad) ?? "undefined"}`);
  }
});

test("readMcpServers drops entries that are not objects and keeps the rest", () => {
  const read = readMcpServers({
    booqi: { type: "http", url: "http://127.0.0.1:3010/mcp" },
    broken: "http://127.0.0.1:3011/mcp",
    alsoBroken: null,
    arrayish: ["nope"],
  });

  assert.deepEqual(read, { booqi: { type: "http", url: "http://127.0.0.1:3010/mcp" } });
});

test("readMcpServers returns undefined when every entry is unusable", () => {
  assert.equal(readMcpServers({ broken: "nope", alsoBroken: 1 }), undefined);
});

test("a server named __proto__ is dropped, not kept in a form the SDK loses", () => {
  // JSON.parse produces an own "__proto__" key, so this is reachable from a
  // config file, and `out[name] = value` for it replaces the prototype of the
  // map instead of adding a key. Defining it safely here is not enough: the
  // Agent SDK rebuilds the map with exactly that assignment before serialising
  // it, so the entry would vanish inside the SDK and its contents would land
  // on the prototype of the object the SDK sends -- while this bridge logged
  // the server as accepted. The name is unusable anyway (the tool prefix would
  // be `mcp____proto____`), so it is dropped and reported as dropped.
  const raw = JSON.parse(
    '{"__proto__":{"type":"http","url":"http://evil/mcp"},"ok":{"type":"http"}}',
  );
  const read = readMcpServers(raw)!;

  assert.deepEqual(Object.keys(read), ["ok"]);
  assert.equal(Object.getPrototypeOf(read), Object.prototype);
  assert.equal((read as any).url, undefined);
  assert.equal(({} as any).url, undefined, "Object.prototype was polluted");

  // It must not be reported as accepted: that log line is the only signal a
  // cell gives that it came up with the servers it was configured with.
  const summary = summariseMcpServers(raw);
  assert.deepEqual(summary.accepted, ["ok"]);
  assert.deepEqual(summary.dropped, ["__proto__"]);
});

test("a config naming only __proto__ yields no mcpServers key at all", () => {
  const raw = JSON.parse('{"__proto__":{"type":"http","url":"http://evil/mcp"}}');

  assert.equal(readMcpServers(raw), undefined);
  assert.equal(
    Object.prototype.hasOwnProperty.call(optionsFor(baseConfig({ mcpServers: raw })), "mcpServers"),
    false,
  );
});

test("the options map survives being rebuilt entry by entry, as the SDK does", () => {
  // The SDK rebuilds the map with obj[key] = value before serialising it to
  // --mcp-config. Anything that only looks intact here has to survive that.
  const raw = JSON.parse(
    '{"__proto__":{"type":"http","url":"http://evil/mcp"},"booqi":{"type":"http","url":"http://127.0.0.1:3010/mcp"}}',
  );
  const opts = optionsFor(baseConfig({ mcpServers: raw }));

  const rebuilt: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(opts.mcpServers)) rebuilt[k] = v;

  assert.deepEqual(Object.keys(rebuilt), ["booqi"]);
  assert.equal(Object.getPrototypeOf(rebuilt), Object.prototype);
  assert.deepEqual(JSON.parse(JSON.stringify({ mcpServers: opts.mcpServers })), {
    mcpServers: CELL_MCP_SERVERS,
  });
});

test("readMcpServers reads a value parsed from a config.json", () => {
  const parsed = JSON.parse(
    '{"port":7779,"mcpServers":{"booqi":{"type":"http","url":"http://127.0.0.1:3010/mcp"}}}',
  );

  assert.deepEqual(readMcpServers(parsed.mcpServers), CELL_MCP_SERVERS);
});

// ── summariseMcpServers, what gets logged ───────────────────────────

test("summariseMcpServers names what was accepted and what was dropped", () => {
  const summary = summariseMcpServers({
    booqi: { type: "http", url: "http://127.0.0.1:3010/mcp" },
    broken: "nope",
  });

  assert.deepEqual(summary.accepted, ["booqi"]);
  assert.deepEqual(summary.dropped, ["broken"]);
});

test("summariseMcpServers flags entries that could carry a credential", () => {
  // The SDK serialises the whole map onto the claude subprocess command line
  // as --mcp-config, so headers and env are readable in ps.
  const summary = summariseMcpServers({
    booqi: { type: "http", url: "http://127.0.0.1:3010/mcp", headers: { authorization: "…" } },
    plain: { type: "http", url: "http://127.0.0.1:3011/mcp" },
    spawner: { command: "/usr/bin/x", env: { TOKEN: "…" } },
  });

  assert.deepEqual(summary.withSecretsRisk.sort(), ["booqi", "spawner"]);
});

test("summariseMcpServers says nothing about an absent value", () => {
  assert.deepEqual(summariseMcpServers(undefined), { accepted: [], dropped: [], withSecretsRisk: [] });
});

test("summariseMcpServers reports a value that is not a map at all", () => {
  assert.deepEqual(summariseMcpServers("http://127.0.0.1:3010/mcp").dropped, ["<the whole value>"]);
});

// ── The configuration-to-bridge path, behaviourally ─────────────────

test("buildBridgeOptions carries mcpServers from a parsed config.json", () => {
  const extConfig = JSON.parse(
    '{"mcpServers":{"booqi":{"type":"http","url":"http://127.0.0.1:3010/mcp"}}}',
  );
  const opts = buildBridgeOptions(extConfig);

  assert.deepEqual(readMcpServers(opts.mcpServers), CELL_MCP_SERVERS);
  assert.deepEqual(
    optionsFor(baseConfig(opts) as BridgeConfig).mcpServers,
    CELL_MCP_SERVERS,
    "the value does not survive the whole config -> bridge -> SDK path",
  );
});

test("buildBridgeOptions applies the documented defaults", () => {
  const opts = buildBridgeOptions({});

  assert.equal(opts.port, 7779);
  assert.equal(opts.skipPermissions, true);
  assert.equal(opts.maxTurns, 30);
  assert.equal(opts.mcpServers, undefined);
});

test("buildBridgeOptions carries every other configured value", () => {
  const opts = buildBridgeOptions(
    JSON.parse('{"port":1,"skipPermissions":false,"maxTurns":2,"queueMinDelayMs":3,'
      + '"queueMaxDelayMs":4,"queueMaxConcurrency":5,"sessionTtlMs":6,"maxRetries":8,"tools":["T"],'
      + '"strictMcpConfig":false,"effort":"high","maxBudgetUsd":7,"systemPromptMode":"replace"}'),
  );

  assert.deepEqual(opts, {
    port: 1,
    skipPermissions: false,
    maxTurns: 2,
    queueMinDelayMs: 3,
    queueMaxDelayMs: 4,
    queueMaxConcurrency: 5,
    sessionTtlMs: 6,
    maxRetries: 8,
    tools: ["T"],
    mcpServers: undefined,
    strictMcpConfig: false,
    effort: "high",
    maxBudgetUsd: 7,
    systemPromptMode: "replace",
  });
});

// ── The rest of the options object is unaffected ────────────────────

test("the existing options are unchanged by the new keys", () => {
  const opts = optionsFor(
    baseConfig({ tools: ["mcp__booqi__open_invoices"], maxTurns: 12, effort: "medium" }),
  );

  assert.equal(opts.model, "claude-opus-4-6");
  assert.equal(opts.cwd, "/home/agent/.openclaw/workspace");
  assert.equal(opts.maxTurns, 12);
  assert.equal(opts.includePartialMessages, true);
  assert.equal(opts.permissionMode, "bypassPermissions");
  assert.equal(opts.allowDangerouslySkipPermissions, true);
  assert.equal(opts.sessionId, "session-1");
  assert.deepEqual(opts.tools, ["mcp__booqi__open_invoices"]);
  assert.equal(opts.effort, "medium");
});

test("skipPermissions off leaves both permission keys off", () => {
  const opts = optionsFor(baseConfig({ skipPermissions: false }));

  assert.equal("permissionMode" in opts, false);
  assert.equal("allowDangerouslySkipPermissions" in opts, false);
});

test("a resume id becomes resume, not sessionId", () => {
  const opts = buildQueryOptions(
    "claude-opus-4-6", undefined, "resume-9", "new-1", baseConfig(), new AbortController(), {},
  );

  assert.equal(opts.resume, "resume-9");
  assert.equal("sessionId" in opts, false);
});

test("maxTurns falls back to the default", () => {
  assert.equal(optionsFor(baseConfig()).maxTurns, 30);
});

// ── The options object really is the one query() receives ───────────

test("every query() call in the bridge is given buildQueryOptions output", () => {
  // buildQueryOptions is assertable in isolation; this keeps that isolation
  // honest by checking the transport still routes through it. Without this, a
  // future edit could add a query() call that builds its own options, or wrap
  // the options in a spread that drops a key, with every test above green.
  const bridge = sourceOf("src", "claude-bridge.ts");

  // The SDK's query() is resolved lazily now (booqi-app/infra#202 made this
  // module importable by the hermetic suite), so the call reads
  // `(await getQuery())({ prompt, options })`.
  const calls = bridge.match(/\(\s*await\s+getQuery\(\)\s*\)\s*\(/g) ?? [];
  const wellFormed = bridge.match(/\(\s*await\s+getQuery\(\)\s*\)\(\s*\{\s*prompt\s*,\s*options\s*,?\s*\}\s*,?\s*\)/g) ?? [];
  const built = bridge.match(/=\s*buildQueryOptions\s*\(/g) ?? [];

  assert.ok(calls.length > 0, "found no SDK query call in claude-bridge.ts");
  assert.equal(
    wellFormed.length, calls.length,
    `a query() call does not receive exactly { prompt, options } (${wellFormed.length} of ${calls.length})`,
  );
  assert.equal(
    built.length, calls.length,
    `${calls.length} query() call(s) but ${built.length} buildQueryOptions() call(s)`,
  );
});

test("claude-bridge.ts defines no second copy of buildQueryOptions", () => {
  assert.equal(/function buildQueryOptions\s*\(/.test(sourceOf("src", "claude-bridge.ts")), false);
});

test("index.ts builds its bridge options with buildBridgeOptions and spreads them", () => {
  // The behaviour of buildBridgeOptions is tested above; what cannot be tested
  // by importing is that index.ts uses it, because the entry point pulls in
  // openclaw/plugin-sdk/core. Comments are stripped first, so commenting the
  // call out does not satisfy this.
  const entry = sourceOf("index.ts");

  assert.match(entry, /=\s*buildBridgeOptions\s*\(\s*extConfig\s*\)/);
  assert.match(entry, /startBridgeServer\s*\(\s*\{\s*\.\.\.config\s*,\s*workDir\s*,?\s*\}\s*\)/);
  assert.doesNotMatch(entry, /mcpServers:\s*(undefined|null)/);

  // Server names come from a config file, so they are quoted into a log line
  // rather than interpolated bare -- a newline in a name would forge one.
  assert.match(entry, /\.map\(\s*\(?n\)?\s*=>\s*JSON\.stringify\(n\)\s*\)/);
  assert.doesNotMatch(entry, /\$\{mcp\.(accepted|dropped|withSecretsRisk)\.join/);
});

// ── The shipped configuration surface ───────────────────────────────

test("the plugin config schema admits mcpServers and constrains its entries", () => {
  // configSchema has additionalProperties:false, so an mcpServers value in
  // config.json is refused before it ever reaches readMcpServers unless the
  // schema names it. This is the failure mode that would make every other
  // test here green while a real cell still came up without its Tool API.
  const schema = JSON.parse(readFileSync(join(repoRoot, "openclaw.plugin.json"), "utf-8")).configSchema;

  assert.equal(schema.additionalProperties, false);
  assert.equal(schema.properties.mcpServers.type, "object");
  assert.deepEqual(schema.properties.mcpServers.additionalProperties, { type: "object" });
  assert.equal(schema.properties.strictMcpConfig.type, "boolean");
});

test("every key in config.example.json is admitted by the plugin config schema", () => {
  const schema = JSON.parse(readFileSync(join(repoRoot, "openclaw.plugin.json"), "utf-8")).configSchema;
  const example = JSON.parse(readFileSync(join(repoRoot, "config.example.json"), "utf-8"));

  const unknown = Object.keys(example).filter((k) => !(k in schema.properties));
  assert.deepEqual(unknown, [], `config.example.json carries keys the schema rejects: ${unknown}`);
});

test("config.example.json names no MCP server", () => {
  // install.sh copies this file to a live config.json when none exists, so a
  // cell-specific loopback URL here would become the default for every
  // install, pointing every SDK session at a port nothing listens on.
  const example = JSON.parse(readFileSync(join(repoRoot, "config.example.json"), "utf-8"));

  assert.equal("mcpServers" in example, false);
});

// ── The installed tree is complete ──────────────────────────────────

test("install.sh ships every module under src/", () => {
  // install.sh copies files by name. Before this test it took exactly one file
  // out of src/, so splitting a module out of claude-bridge.ts produced an
  // install that reported success and then failed to load on a missing import
  // -- the bridge would not start at all. This asserts the copy covers the
  // directory rather than a list someone has to remember to extend.
  const install = sourceOf("install.sh");
  const modules = readdirSync(join(repoRoot, "src")).filter((f) => f.endsWith(".ts"));

  assert.ok(modules.length > 1, "expected more than one module under src/");

  const copiesWholeDir = /cp\s+(-r\s+)?["']?src\/(\*\.ts|\.|\*)["']?\s+"\$EXT_DIR\/src\/?"/.test(install);
  if (!copiesWholeDir) {
    for (const mod of modules) {
      assert.ok(
        install.includes(`src/${mod}`),
        `install.sh copies src/ file-by-file but never copies src/${mod}`,
      );
    }
  }
});

// ── The configuration surface has no unreachable corners ────────────

test("buildBridgeOptions reads every key the config schema declares", () => {
  // buildBridgeOptions is a hand-written mapping, which is the shape of bug
  // install.sh just stopped having. A key the schema accepts but the mapping
  // never reads is configuration that silently does nothing.
  const schema = JSON.parse(readFileSync(join(repoRoot, "openclaw.plugin.json"), "utf-8")).configSchema;
  // workDir comes from the OpenClaw workspace; its schema description says so.
  // defaultModel is a provider setting read in index.ts for model registration
  // and never reaches the bridge.
  const notBridgeOptions = new Set(["workDir", "defaultModel"]);

  const declared = Object.keys(schema.properties).filter((k) => !notBridgeOptions.has(k));
  const read = new Set(Object.keys(buildBridgeOptions({})));

  const unreachable = declared.filter((k) => !read.has(k));
  assert.deepEqual(unreachable, [], `config keys the bridge never reads: ${unreachable}`);
});

const ALL_OPTION_NAMES: readonly string[] = [...SDK_OPTION_NAMES, ...KNOWN_NON_SDK_OPTION_NAMES];

/** Options with every conditional branch taken. */
function optionsWithEveryBranch(): Record<string, any> {
  return buildQueryOptions(
    "claude-opus-4-6",
    "you are a bookkeeper",
    "resume-9",
    undefined,
    baseConfig({ mcpServers: CELL_MCP_SERVERS, tools: [], effort: "medium", maxBudgetUsd: 1 }),
    new AbortController(),
    {},
  );
}

test("the query options carry no key outside the two declared name lists", () => {
  // This is a pin, not a check against the SDK -- a hand-written list cannot
  // know what the SDK accepts. `typecheck/sdk-options.ts` is what proves every
  // name in SDK_OPTION_NAMES is a real `Options` key and that every name in
  // KNOWN_NON_SDK_OPTION_NAMES still is not, compiled against the installed
  // SDK in CI. This test only makes sure nothing escapes those lists.
  for (const opts of [optionsWithEveryBranch(), optionsFor(baseConfig())]) {
    const unknown = Object.keys(opts).filter((k) => !ALL_OPTION_NAMES.includes(k));
    assert.deepEqual(
      unknown, [],
      `option name(s) in neither SDK_OPTION_NAMES nor KNOWN_NON_SDK_OPTION_NAMES: ${unknown}. `
        + "Add to the first only after confirming the name exists on the SDK's Options type -- "
        + "typecheck/sdk-options.ts enforces that.",
    );
  }
});

test("both fixtures together reach every declared option name", () => {
  // Anti-rot only: a name nothing here sets means the compile-time guard is
  // guarding a key no fixture exercises.
  const reached = new Set([
    ...Object.keys(optionsWithEveryBranch()),
    ...Object.keys(optionsFor(baseConfig())),
  ]);
  const unreached = ALL_OPTION_NAMES.filter((k) => !reached.has(k));

  assert.deepEqual(
    unreached, [],
    `names no fixture in this test reaches: ${unreached}. Either nothing sets them, `
      + "or this test needs a fixture that does.",
  );
});

// ── booqi-app/infra#202: the system prompt reaches the model ────────
//
// These are the tests that must fail if the fix is unwired. Before #202 the
// bridge set `appendSystemPrompt`, which is not an SDK `Options` key at all,
// so the prompt was discarded and the SDK sent `systemPrompt: ""` -- which on
// the stream-json path suppresses the preset prompt too, leaving the session
// with no system prompt whatsoever. The runtime capture is on the pull
// request; what is assertable here is the option the bridge builds.

test("the caller's system prompt reaches the SDK under the real option name", () => {
  const opts = buildQueryOptions(
    "claude-opus-4-6", "you are a bookkeeper", undefined, "session-1", baseConfig(), new AbortController(), {},
  );

  // Default mode is "replace", so the prompt goes out as a plain string.
  assert.equal(opts.systemPrompt, "you are a bookkeeper");
  // The name that did nothing must be gone, not merely joined by the new one:
  // the SDK ignores it, so leaving it would only mislead the next reader.
  assert.equal("appendSystemPrompt" in opts, false);
  assert.ok(SDK_OPTION_NAMES.includes("systemPrompt" as never));
});

test("systemPromptMode defaults to replace -- the agent's prompt, not the coding preset", () => {
  // The default was "append" in the first round of booqi-app/infra#202, on two
  // stated reasons that a measurement falsified: that the preset was the only
  // source of today's date, and the only way CLAUDE.md/memory got loaded.
  // Measured against the real cli.js at 0.2.92 with settingSources omitted, as
  // this bridge leaves it, BOTH arrive in the first user message in BOTH modes:
  //
  //   replace -> 158 chars of system prompt, CLAUDE.md loaded, date present
  //   append  -> 26,811 chars,               CLAUDE.md loaded, date present
  //
  // So "append" buys only ~26.6 KB of coding-agent instructions, which a
  // bookkeeping cell must not act on -- its built-in tools are required to be
  // disabled. Hence "replace".
  assert.equal(DEFAULT_SYSTEM_PROMPT_MODE, "replace");

  for (const config of [baseConfig(), baseConfig({ systemPromptMode: "replace" })]) {
    const opts = buildQueryOptions(
      "claude-opus-4-6", "P", undefined, "session-1", config, new AbortController(), {},
    );
    assert.equal(opts.systemPrompt, "P");
  }
});

test("systemPromptMode append sets NO system-prompt option of any kind", () => {
  // booqi-app/infra#333. Measured on @anthropic-ai/claude-agent-sdk@0.3.263:
  // `{ type: "preset", preset: "claude_code", append }` is billed as a
  // third-party app exactly like a plain replacing string and fails the call
  // with `400 Third-party apps now draw from your extra usage, not your plan
  // limits.`, while `appendSystemPrompt` is still not an `Options` key and is
  // discarded -- on 0.3.263 that discard leaves the preset intact, so it bills
  // fine and delivers nothing at all. So append mode sends nothing here and
  // the transport delivers the prompt as first-turn content instead.
  for (const resume of [undefined, "sdk-session-9"]) {
    const opts = buildQueryOptions(
      "claude-opus-4-6", "P", resume, resume ? undefined : "session-1",
      baseConfig({ systemPromptMode: "append" }), new AbortController(), {},
    );

    // `in`, not a truthiness check: `systemPrompt: ""` is a present, empty
    // prompt to this SDK and suppresses the preset, which is the whole
    // billing problem back again.
    assert.equal("systemPrompt" in opts, false, `resume=${resume}`);
    assert.equal("appendSystemPrompt" in opts, false, `resume=${resume}`);
  }
});

test("append mode's instructions block wraps the prompt, and only the prompt", () => {
  assert.equal(
    wrapSystemPromptAsInstructions("BE A BOOKKEEPER", "what is 2+2?"),
    "<agent-instructions>\nBE A BOOKKEEPER\n</agent-instructions>\n\nwhat is 2+2?",
  );
  // The caller's turn survives verbatim -- the instructions are a prefix, not
  // a replacement, so a mutant that drops `prompt` is caught.
  assert.ok(wrapSystemPromptAsInstructions("I", "USER-TURN").endsWith("USER-TURN"));
  assert.equal(AGENT_INSTRUCTIONS_TAG, "agent-instructions");
});

test("an unrecognised systemPromptMode falls back to the default, and is reported", () => {
  // The `enum` in openclaw.plugin.json does NOT police this: OpenClaw validates
  // the config block of openclaw.json, while index.ts reads the extension's own
  // config.json directly. So a typo reaches buildQueryOptions unchecked.
  for (const bad of ["Replace", "plain", "none", "", true, 0, null, {}]) {
    assert.equal(normaliseSystemPromptMode(bad), "replace", `normalise(${JSON.stringify(bad)})`);
    assert.equal(isUnknownSystemPromptMode(bad), true, `isUnknown(${JSON.stringify(bad)})`);

    const opts = buildQueryOptions(
      "claude-opus-4-6", "P", undefined, "session-1",
      baseConfig({ systemPromptMode: bad as any }), new AbortController(), {},
    );
    // Falls back to the default rather than to the 26 KB coding preset.
    assert.equal(opts.systemPrompt, "P");
  }

  assert.equal(normaliseSystemPromptMode(undefined), "replace");
  assert.equal(isUnknownSystemPromptMode(undefined), false, "absent is not 'unknown'");
  assert.equal(normaliseSystemPromptMode("append"), "append");
  assert.equal(isUnknownSystemPromptMode("append"), false);
});

test("buildBridgeOptions carries systemPromptMode from a parsed config.json", () => {
  assert.equal(buildBridgeOptions({ systemPromptMode: "replace" }).systemPromptMode, "replace");
  // Absent means absent, not "append" baked in twice: the default lives in
  // buildQueryOptions alone, so there is one place to change it.
  assert.equal(buildBridgeOptions({}).systemPromptMode, undefined);
});

// ── booqi-app/infra#202: the prompt goes out on EVERY turn ──────────

test("a resumed turn gets the same system prompt as the first turn", () => {
  // THE resume-path regression test. `--resume` replays the transcript, not
  // the system prompt -- the CLI rebuilds that from the current query options
  // on every query. The bridge used to send a prompt only when there was no
  // resume id, so turn 2 onwards would have run with an empty prompt and the
  // agent's persona would have flipped mid-conversation. Re-introducing that
  // guard inside resolveSystemPrompt fails here.
  assert.equal(resolveSystemPrompt("you are a bookkeeper", undefined, undefined), "you are a bookkeeper");
  assert.equal(resolveSystemPrompt("you are a bookkeeper", undefined, "resume-9"), "you are a bookkeeper");
  assert.equal(
    resolveSystemPrompt("you are a bookkeeper", undefined, "resume-9"),
    resolveSystemPrompt("you are a bookkeeper", undefined, undefined),
  );
});

test("a resumed turn with a compaction summary carries prompt and summary both", () => {
  const first = resolveSystemPrompt("P", "S", undefined);
  const resumed = resolveSystemPrompt("P", "S", "resume-9");

  assert.equal(resumed, first);
  assert.ok(resumed!.startsWith("P"));
  assert.ok(resumed!.includes("S"));
  assert.ok(resumed!.includes(COMPACT_SUMMARY_HEADING));
});

test("a compaction summary with no caller prompt is sent as the heading plus the summary", () => {
  assert.equal(resolveSystemPrompt(undefined, "S", undefined), `${COMPACT_SUMMARY_HEADING}S`);
  assert.equal(resolveSystemPrompt("", "S", "resume-9"), `${COMPACT_SUMMARY_HEADING}S`);
});

test("the compaction-summary heading is pinned", () => {
  // It was extracted and exported to be one named thing; nothing asserted its
  // text, so changing it was a surviving mutant.
  assert.equal(COMPACT_SUMMARY_HEADING, "\n\n## Previous conversation summary\n");
});

test("an empty-string caller prompt stays an empty string, and sets no option", () => {
  // `""` is the dangerous value: to the SDK it is a present-and-empty prompt
  // that suppresses the preset. resolveSystemPrompt passes it through, and
  // buildQueryOptions' truthy guard is what stops it reaching the SDK. That
  // coupling is load-bearing -- tightening the guard to `!== undefined` would
  // reintroduce the defect -- so both halves are pinned here.
  assert.equal(resolveSystemPrompt("", undefined, undefined), "");
  assert.equal(resolveSystemPrompt("", undefined, "resume-9"), "");
  assert.equal(resolveSystemPrompt("P", "", undefined), "P");

  const opts = buildQueryOptions(
    "claude-opus-4-6", "", undefined, "session-1", baseConfig(), new AbortController(), {},
  );
  assert.equal("systemPrompt" in opts, false);
});

test("no prompt and no summary stays undefined rather than becoming an empty string", () => {
  // `""` is not equivalent to omitting the option: the SDK sends it as a
  // real, empty system prompt and the preset is then suppressed.
  assert.equal(resolveSystemPrompt(undefined, undefined, undefined), undefined);
  assert.equal(resolveSystemPrompt(undefined, undefined, "resume-9"), undefined);
});

test("the bridge takes its per-turn system prompt from resolveSystemPrompt, unconditionally", () => {
  // resolveSystemPrompt is assertable in isolation; claude-bridge.ts is not --
  // it imports the Agent SDK at the top level, so the hermetic suite cannot
  // load it. This keeps the transport routed through the tested rule, the
  // same way the buildQueryOptions test above does. Comments are stripped
  // first, so a commented-out call does not satisfy it.
  const bridge = sourceOf("src", "claude-bridge.ts");

  assert.match(bridge, /=\s*resolveSystemPrompt\s*\(/);

  // DELETED here: three structural source-text assertions that used to stand
  // in this spot -- a loop requiring every `if (!resumeSessionId)` branch to be
  // the instructions block, a regex forbidding the system prompt to be a
  // ternary on the resume id, and a regex requiring the literal
  // `normaliseSystemPromptMode(config.systemPromptMode) === "append"`.
  //
  // They are removed rather than repaired because both of their failure modes
  // were measured on this very branch:
  //
  //   * EVADED. The infra#333 fix round changed the gate to
  //     `if (!resumeSessionId || compactSummary)` -- a real behaviour change --
  //     and the guard loop then matched ZERO branches and asserted nothing,
  //     silently. A guard that stops guarding without failing is worse than no
  //     guard, because it still reads as coverage.
  //   * FALSE POSITIVE. The `=== "append"` regex turned RED for a strictly
  //     behaviour-preserving hoist (`const mode = normalise...; mode === "append"`)
  //     while every behavioural test stayed green.
  //
  // What they were reaching for is now held by BEHAVIOUR, in tests that observe
  // what the SDK call receives rather than what the file says:
  //   - `append mode on a RESUMED session does not resend the instructions`
  //   - `append mode delivers a pending compaction summary on a RESUMED turn`
  //   - `systemPromptMode append sets NO system-prompt option of any kind`
  //   - `a resumed turn also carries the compaction summary` (replace mode)
  // Those fail when the behaviour regresses, and do not fail when it does not.

  assert.equal(
    /\bappendSystemPrompt\b/.test(bridge), false,
    "claude-bridge.ts names appendSystemPrompt, which is not an SDK option",
  );
});

test("a compaction summary survives a request that fails without reaching the client", () => {
  // The real loss window: consumeCompactSummary() runs once, before the retry
  // loop, so a non-transient failure used to clear the summary from the store
  // and lose the rotated-away conversation for good. The restore lives in a
  // `finally`; this pins it, since the store itself is inside the SDK-importing
  // module and cannot be driven from here.
  const bridge = sourceOf("src", "claude-bridge.ts");

  assert.match(bridge, /\}\s*finally\s*\{/, "the retry loop has no finally block to restore the summary");
  assert.match(
    bridge, /sessionStore\.setCompactSummary\s*\(/,
    "nothing puts a consumed compaction summary back, so a failed request loses it",
  );
});

test("the known-non-SDK escape hatch is empty, and every entry names a tracking issue", () => {
  // The list is an escape hatch from the compile-time option-name guard: a
  // name added here is certified by both guards as "correctly not an SDK
  // option". Empty is the intended steady state -- its one entry,
  // appendSystemPrompt, was removed by booqi-app/infra#202. Pinning the
  // contents makes widening it a visible, deliberate act rather than a
  // two-line edit that turns the guard green again.
  assert.deepEqual(Object.keys(KNOWN_NON_SDK_OPTIONS), []);
  assert.deepEqual([...KNOWN_NON_SDK_OPTION_NAMES], []);

  // Typed explicitly: the object is empty today, so Object.entries infers
  // `unknown` for the value and the loop would not compile. It still has to
  // hold the day a name is added back.
  const entries = Object.entries(KNOWN_NON_SDK_OPTIONS) as [string, string][];
  for (const [name, issue] of entries) {
    assert.match(issue, /^booqi-app\/infra#\d+$/, `${name} names no tracking issue`);
  }
});

test("the README documents what the agent's prompt does and does not include", () => {
  // AC-3 of booqi-app/infra#202. The choice between append and replace is a
  // product decision, and the thing an operator most needs from the README is
  // what the modes do NOT differ on: CLAUDE.md/memory loading and today's date
  // are injected from `cwd` in BOTH modes. An earlier revision claimed the
  // opposite and used it to pick the default. That must live somewhere an
  // operator reads, not only in a source comment.
  const readme = readFileSync(join(repoRoot, "README.md"), "utf-8");

  assert.match(readme, /systemPromptMode/);
  assert.match(readme, /## The system prompt/);
  // Restored: the rewrite in the first round dropped this without replacing it.
  assert.match(readme, /## Known limitations/);
  // Every defect still shipped must be findable from the README.
  for (const issue of Object.values(KNOWN_NON_SDK_OPTIONS) as string[]) {
    assert.ok(readme.includes(issue), `README does not mention ${issue}`);
  }
});

test("no system prompt leaves the key off entirely", () => {
  // Not `systemPrompt: ""` -- that is a real, empty prompt to the SDK and
  // suppresses the preset, which is the defect booqi-app/infra#202 fixed.
  const opts = optionsFor(baseConfig());
  assert.equal("systemPrompt" in opts, false);
  assert.equal("appendSystemPrompt" in opts, false);
});

// ── The dropped-entries log line ────────────────────────────────────

test("the dropped-entries message names __proto__ only when it was dropped", () => {
  assert.equal(
    droppedMcpServersMessage(["broken"]),
    'Claude Runner: ignored 1 unusable mcpServers entry: "broken" -- each must be an object',
  );
  assert.match(
    droppedMcpServersMessage(["broken", "__proto__"]),
    /ignored 2 unusable mcpServers entries: "broken", "__proto__" -- each must be an object, and "__proto__" is not a usable server name$/,
  );
});

test("the dropped-entries message quotes names rather than interpolating them", () => {
  // A server name comes from a config file; a newline in one would forge a
  // log line.
  assert.match(droppedMcpServersMessage(["a\nFAKE LOG LINE"]), /"a\\nFAKE LOG LINE"/);
});

test("tsconfig typechecks every module under src/", () => {
  // Same failure mode as install.sh's named copy list: split another module
  // out and nothing typechecks it, with CI green.
  const tsconfig = JSON.parse(readFileSync(join(repoRoot, "tsconfig.json"), "utf-8"));
  const covered = JSON.stringify(tsconfig.include) + String(tsconfig["//"]);
  const modules = readdirSync(join(repoRoot, "src")).filter((f) => f.endsWith(".ts"));

  for (const mod of modules) {
    assert.ok(
      covered.includes(`src/${mod}`),
      `src/${mod} is neither in tsconfig "include" nor named in the exclusion rationale`,
    );
  }
});

test("the README settings table and the config schema declare the same keys", () => {
  // config.example.json is bound to the schema and the schema is bound to
  // buildBridgeOptions, but nothing bound the README -- so a key could be
  // added, wired up and shipped while the one document an operator reads never
  // mentioned it. That already happened to maxRetries. Parsed rather than
  // substring-matched: a whitespace change in the table is not a defect, and a
  // key documented in one of the README's other tables is not documentation of
  // a config key.
  const schema = JSON.parse(readFileSync(join(repoRoot, "openclaw.plugin.json"), "utf-8")).configSchema;
  const readme = readFileSync(join(repoRoot, "README.md"), "utf-8");

  const header = readme.indexOf("| Option | Default | Description |");
  assert.notEqual(header, -1, "the README config table header moved or changed");

  const documented = new Set<string>();
  for (const line of readme.slice(header).split("\n").slice(2)) {
    if (!line.startsWith("|")) break;
    const cell = line.split("|")[1]?.trim().replace(/^`|`$/g, "");
    if (cell) documented.add(cell);
  }

  const undocumented = Object.keys(schema.properties).filter((k) => !documented.has(k));
  assert.deepEqual(undocumented, [], `config keys with no README row: ${undocumented}`);

  const orphaned = [...documented].filter((k) => !(k in schema.properties));
  assert.deepEqual(orphaned, [], `README rows for keys the schema does not declare: ${orphaned}`);
});

// ── The session-hint writer (booqi-app/app#459, AC-C1 … AC-C6) ──────
//
// WHAT THESE PROVE, and why the shape matters. The cell gateway's MCP relay
// has READ `?session=` (`CHAT_SESSION_QUERY`) since app#480 and nothing ever
// WROTE it, so in production the SDK session named no exchange and the gateway
// answered `tools/list` with `{tools: []}`. This is that writer.
//
// Every assertion below is on the object `buildQueryOptions` RETURNS, or on
// what `applySessionHint` returns -- never on the source text of either. The
// worst measured defect in this estate was on this repository: the regression
// guards of booqi-app/infra#202 were regexes over `claude-bridge.ts`, and
// three reviewers each re-introduced the exact defect the issue existed for,
// in a spelling the regex did not match, with the whole suite green.

/** The URL the issue names verbatim in AC-C1. */
const AC_C1_URL = "http://127.0.0.1:3004/mcp";
const AC_C1_SERVERS = { booqi: { type: "http", url: AC_C1_URL } };

/** Collects the log lines one `buildQueryOptions` call emits. */
function optionsWithHint(
  config: BridgeConfig,
  chatSessionId: string | undefined,
): { opts: Record<string, any>; logs: string[] } {
  const logs: string[] = [];
  const opts = buildQueryOptions(
    "claude-opus-4-6",
    undefined,
    undefined,
    "session-1",
    config,
    new AbortController(),
    { chatSessionId, log: (message) => logs.push(message) },
  );
  return { opts, logs };
}

/** The relay's own reader: `requestUrl.searchParams.get(CHAT_SESSION_QUERY)`. */
function sessionAsTheRelayReadsIt(url: string): string | null {
  return new URL(url).searchParams.get(SESSION_HINT_PARAM);
}

function countOf(haystack: string, needle: string): number {
  return haystack.split(needle).length - 1;
}

test("AC-C1: the configured loopback URL reaches the SDK options carrying the session", () => {
  const { opts } = optionsWithHint(baseConfig({ mcpServers: AC_C1_SERVERS }), "chat-7");

  // Exact string equality, not a substring test: this is the whole URL the
  // SDK is handed, so a mutant that also rewrote the host or the path shows up
  // here rather than hiding behind an `includes("session=")`.
  assert.equal(opts.mcpServers.booqi.url, `${AC_C1_URL}?session=chat-7`);
  // And the rest of the entry is intact -- the transport type especially.
  assert.equal(opts.mcpServers.booqi.type, "http");
});

test("AC-C1: the identifier is encoded, so it cannot inject a second parameter", () => {
  // Not a conformant identifier (`chatSessionIdSchema` is [A-Za-z0-9_-]{1,200}),
  // which is exactly why it is the one tested: the schema lives in another
  // repository and this module must not depend on it holding.
  const hostile = "a b/c&session=evil&foo=1";
  const { opts } = optionsWithHint(baseConfig({ mcpServers: AC_C1_SERVERS }), hostile);
  const url: string = opts.mcpServers.booqi.url;

  // The property that matters is the round trip through the relay's reader.
  assert.equal(sessionAsTheRelayReadsIt(url), hostile);
  // One query string, one `session=`, and nothing else got through: the
  // injected `foo` must NOT be a parameter of its own.
  assert.equal(countOf(url, "?"), 1);
  assert.equal(countOf(url, "session="), 1);
  assert.equal(new URL(url).searchParams.get("foo"), null);
  assert.equal([...new URL(url).searchParams.keys()].length, 1);
});

test("AC-C2: with no identifier the URL is handed over unchanged, and once logged", () => {
  const { opts, logs } = optionsWithHint(baseConfig({ mcpServers: AC_C1_SERVERS }), undefined);

  assert.equal(opts.mcpServers.booqi.url, AC_C1_URL);
  assert.equal(sessionAsTheRelayReadsIt(opts.mcpServers.booqi.url), null);
  assert.equal(logs.length, 1, `expected exactly one log line, got ${logs.length}: ${logs}`);
  assert.match(logs[0], /no chat-session hint written/);
  assert.match(logs[0], /"booqi"/);
});

test("AC-C2: an absent identifier NEVER becomes a literal default", () => {
  // The cross-user defect this battery exists for. `apps/cell/src/sessions.ts`
  // sets DEFAULT_SESSION_ID = "default" and `chatSessionIdSchema` imposes no
  // entropy, so `?session=default` is guessed in one attempt -- and every
  // hintless request would land on the same exchange.
  // A boxed `String` and an object with a `toString` are in the table on
  // purpose: `typeof new String("x") !== "string"`, so they must fail CLOSED
  // rather than be coerced into a routing key nobody named. They pin the
  // `typeof` guard specifically rather than incidentally.
  for (const absent of [
    undefined, "", "   ", "\n", "\t\r\n ", null, 7, 0, NaN, true, false, {}, [],
    new String("boxed"), { toString: () => "evil" }, () => "evil",
  ] as unknown[]) {
    assert.equal(normaliseChatSessionId(absent), undefined, `not absent: ${String(absent)}`);

    const { opts, logs } = optionsWithHint(
      baseConfig({ mcpServers: AC_C1_SERVERS }),
      absent as string | undefined,
    );
    assert.equal(opts.mcpServers.booqi.url, AC_C1_URL, `URL mutated for ${String(absent)}`);
    assert.equal(opts.mcpServers.booqi.url.includes("session="), false);
    assert.equal(logs.length, 1);
  }
});

test("AC-C2: a URL that does not parse is handed over unchanged and says why", () => {
  const broken = { booqi: { type: "http", url: "not a url" } };
  const { opts, logs } = optionsWithHint(baseConfig({ mcpServers: broken }), "chat-7");

  assert.equal(opts.mcpServers.booqi.url, "not a url");
  assert.equal(logs.length, 1);
  assert.match(logs[0], /is not a parseable URL string/);
});

test("AC-C3: an existing query string keeps its parameters and gains one session", () => {
  const configured = { booqi: { type: "http", url: "http://127.0.0.1:3004/mcp?foo=1" } };
  const { opts } = optionsWithHint(baseConfig({ mcpServers: configured }), "chat-7");
  const url: string = opts.mcpServers.booqi.url;

  assert.equal(new URL(url).searchParams.get("foo"), "1");
  assert.equal(sessionAsTheRelayReadsIt(url), "chat-7");
  assert.equal(countOf(url, "session="), 1);
  assert.deepEqual([...new URL(url).searchParams.keys()], ["foo", "session"]);
});

test("AC-C3: a configured session parameter is overwritten, not duplicated", () => {
  const configured = { booqi: { type: "http", url: "http://127.0.0.1:3004/mcp?session=stale&foo=1" } };
  const { opts } = optionsWithHint(baseConfig({ mcpServers: configured }), "chat-7");
  const url: string = opts.mcpServers.booqi.url;

  assert.equal(countOf(url, "session="), 1);
  assert.equal(url.includes("stale"), false);
  assert.equal(sessionAsTheRelayReadsIt(url), "chat-7");
  assert.equal(new URL(url).searchParams.getAll("session").length, 1);
  assert.equal(new URL(url).searchParams.get("foo"), "1");
});

test("AC-C4: only an entry with a url is rewritten; a stdio entry is untouched", () => {
  const stdio = { command: "node", args: ["./tool-api.mjs"] };
  const configured = { booqi: { type: "http", url: AC_C1_URL }, local: stdio };
  const { opts } = optionsWithHint(baseConfig({ mcpServers: configured }), "chat-7");

  assert.equal(opts.mcpServers.booqi.url, `${AC_C1_URL}?session=chat-7`);
  // Identity, not just deep equality: the very object from configuration is
  // what the SDK gets, so nothing about it can have been rewritten.
  assert.equal(opts.mcpServers.local, stdio);
  assert.deepEqual(opts.mcpServers.local, { command: "node", args: ["./tool-api.mjs"] });
  assert.equal("url" in opts.mcpServers.local, false);
  assert.equal("session" in opts.mcpServers.local, false);
});

test("AC-C4: the writer does not mutate the configured object", () => {
  const configured = { booqi: { type: "http", url: AC_C1_URL } };
  const { opts } = optionsWithHint(baseConfig({ mcpServers: configured }), "chat-7");

  assert.equal(configured.booqi.url, AC_C1_URL, "configuration was mutated in place");
  assert.notEqual(opts.mcpServers.booqi, configured.booqi);
});

test("AC-C4: readMcpServers' sanitising still holds through the writer", () => {
  // The `__proto__` refusal and the "empty map is absent" rule, re-asserted on
  // the far side of the rewrite rather than only on readMcpServers.
  const withProto = JSON.parse('{"__proto__": {"type":"http","url":"http://127.0.0.1:3004/mcp"},'
    + '"booqi": {"type":"http","url":"http://127.0.0.1:3004/mcp"}}');
  const { opts } = optionsWithHint(baseConfig({ mcpServers: withProto }), "chat-7");

  assert.deepEqual(Object.keys(opts.mcpServers), ["booqi"]);
  assert.equal(Object.getPrototypeOf(opts.mcpServers), Object.prototype);
  assert.equal(opts.mcpServers.type, undefined);

  // An empty map is still absent, and an all-url map that empties is too.
  const empty = optionsWithHint(baseConfig({ mcpServers: {} }), "chat-7");
  assert.equal("mcpServers" in empty.opts, false);
  assert.equal(empty.logs.length, 0);
});

test("AC-C5: server names survive the rewrite verbatim", () => {
  // The SDK derives `mcp__<name>__<tool>` from these, so a rewritten name
  // silently breaks every tool call while the URL looks perfect.
  const names = ["booqi", "booqi_tool-api", "Booqi.V2", "a"];
  const configured: Record<string, unknown> = {};
  for (const n of names) configured[n] = { type: "http", url: AC_C1_URL };

  const { opts } = optionsWithHint(baseConfig({ mcpServers: configured }), "chat-7");

  assert.deepEqual(Object.keys(opts.mcpServers), names);
  for (const n of names) {
    assert.equal(opts.mcpServers[n].url, `${AC_C1_URL}?session=chat-7`, `missing hint on ${n}`);
  }
});

test("AC-C6: no log line carries the raw session identifier, on EVERY branch", () => {
  // The identifier is the routing key and has no entropy in the default path,
  // so a log of it is a disclosure: anything that can read the log can then
  // address that exchange.
  //
  // EVERY arm, enumerated. Round 1 of this PR asserted only the written arm
  // and the no-identifier arm, and a mutant that interpolated the identifier
  // into the UNPARSEABLE-URL reason string survived the whole suite -- the one
  // survivor in a battery of seventeen. An arm nobody asserts on is an arm
  // that can disclose. This table is the fix, and `arms` is what it examined.
  const identifier = "chat-cafe1234-secret";
  const arms: Array<[string, BridgeConfig, string | undefined]> = [
    ["hint written", baseConfig({ mcpServers: AC_C1_SERVERS }), identifier],
    ["no identifier", baseConfig({ mcpServers: AC_C1_SERVERS }), undefined],
    ["url does not parse", baseConfig({ mcpServers: { booqi: { type: "http", url: "nope" } } }), identifier],
    ["url is not a string", baseConfig({ mcpServers: { booqi: { type: "http", url: 7 } } }), identifier],
    [
      "one hinted, one unparseable",
      baseConfig({ mcpServers: { ok: { type: "http", url: AC_C1_URL }, bad: { type: "http", url: "::::" } } }),
      identifier,
    ],
  ];

  assert.equal(arms.length, 5, "the arm table must enumerate every branch that logs");

  for (const [label, config, id] of arms) {
    const { logs } = optionsWithHint(config, id);
    assert.equal(logs.length, 1, `${label}: expected exactly one line, got ${logs.length}: ${logs}`);
    assert.equal(
      logs[0].includes(identifier), false,
      `${label}: log line discloses the identifier: ${logs[0]}`,
    );
  }

  // The success line still says enough to tell "written" from "not written",
  // and a mixed outcome reports the success as well as the failure -- a line
  // naming only the failure reads as if nothing at all was hinted.
  const written = optionsWithHint(baseConfig({ mcpServers: AC_C1_SERVERS }), identifier);
  assert.match(written.logs[0], /wrote the chat-session hint/);
  assert.match(written.logs[0], /"booqi"/);

  const mixed = optionsWithHint(
    baseConfig({ mcpServers: { ok: { type: "http", url: AC_C1_URL }, bad: { type: "http", url: "::::" } } }),
    identifier,
  );
  assert.match(mixed.logs[0], /"bad"/);
  assert.match(mixed.logs[0], /DID get the hint: "ok"/);
});

test("AC-C6: the message builders cannot disclose what they are not given", () => {
  // Not a source-text assertion: `fn.length` is a runtime property of the
  // function object, and the behavioural table above is what actually holds
  // the property. This only pins that no identifier-shaped parameter was
  // added to a builder, which is how the surviving mutant got in.
  assert.equal(sessionHintMessage.length, 1);
  assert.equal(unhintedMcpServersMessage.length, 2, "only `unhinted` and the boolean are required");
  assert.match(sessionHintMessage(["booqi"]), /not logged/);
});

test("AC-C2: a non-string url is reported, while a stdio entry stays silent", () => {
  // Distinguishing the three states. A `url` that is PRESENT but not a string
  // is a misconfiguration and must be named; an entry with NO `url` is a stdio
  // entry and has nothing to hint, so silence is correct there. Collapsing the
  // two would let `url: 7` reach the SDK with no line saying why the session
  // has no tools -- `absent` coinciding with `in order`.
  const bad = optionsWithHint(baseConfig({ mcpServers: { booqi: { type: "http", url: 7 } } }), "chat-7");
  assert.equal(bad.logs.length, 1);
  assert.match(bad.logs[0], /"booqi"/);
  assert.equal(bad.opts.mcpServers.booqi.url, 7);

  const stdio = optionsWithHint(baseConfig({ mcpServers: { local: { command: "node" } } }), "chat-7");
  assert.equal(stdio.logs.length, 0);
  assert.deepEqual(stdio.opts.mcpServers, { local: { command: "node" } });
});

test("applySessionHint reports what it examined, per name", () => {
  // A guard that reports counts rather than "ok" (V2.28). `hinted` and
  // `unhinted` are what the caller logs from, so they are asserted directly.
  const outcome = applySessionHint(
    {
      hinted: { type: "http", url: AC_C1_URL },
      broken: { type: "http", url: "::::" },
      stdio: { command: "node" },
    },
    "chat-7",
  );

  assert.deepEqual(outcome.hinted, ["hinted"]);
  assert.deepEqual(outcome.unhinted, ["broken"]);
  assert.deepEqual(Object.keys(outcome.servers), ["hinted", "broken", "stdio"]);

  const none = applySessionHint({ booqi: { type: "http", url: AC_C1_URL } }, undefined);
  assert.deepEqual(none.hinted, []);
  assert.deepEqual(none.unhinted, ["booqi"]);
  assert.equal(none.servers.booqi.url, AC_C1_URL);
});


// ───────────────────────────────────────────────────────────────────────────
// booqi-app/infra#207 -- the `tools` key must not fail open
//
// Every assertion below is on the OBSERVABLE BEHAVIOUR of the exported
// functions: the object `buildQueryOptions` returns, or the error it throws.
// None of them reads source text. That is a requirement of the issue (AC-1..
// AC-5 are "graded on the behaviour of the exported functions, never on source
// text") and of driver-prompt V2.24: a test that greps for an identifier is
// satisfied by a comment and misses every alternative spelling of the defect.
// AC-6 is the single declared exception -- it is a documentation criterion --
// and it is discharged by PARSING the shipped files, not by matching source.
// ───────────────────────────────────────────────────────────────────────────

/** Every present-but-unusable `tools` value AC-2 names, plus the falsy ones. */
const UNUSABLE_TOOLS_VALUES: Array<[string, unknown]> = [
  // The four types AC-2 names explicitly.
  ["a string", "Bash"],
  ["a number", 3],
  ["null", null],
  ["a plain object", { Bash: true }],
  // The falsy ones. These matter MORE than the four above, because under the
  // old `if (config.tools)` predicate every one of them was already
  // indistinguishable from an absent key -- and so was silently given the full
  // built-in tool set. A mutant that keeps a default but gates it on
  // truthiness or on `?.length` passes AC-1 and dies here.
  ["the empty string", ""],
  ["zero", 0],
  ["false", false],
  ["NaN", Number.NaN],
];

test("AC-1: a configuration with NO `tools` key yields tools: [] (not the SDK's built-ins)", () => {
  const config = baseConfig();

  // The premise of the test, asserted rather than assumed: the key really is
  // absent, not present-and-undefined. If `baseConfig` ever grows a `tools`
  // key this test would otherwise quietly stop testing anything.
  assert.equal("tools" in config, false, "baseConfig must carry NO tools key");

  const opts = optionsFor(config);

  // `"tools" in opts` and the value are two separate claims. The old code
  // failed the first one, and a fix that sets `tools: undefined` would pass a
  // deepEqual against `undefined` while leaving the SDK on its built-ins.
  assert.equal("tools" in opts, true, "an absent key must still produce a tools option");
  assert.deepEqual(opts.tools, [], "an absent key means NO tools");
  assert.equal(Array.isArray(opts.tools), true);
});

test("AC-1: the default is not shared mutable state between calls", () => {
  const a = optionsFor(baseConfig());
  const b = optionsFor(baseConfig());

  a.tools.push("Bash");

  assert.deepEqual(b.tools, [], "one caller's mutation must not widen another's tool set");
  assert.deepEqual([...DEFAULT_TOOLS_WHEN_ABSENT], []);
});

test("AC-2: a present-but-non-array `tools` fails configuration load, naming the key", () => {
  let examined = 0;

  for (const [label, value] of UNUSABLE_TOOLS_VALUES) {
    examined += 1;

    // (a) configuration load -- `buildBridgeOptions` is what `index.ts` calls
    // in `register()`, so a throw here means the plugin never registers and the
    // bridge never starts.
    assert.throws(
      () => buildBridgeOptions(JSON.parse(JSON.stringify({ tools: value })) as Record<string, unknown>),
      (err: unknown) => {
        assert.ok(err instanceof Error, `${label}: expected an Error`);
        assert.match(err.message, /"tools"/, `${label}: the error must name the key`);
        return true;
      },
      `${label}: configuration load must refuse it`,
    );

    // (b) and the option builder itself, so the refusal does not depend on the
    // caller having gone through configuration load. No options object exists.
    let produced: unknown = "NOTHING WAS PRODUCED";
    assert.throws(
      () => { produced = optionsFor(baseConfig({ tools: value as never })); },
      /"tools"/,
      `${label}: buildQueryOptions must refuse it`,
    );
    assert.equal(produced, "NOTHING WAS PRODUCED", `${label}: no options object may be produced`);

    // (c) and it is refused, not coerced and not silently defaulted. Asserting
    // the absence of the default is the whole point: `readTools` returning `[]`
    // for a bad value would be a fail-CLOSED bug but still a bug -- it would
    // make `"tools": "Bash"` look like it worked.
    assert.throws(() => readTools(value), /"tools"/, label);
    assert.match(unusableToolsMessage(value), /"tools"/, label);
  }

  // What this guard EXAMINED, not just that it is ok.
  assert.equal(examined, 8, "all eight unusable values must have been examined");
  assert.equal(examined, UNUSABLE_TOOLS_VALUES.length);
});

test("AC-2: `null` is refused and is NOT treated as absent", () => {
  // Called out on its own because `null` is the one value for which "absent"
  // is a defensible reading, and taking that reading would reinstate the
  // defect for every config written by hand with an explicit null.
  assert.throws(() => readTools(null), /"tools"/);
  assert.notDeepEqual(
    (() => { try { return readTools(null); } catch { return "threw"; } })(),
    [],
  );
});

test("AC-3: an absent key does not inherit the SDK built-ins, by any spelling", () => {
  // THE MUTANT-KILLING ASSERTION. It is red under every spelling of the
  // defect, because it asks what the SDK receives and not how the code asks:
  //   if (config.tools)                       -> no `tools` key at all
  //   if (config.tools?.length)               -> no `tools` key at all
  //   if (config.tools && config.tools.length)-> no `tools` key at all
  //   opts.tools = config.tools               -> `tools` present but undefined
  // The last spelling is the reason `"tools" in opts` is not sufficient on its
  // own and the reason `undefined` is excluded explicitly.
  const opts = optionsFor(baseConfig());

  assert.notEqual(opts.tools, undefined, "tools must not be undefined");
  assert.equal(Array.isArray(opts.tools), true, "tools must be an array");
  assert.equal(opts.tools.length, 0, "and that array must be empty");

  for (const builtin of ["Bash", "Read", "Write", "Edit", "WebFetch", "WebSearch"]) {
    assert.equal(
      opts.tools.includes(builtin),
      false,
      `the SDK must not be left free to use ${builtin}`,
    );
  }
});

test("AC-4: bypassPermissions can never ship with an undefined tool set", () => {
  // AC-4 is a UNIVERSAL ("there is no input to buildQueryOptions that yields
  // permissionMode bypassPermissions with opts.tools undefined"), and a
  // universal is not discharged by one example. It is discharged here by
  // sweeping the cartesian product of EVERY input dimension this function
  // branches on -- that is what makes it exhaustive over the branch structure
  // rather than over one happy path.
  //
  // "Every dimension" is a checkable claim, so here is the list it was checked
  // against, one line per `if`/ternary in `buildQueryOptions`:
  //   config.skipPermissions                       -> skipPermissions, 2
  //   resumeSessionId / else if (newSessionId)      -> resume 2 x newSessionId 2,
  //                                                   so the BOTH-ABSENT arm runs
  //   systemPrompt                                  -> systemPrompt, 2
  //   normaliseSystemPromptMode(...) === "append"   -> systemPromptMode, 4
  //   if (mcpServers)                               -> mcpServers, 4
  //   outcome.unhinted.length / else hinted.length  -> session, 2 (a hint plus a
  //                                                   log sink, or neither)
  //   config.strictMcpConfig ?? true                -> strictMcpConfig, 3
  //   config.effort / config.maxBudgetUsd           -> extra, 4, crossed rather
  //                                                   than set together
  //   config.maxTurns ?? DEFAULT_MAX_TURNS          -> extra, 4 (extras[3])
  //
  // And `shapes` below is COMPUTED from those arrays' lengths, not restated as
  // a literal product. That distinction is load-bearing: with a restated
  // product, shrinking a loop and editing the number in the same commit is
  // invisible -- a control that removed the `newSessionId` dimension and
  // re-pinned the arithmetic self-consistently survived the suite. Deriving the
  // figure and pinning the ABSOLUTE total kills that mutant.
  const toolsCases: Array<unknown> = [
    "ABSENT",
    [],
    ["mcp__booqi__open_invoices"],
    ...UNUSABLE_TOOLS_VALUES.map(([, v]) => v),
  ];

  let produced = 0;
  let refused = 0;
  let bypass = 0;

  // `effort` and `maxBudgetUsd` guard separate `if`s, so they are crossed rather
  // than set together: the paired-only version left effort-set/budget-unset and
  // its converse unexercised.
  const extras: Array<Partial<BridgeConfig>> = [
    {},
    { effort: "high" },
    { maxBudgetUsd: 5 },
    { effort: "high", maxBudgetUsd: 5, maxTurns: 1 },
  ];
  // All three reachable states of the session-hint branch, so that BOTH
  // `session.log?.(...)` call sites really run rather than short-circuiting on
  // an absent sink: no hint and no sink; a hint and a sink (the `hinted` arm);
  // and a sink with NO hint (the `unhinted` arm, which the first two never
  // reach -- the hintless case had no sink to call).
  const sessions: Array<Record<string, any>> = [
    {},
    { chatSessionId: "chat-1", log: () => {} },
    { log: () => {} },
  ];

  const skipPermissionsCases = [true, false];
  const systemPromptCases = [undefined, "be brief"];
  const systemPromptModeCases = [undefined, "append", "replace", "Replace"];
  const resumeCases = [undefined, "sdk-session-7"];
  const newSessionIdCases = [undefined, "session-1"];
  const mcpServersCases = [undefined, CELL_MCP_SERVERS, {}, "not an object"];
  const strictMcpConfigCases = [undefined, true, false];

  for (const skipPermissions of skipPermissionsCases) {
    for (const systemPrompt of systemPromptCases) {
      for (const systemPromptMode of systemPromptModeCases) {
        for (const resume of resumeCases) {
         for (const newSessionId of newSessionIdCases) {
          for (const mcpServers of mcpServersCases) {
            for (const strictMcpConfig of strictMcpConfigCases) {
              for (const extra of extras) {
               for (const session of sessions) {
                for (const tools of toolsCases) {
                  const config = baseConfig({
                    skipPermissions,
                    systemPromptMode: systemPromptMode as never,
                    mcpServers,
                    strictMcpConfig,
                    ...extra,
                    ...(tools === "ABSENT" ? {} : { tools: tools as never }),
                  });

                  let opts: Record<string, any> | undefined;
                  try {
                    opts = buildQueryOptions(
                      "claude-opus-4-6", systemPrompt, resume, newSessionId,
                      config, new AbortController(), session,
                    );
                  } catch (err) {
                    refused += 1;
                    assert.match((err as Error).message, /"tools"/);
                    continue;
                  }

                  produced += 1;
                  // The universal, on every object actually produced.
                  assert.equal("tools" in opts, true);
                  assert.equal(Array.isArray(opts.tools), true);
                  if (opts.permissionMode === "bypassPermissions") {
                    bypass += 1;
                    assert.notEqual(
                      opts.tools, undefined,
                      "bypassPermissions with an undefined tool set is the defect itself",
                    );
                    assert.equal(Array.isArray(opts.tools), true);
                  }
                }
               }
              }
            }
          }
         }
        }
      }
    }
  }

  // Counts, so a sweep that silently stopped iterating cannot read as a pass --
  // and DERIVED from the dimension arrays, so a sweep that was quietly narrowed
  // cannot either. The absolute figure is the pin; `shapes` is the measurement.
  const shapes = [
    skipPermissionsCases, systemPromptCases, systemPromptModeCases, resumeCases,
    newSessionIdCases, mcpServersCases, strictMcpConfigCases, extras, sessions,
  ].reduce((n, dimension) => n * dimension.length, 1);

  assert.equal(shapes, 9216, "9 dimensions: 2*2*4*2*2*4*3*4*3");
  assert.equal(toolsCases.length, 11);
  assert.equal(produced + refused, 101376, "9216 shapes x 11 tools values");
  assert.equal(produced + refused, shapes * 11, "every combination must have been exercised");
  assert.equal(produced, 3 * shapes, "the three usable tools values must all produce an object");
  assert.equal(refused, 8 * shapes, "the eight unusable ones must all be refused");
  assert.equal(bypass, 3 * (shapes / 2), "half the produced objects carry bypassPermissions");
});

test("AC-4: the SHIPPED example configuration produces bypassPermissions AND tools: []", () => {
  // Not a hand-written config: the actual file install.sh copies into place.
  // This is the combination the issue was filed about -- skipPermissions true,
  // no tools key -- read from the artifact rather than restated.
  const example = JSON.parse(readFileSync(join(repoRoot, "config.example.json"), "utf-8"));
  assert.equal(example.skipPermissions, true, "the example must still ship skipPermissions");

  const opts = optionsFor(baseConfig(buildBridgeOptions(example) as Partial<BridgeConfig>));

  assert.equal(opts.permissionMode, "bypassPermissions");
  assert.equal(opts.allowDangerouslySkipPermissions, true);
  assert.deepEqual(opts.tools, []);
});

test("AC-5: a configured tool set still reaches the SDK unchanged", () => {
  // The fix must not turn the restriction into a constant of its own:
  // booqi-app/infra#195's configured value is still what ships.
  const configured = ["mcp__booqi__whatever", "mcp__booqi__open_invoices"];
  const opts = optionsFor(baseConfig({ tools: configured }));

  assert.deepEqual(opts.tools, configured);
  assert.equal(opts.tools, configured, "the very same array, not a rebuilt one");

  // And a configured `[]` survives as `[]` -- the value a cell ships. This is
  // the assertion the `?.length` spelling of the defect fails while looking
  // more careful than the original.
  const empty: string[] = [];
  const emptyOpts = optionsFor(baseConfig({ tools: empty }));
  assert.deepEqual(emptyOpts.tools, []);
  assert.equal(emptyOpts.tools, empty, "a configured [] is passed through, not re-defaulted");

  // Order and duplicates are configuration too, not something to normalise.
  const odd = ["b", "a", "a"];
  assert.deepEqual(optionsFor(baseConfig({ tools: odd })).tools, ["b", "a", "a"]);

  // And through configuration load as well.
  assert.deepEqual(buildBridgeOptions({ tools: configured }).tools, configured);
  assert.deepEqual(buildBridgeOptions({ tools: [] }).tools, []);
  assert.deepEqual(buildBridgeOptions({}).tools, [], "absent at load time is also no tools");
});

test("AC-6: config.example.json carries an explicit `tools` key, and it is restrictive", () => {
  // Parsed, not grepped. The absent key WAS the defect, so the shipped example
  // must now show the default rather than demonstrate the old hazard.
  const example = JSON.parse(readFileSync(join(repoRoot, "config.example.json"), "utf-8"));

  assert.equal(
    Object.prototype.hasOwnProperty.call(example, "tools"), true,
    "config.example.json must carry an explicit tools key",
  );
  assert.deepEqual(example.tools, []);

  // And the key the example now carries must be one the plugin schema admits,
  // otherwise the example and the schema are green while disagreeing.
  const schema = JSON.parse(readFileSync(join(repoRoot, "openclaw.plugin.json"), "utf-8")).configSchema;
  assert.equal("tools" in schema.properties, true);
  assert.equal(schema.properties.tools.type, "array");

  // The schema description is the documented default a user reads in their
  // editor. It used to say "default: all claude_code tools", which is now a
  // false statement about the code in this commit.
  assert.doesNotMatch(
    schema.properties.tools.description,
    /default:\s*all/i,
    "the schema must not still advertise the removed all-built-ins default",
  );
});

test("AC-6: README documents that an absent `tools` key means no built-in tools", () => {
  const readme = readFileSync(join(repoRoot, "README.md"), "utf-8");

  // A documentation criterion, declared as such by the issue. Held to the
  // claim rather than to an identifier: the upgrade note must state the
  // direction of the change and must name the built-in tools a user loses.
  assert.match(readme, /absent\s+`?tools`?\s+key\s+now\s+means\s+no\s+tools/i);
  assert.match(readme, /\*\*An absent key means NO built-in tools\.\*\*/);
  assert.match(readme, /behaviour change/i);
  for (const builtin of ["Bash", "Read", "Write", "Edit", "WebFetch", "WebSearch"]) {
    assert.ok(readme.includes(builtin), `the upgrade note must name ${builtin}`);
  }
});

test("the unusable-`tools` message cannot be mistaken for a stale SDK session", () => {
  // `claude-bridge.ts` classifies an SDK error as a stale conversation with
  // /no conversation found|session/i, and then DISCARDS the caller's
  // conversation and mints a new id. A configuration message matching that
  // pattern would throw away a user's chat in order to report a typo in
  // `config.json`. Asserted on the produced message, over every value that can
  // produce one -- not on the source line, which would not survive a reword.
  const staleSessionHeuristic = /no conversation found|session/i;
  let examined = 0;

  for (const [label, value] of UNUSABLE_TOOLS_VALUES) {
    examined += 1;
    const message = unusableToolsMessage(value);
    assert.match(message, /"tools"/, label);
    assert.doesNotMatch(message, staleSessionHeuristic, `${label}: ${message}`);
  }

  assert.equal(examined, 8, "all eight unusable values must have been examined");
});

test("the absent-key default cannot be widened at runtime", () => {
  // `readonly string[]` is erased by the compiler, so the type says nothing at
  // runtime. Frozen, so no cast can widen the default for every later session;
  // `readTools` also returns a copy, so both the constant and the caller are
  // protected. One of the two alone would be enough today, which is why a test
  // pins both.
  assert.equal(Object.isFrozen(DEFAULT_TOOLS_WHEN_ABSENT), true);
  assert.throws(() => { (DEFAULT_TOOLS_WHEN_ABSENT as string[]).push("Bash"); }, TypeError);
  assert.deepEqual([...DEFAULT_TOOLS_WHEN_ABSENT], []);
  assert.deepEqual(optionsFor(baseConfig()).tools, []);
});

// ── S1 / AC-1: the classifier names the rule, and the renderer never
//    names the value (booqi-app/infra#327) ───────────────────────────
//
// FIVE refusal rules exist in the classifier, counted out of the source and
// not taken on trust: `not-a-string`, `blank`, `not-an-agent-session-key`,
// `blank-tail`, `tail-not-a-chat-session-id`. One arm per rule below.

const AC_S1_RULE_CASES: Array<[AffinityRefusalRule, unknown[]]> = [
  ["not-a-string", [undefined, null, 123, ["agent:a:chat-1"], { v: 1 }]],
  ["blank", ["", "   ", "\t\n"]],
  // A key whose tail is empty or whitespace lands here: the whole value is
  // trimmed BEFORE the pattern runs, so such a key never matches at all.
  //
  // A bare uuid USED to be listed here. S4 (infra#327 part (iii)) made it
  // ACCEPTED, because `apps/cell`'s relay now registers it as an alias
  // (app#615); it is pinned accepted by the S4 arms at the end of this file.
  // A non-uuid opaque value stays here, under the unchanged rule name, so this
  // refusal path is still populated and S1's report still distinguishes it.
  ["not-an-agent-session-key", [
    "not-a-uuid-just-words", "chat-7", "agent:a:", "agent:a: ", "agent::x",
  ]],
  ["tail-not-a-chat-session-id", [
    "agent:a:chat A", "agent:a:agent:b:chat-9", "agent:b:chat-A, agent:b:chat-B", "agent:a:" + "x".repeat(201),
  ]],
];

for (const [rule, values] of AC_S1_RULE_CASES) {
  test(`AC-1 arm: the classifier names the rule \`${rule}\` rather than a bare refusal`, () => {
    // Kill: collapse the rules into one, or drop `rule` from the verdict.
    for (const value of values) {
      const got = examineAgentSessionKey(value);
      assert.equal(got.chatSessionId, undefined, `${JSON.stringify(value)} was accepted`);
      assert.equal(got.verdict.kind, "refused");
      assert.equal(
        got.verdict.kind === "refused" ? got.verdict.rule : undefined,
        rule,
        `${JSON.stringify(value)} reported the wrong rule`,
      );
    }
  });
}

test("AC-1 arm: `blank-tail` is the fifth rule and is defensive-only, by construction", () => {
  // The fifth `return undefined` path exists in the source but is UNREACHABLE
  // today, and this arm is what makes that a measured claim instead of a
  // guess. `normaliseChatSessionId` trims the WHOLE value before the pattern
  // runs, and JS `String.prototype.trim` strips exactly the set regex `\s`
  // matches -- so an all-whitespace tail implies the already-trimmed key ends
  // in whitespace, a contradiction. Such values are refused one rule EARLIER.
  //
  // If anyone reorders the trim or widens `AGENT_SESSION_KEY`, this arm goes
  // red and the reporting of that rule stops being dead code -- which is
  // exactly when someone needs to know.
  for (const value of ["agent:a: ", "agent:a:\t", "agent:a:\n", "agent:a:\u00a0", "agent:a:\u000b"]) {
    const got = examineAgentSessionKey(value);
    assert.equal(got.verdict.kind, "refused");
    assert.equal(
      got.verdict.kind === "refused" ? got.verdict.rule : undefined,
      "not-an-agent-session-key",
      `${JSON.stringify(value)} now reaches blank-tail -- the trim order moved`,
    );
  }
});

test("AC-1 arm: an accepted value is reported `accepted` and yields the chat session", () => {
  for (const [value, expected] of [
    ["agent:boekhouder:chat-7", "chat-7"],
    ["  agent:boekhouder:chat-7  ", "chat-7"],
    ["agent:a:" + "x".repeat(200), "x".repeat(200)],
  ] as Array<[string, string]>) {
    const got = examineAgentSessionKey(value);
    assert.equal(got.verdict.kind, "accepted");
    assert.equal(got.chatSessionId, expected);
  }
});

test("AC-1 arm: `chatSessionFromAgentSessionKey` is a projection of the classifier, never a second copy", () => {
  // Kill: reimplement either side independently. The reported rule and the
  // ROUTING decision must not be able to drift apart -- a report that says
  // `accepted` over a route that refused is worse than no report.
  for (const [, values] of AC_S1_RULE_CASES) {
    for (const value of values) {
      assert.equal(chatSessionFromAgentSessionKey(value), examineAgentSessionKey(value).chatSessionId);
    }
  }
  for (const value of ["agent:a:chat-7", "  agent:a:chat-7  "]) {
    assert.equal(chatSessionFromAgentSessionKey(value), examineAgentSessionKey(value).chatSessionId);
    assert.equal(chatSessionFromAgentSessionKey(value), "chat-7");
  }
});

test("AC-1 arm: ABSENT is decided by the header bag, not by the classifier", () => {
  // Kill: fold `absent` into `not-a-string`. `examineAgentSessionKey(undefined)`
  // IS `not-a-string`; only the reader of the bag knows the header was never
  // sent. This is the distinction the whole slice exists for.
  const names = ["session_id", "x-client-request-id", "x-session-affinity"];
  const absent = examineAffinityHeaders(names, {});
  assert.deepEqual(absent.map((e) => e.verdict.kind), ["absent", "absent", "absent"]);

  // A header that IS present with a non-string value is NOT absent.
  const presentNonString = examineAffinityHeaders(names, { session_id: ["a", "b"] });
  assert.deepEqual(presentNonString[0].verdict, { kind: "refused", rule: "not-a-string" });
  assert.equal(presentNonString[1].verdict.kind, "absent");

  assert.notEqual(
    affinityExaminationSummary(absent),
    affinityExaminationSummary(presentNonString),
    "ABSENT and present-but-refused must not render identically",
  );
});

test("AC-1 arm: the summary reports every name examined, in order, with a verdict each", () => {
  // Kill: emit one aggregate verdict instead of per-name verdicts.
  const names = ["session_id", "x-client-request-id", "x-session-affinity"];
  const line = affinityExaminationSummary(examineAffinityHeaders(names, {
    // Opaque and not uuid-shaped, so still refused after S4.
    "session_id": "not-a-uuid-just-words",
    "x-session-affinity": "agent:a:chat-7",
  }));
  for (const name of names) {
    assert.ok(line.includes(JSON.stringify(name)), `${name} is not reported: ${line}`);
  }
  assert.match(line, /"session_id"=present-but-refused\(not-an-agent-session-key\)/);
  assert.match(line, /"x-client-request-id"=ABSENT/);
  assert.match(line, /"x-session-affinity"=accepted/);
  assert.match(line, /examined 3 session-affinity header names: 1 accepted, 1 present-but-refused, 1 ABSENT/);
});

test("AC-1 arm: NO identifier value, or any fragment of one, reaches the summary", () => {
  // Kill: render the refused value, a prefix of it, or its length.
  const names = ["session_id", "x-client-request-id", "x-session-affinity"];
  const planted = "chatSECRETcafe1234deadbeef";
  const line = affinityExaminationSummary(examineAffinityHeaders(names, {
    "session_id": planted,
    "x-client-request-id": `agent:a:${planted} with spaces`,
    "x-session-affinity": `agent:a:${planted}`,
  }));
  for (const needle of [planted, "SECRET", "cafe1234", "deadbeef", String(planted.length)]) {
    assert.equal(line.includes(needle), false, `the summary discloses ${needle}: ${line}`);
  }
  // ...and it still said something useful about all three.
  assert.match(line, /1 accepted, 2 present-but-refused, 0 ABSENT/);
});

test("AC-1 arm: the hintless log line carries the examination; the hinted one does not", () => {
  // Kill: append the report unconditionally. When an identifier WAS found the
  // affinity verdicts decided nothing, and printing them reads as if they had.
  const examined = examineAffinityHeaders(
    ["session_id", "x-client-request-id", "x-session-affinity"], {},
  );
  const hintless = unhintedMcpServersMessage(["booqi"], false, [], examined);
  assert.match(hintless, /no usable chat-session identifier was available/);
  assert.match(hintless, /3 ABSENT/);

  // Identifier present, one server's URL unparseable: a different reason, and
  // the affinity verdicts are not the explanation.
  const other = unhintedMcpServersMessage(["booqi"], true, [], examined);
  assert.match(other, /not a parseable URL string/);
  assert.equal(/ABSENT/.test(other), false, `affinity verdicts leaked into the wrong branch: ${other}`);

  // Backwards compatible: omitting the report degrades to the old line, it
  // does not fabricate ABSENT.
  assert.equal(/ABSENT/.test(unhintedMcpServersMessage(["booqi"], false)), false);
});

test("AC-1 arm: an omitted report renders UNAVAILABLE, never silence", () => {
  // Kill: fall back to the pre-S1 string when no report was threaded through.
  // Silence would be BYTE-IDENTICAL to a pre-S1 build, so an operator reading
  // `docker logs` could not tell "the old image is still deployed" from "the
  // new image is deployed and the wiring is broken". This line is the
  // measurement instrument for the whole infra#327 chain-head reading; it must
  // not have a failure mode that impersonates the old world.
  const bare = unhintedMcpServersMessage(["booqi"], false);
  assert.match(bare, /affinity-header examination UNAVAILABLE/);
  assert.equal(/ABSENT/.test(bare), false, "an empty report must not fabricate ABSENT");

  // The hinted/unparseable-URL branch stays silent about affinity: those
  // verdicts decided nothing there.
  assert.equal(/UNAVAILABLE/.test(unhintedMcpServersMessage(["booqi"], true)), false);
});

test("AC-1 arm: ABSENT is decided by hasOwn, not by a prototype lookup", () => {
  // Kill: `headers[name] === undefined`. `IncomingMessage.headers` is NOT a
  // null-prototype object, so a header name colliding with `Object.prototype`
  // would read as PRESENT and be refused `not-a-string` while never having
  // been sent -- the exact ABSENT/refused confusion this slice removes.
  for (const name of ["constructor", "toString", "valueOf", "hasOwnProperty"]) {
    const [entry] = examineAffinityHeaders([name], {});
    assert.deepEqual(
      entry.verdict,
      { kind: "absent" },
      `${name} was read off the prototype and reported as present`,
    );
  }
  // A genuinely present value of such a name is still examined normally.
  const [present] = examineAffinityHeaders(["toString"], { toString: "agent:a:chat-7" });
  assert.deepEqual(present.verdict, { kind: "accepted" });
  // ...and an explicit `undefined` own-property is still ABSENT, not a refusal.
  const [explicit] = examineAffinityHeaders(["session_id"], { session_id: undefined });
  assert.deepEqual(explicit.verdict, { kind: "absent" });
});

// ── S4 (infra#327 part (iii)): the uuid relaxation, at the classifier ───────
//
// AC-4 is a SECURITY property, not a convenience: the relaxation must be
// strictly NARROWER than `chatSessionIdSchema`. A uuid is a valid chat session
// id by that schema (`/^[A-Za-z0-9_-]+$/`), so a matcher that merely deferred
// to the schema would accept arbitrary caller junk as a tenant routing key.
// The arms below prove the narrowness is proper and non-trivial: the uuid is
// inside both sets, and a population of values is inside the schema and
// outside the matcher.

/** `chatSessionIdSchema`, restated so the narrowness claim is checkable here. */
const CHAT_SESSION_ID_SCHEMA = /^[A-Za-z0-9_-]{1,200}$/;

const MEASURED_HOST_SESSION_UUID = "b66bdf67-0f4d-46d8-8051-4c9251fdde62";

/**
 * STRUCTURALLY DISTINCT host-session uuids -- finding F-V1, closed on BOTH
 * projections of the classifier rather than only on `resolveConversation`.
 *
 * The suite held exactly one uuid literal, so a constant-returning
 * implementation was indistinguishable from a correct one. Verbatim-ness across
 * distinct values is the property `apps/cell`'s alias table depends on, and the
 * list doubles as the only arm the deliberately unconstrained version and
 * variant nibbles have.
 */
const HOST_SESSION_UUIDS = [
  MEASURED_HOST_SESSION_UUID,                 // v4, variant 8 -- the measured one
  "00000000-0000-0000-0000-000000000000",     // the nil uuid, admitted on purpose
  "ffffffff-ffff-ffff-ffff-ffffffffffff",     // every nibble f
  "0c4fbf75-1234-1abc-0def-0123456789ab",     // version nibble 1, variant nibble 0
  "9a8b7c6d-5e4f-7a3b-c2d1-e0f918273645",     // version nibble 7, variant nibble c
  "deadbeef-0000-9999-ffff-012345678900",     // mixed, trailing zeroes
] as const;

test("S4 AC-4: every host-session uuid shape is accepted and yielded VERBATIM", () => {
  // Kill: revert the relaxation -> red. Kill: return a constant instead of
  // `key` -> red on every member but the first (finding F-V1; a single
  // exemplar could not see this).
  assert.equal(new Set(HOST_SESSION_UUIDS).size, HOST_SESSION_UUIDS.length, "the population must be distinct");
  assert.ok(HOST_SESSION_UUIDS.length >= 3);
  for (const uuid of HOST_SESSION_UUIDS) {
    const got = examineAgentSessionKey(uuid);
    assert.deepEqual(got.verdict, { kind: "accepted" }, `not accepted: ${uuid}`);
    assert.equal(got.chatSessionId, uuid, `not verbatim: ${uuid}`);
    // Verbatim through the projection too, because the cell's alias table is
    // keyed by the exact string the host returned from `sessions.describe`.
    assert.equal(chatSessionFromAgentSessionKey(uuid), uuid, `projection not verbatim: ${uuid}`);
  }
  // The version and variant nibbles are NOT constrained, and that is a
  // decision rather than an oversight: the cell never interprets this value,
  // it only looks it up. Stated as an arm so the next reader finds the reason
  // instead of "tightening" it and fail-closing on real host uuids.
  const versions = new Set(HOST_SESSION_UUIDS.map((u) => u[14]));
  assert.ok(versions.size >= 3, `the population must exercise several version nibbles, got ${[...versions].join(",")}`);
  const variants = new Set(HOST_SESSION_UUIDS.map((u) => u[19]));
  assert.ok(variants.size >= 3, `the population must exercise several variant nibbles, got ${[...variants].join(",")}`);
});

test("S4 AC-4: the uuid matcher is STRICTLY NARROWER than chatSessionIdSchema", () => {
  // THE AC-4 ARM. Every value below is ADMITTED by `chatSessionIdSchema` and
  // MUST STILL BE REFUSED. The first assertion in the loop is what makes this
  // a narrowness proof rather than a list of refusals: if a sample stopped
  // being schema-legal the arm would fail rather than quietly weaken.
  //
  // Kill: widen the matcher to `[A-Za-z0-9_-]+` -> every case goes red.
  const inSchemaButNotAUuid = [
    "not-a-uuid-just-words",
    "chat-7",
    "default",
    // uuid-ish near misses, all schema-legal
    "B66BDF67-0F4D-46D8-8051-4C9251FDDE62",            // upper case
    "b66bdf670f4d46d880514c9251fdde62",                 // hyphens stripped
    "b66bdf67-0f4d-46d8-8051-4c9251fdde6",              // last group 11
    "b66bdf67-0f4d-46d8-8051-4c9251fdde623",            // last group 13
    "b66bdf67-0f4d-46d8-8051-4c9251fdde62-b66bdf67",    // suffixed
    "zz6bdf67-0f4d-46d8-8051-4c9251fdde62",             // non-hex
    "b66bdf6-70f4d-46d8-8051-4c9251fdde62",             // regrouped
    "_66bdf67-0f4d-46d8-8051-4c9251fdde62",             // underscore for hex
  ];
  for (const value of inSchemaButNotAUuid) {
    assert.equal(
      CHAT_SESSION_ID_SCHEMA.test(value),
      true,
      `sample is not schema-legal, so it proves no narrowness: ${JSON.stringify(value)}`,
    );
    const got = examineAgentSessionKey(value);
    assert.equal(
      got.chatSessionId,
      undefined,
      `accepted a schema-legal non-uuid as a routing key: ${JSON.stringify(value)}`,
    );
    assert.equal(got.verdict.kind, "refused");
  }
  // ...and the narrowing is PROPER: the uuid is in both sets.
  assert.equal(CHAT_SESSION_ID_SCHEMA.test(MEASURED_HOST_SESSION_UUID), true);
  assert.equal(examineAgentSessionKey(MEASURED_HOST_SESSION_UUID).chatSessionId, MEASURED_HOST_SESSION_UUID);
});

test("S4 AC-4: an UPPER-CASE uuid is refused, not case-folded", () => {
  // Folding the case would be worse than refusing it. The host writes these
  // lower-cased into `sessions.json` and the cell's alias map is keyed by that
  // exact string, so an upper-case value that we accepted and did not fold
  // would produce a `bound: true` log line over a `tenant_unavailable` answer
  // -- the false green the original refusal existed to prevent. Folding it
  // instead would fabricate an identifier the host never issued.
  //
  // Kill: add the `i` flag to the uuid matcher -> red.
  const upper = MEASURED_HOST_SESSION_UUID.toUpperCase();
  const got = examineAgentSessionKey(upper);
  assert.equal(got.chatSessionId, undefined);
  assert.equal(got.verdict.kind, "refused");
});

test("S4 AC-4: a uuid wrapped in an agent session key still unwraps to the tail", () => {
  // The two accepted shapes do not interfere. A keyed run whose chat session
  // id happens to be uuid-shaped unwraps, it does not get taken whole.
  const got = examineAgentSessionKey(`agent:boekhouder:${MEASURED_HOST_SESSION_UUID}`);
  assert.deepEqual(got.verdict, { kind: "accepted" });
  assert.equal(got.chatSessionId, MEASURED_HOST_SESSION_UUID);
});

test("S4 AC-4: a uuid with surrounding whitespace is trimmed, then accepted", () => {
  // `normaliseChatSessionId` runs before the matcher, so the anchored pattern
  // sees a trimmed value. Pinned because an unanchored matcher would accept
  // `prefix <uuid> suffix`, which is a different and much wider rule.
  assert.equal(examineAgentSessionKey(`  ${MEASURED_HOST_SESSION_UUID}  `).chatSessionId, MEASURED_HOST_SESSION_UUID);
  for (const value of [
    `junk ${MEASURED_HOST_SESSION_UUID}`,
    `${MEASURED_HOST_SESSION_UUID} junk`,
    `${MEASURED_HOST_SESSION_UUID},${MEASURED_HOST_SESSION_UUID}`,
  ]) {
    assert.equal(
      examineAgentSessionKey(value).chatSessionId,
      undefined,
      `unanchored match accepted: ${JSON.stringify(value)}`,
    );
  }
});

test("S4: the summary reports an accepted uuid as accepted, and never prints it", () => {
  // The S1 report and the S4 routing decision are projections of one
  // classifier and must not drift: a value that routes must not be reported
  // refused. And the uuid is an identifier, so it stays out of the line.
  const names = ["session_id", "x-client-request-id", "x-session-affinity"];
  const line = affinityExaminationSummary(examineAffinityHeaders(names, {
    "session_id": MEASURED_HOST_SESSION_UUID,
    "x-client-request-id": "not-a-uuid-just-words",
  }));
  assert.match(line, /"session_id"=accepted/);
  assert.match(line, /"x-client-request-id"=present-but-refused\(not-an-agent-session-key\)/);
  assert.match(line, /"x-session-affinity"=ABSENT/);
  assert.match(line, /1 accepted, 1 present-but-refused, 1 ABSENT/);
  assert.equal(line.includes(MEASURED_HOST_SESSION_UUID), false, `the uuid reached the line: ${line}`);
  assert.equal(line.includes("b66bdf67"), false, `a fragment of the uuid reached the line: ${line}`);
});
