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
  readMcpServers,
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

test("a server named __proto__ becomes an own key and hijacks no prototype", () => {
  // JSON.parse produces an own "__proto__" key, so this is reachable from a
  // config file. A plain out[name] = value would replace the prototype of the
  // returned map instead of adding a key: the server would vanish and its
  // contents would be inherited by the object handed to the SDK.
  const raw = JSON.parse(
    '{"__proto__":{"type":"http","url":"http://127.0.0.1:3010/mcp"},"ok":{"type":"http"}}',
  );
  const read = readMcpServers(raw)!;

  assert.deepEqual(Object.keys(read).sort(), ["__proto__", "ok"]);
  assert.equal(Object.getPrototypeOf(read), Object.prototype);
  assert.equal((read as any).url, undefined);
  assert.equal(({} as any).url, undefined, "Object.prototype was polluted");
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
      + '"queueMaxDelayMs":4,"queueMaxConcurrency":5,"sessionTtlMs":6,"tools":["T"],'
      + '"strictMcpConfig":false,"effort":"high","maxBudgetUsd":7}'),
  );

  assert.deepEqual(opts, {
    port: 1,
    skipPermissions: false,
    maxTurns: 2,
    queueMinDelayMs: 3,
    queueMaxDelayMs: 4,
    queueMaxConcurrency: 5,
    sessionTtlMs: 6,
    tools: ["T"],
    mcpServers: undefined,
    strictMcpConfig: false,
    effort: "high",
    maxBudgetUsd: 7,
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

  const calls = bridge.match(/\bquery\s*\(/g) ?? [];
  const wellFormed = bridge.match(/\bquery\s*\(\s*\{\s*prompt\s*,\s*options\s*,?\s*\}\s*,?\s*\)/g) ?? [];
  const built = bridge.match(/=\s*buildQueryOptions\s*\(/g) ?? [];

  assert.ok(calls.length > 0, "found no query() call in claude-bridge.ts");
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
