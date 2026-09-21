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
  buildBridgeOptions,
  buildQueryOptions,
  droppedMcpServersMessage,
  COMPACT_SUMMARY_HEADING,
  DEFAULT_SYSTEM_PROMPT_MODE,
  isUnknownSystemPromptMode,
  normaliseSystemPromptMode,
  KNOWN_NON_SDK_OPTIONS,
  KNOWN_NON_SDK_OPTION_NAMES,
  readMcpServers,
  resolveSystemPrompt,
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
    "claude-opus-4-6", undefined, "resume-9", "new-1", baseConfig(), new AbortController(),
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
    "claude-opus-4-6", "you are a bookkeeper", undefined, "session-1", baseConfig(), new AbortController(),
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
      "claude-opus-4-6", "P", undefined, "session-1", config, new AbortController(),
    );
    assert.equal(opts.systemPrompt, "P");
  }
});

test("systemPromptMode append is still available and sends the preset form", () => {
  const opts = buildQueryOptions(
    "claude-opus-4-6", "P", undefined, "session-1",
    baseConfig({ systemPromptMode: "append" }), new AbortController(),
  );

  assert.deepEqual(opts.systemPrompt, { type: "preset", preset: "claude_code", append: "P" });
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
      baseConfig({ systemPromptMode: bad as any }), new AbortController(),
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
    "claude-opus-4-6", "", undefined, "session-1", baseConfig(), new AbortController(),
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

  // The exact shape of the reverted bug: a system prompt gated on there being
  // no resume id.
  assert.equal(
    /if\s*\(\s*!\s*resumeSessionId\s*\)/.test(bridge), false,
    "claude-bridge.ts gates something on `!resumeSessionId` again -- if that is the system prompt, "
      + "every resumed turn runs with an empty one (booqi-app/infra#202)",
  );
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
  // product decision with a consequence an operator has to know about -- under
  // "replace" a session has no memory loading and no date. That must live
  // somewhere an operator reads, not only in a source comment.
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
