/**
 * Unit tests for the `mcpServers` passthrough.
 *
 * What these prove: a value named `mcpServers` in cell configuration reaches
 * the options object the bridge hands to the Agent SDK's `query()`, unchanged.
 * That is the only path by which the SDK session of a cell learns about the
 * Tool API MCP server its gateway serves on the container loopback -- a
 * `.mcp.json` in the workspace is explicitly not relied on.
 *
 * These are deliberately hermetic: `src/bridge-config.ts` imports nothing, so
 * the assertions need neither the SDK installed nor a listening bridge.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import {
  buildQueryOptions,
  readMcpServers,
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

test("an unknown transport shape is passed through, not narrowed away", () => {
  // The SDK owns transport validation. If this repository starts filtering
  // keys it does not recognise, every new SDK transport becomes a patch here.
  const stdio = { booqi: { command: "/usr/bin/tool-api", args: ["--stdio"] } };
  const opts = optionsFor(baseConfig({ mcpServers: stdio }));

  assert.deepEqual(opts.mcpServers, stdio);
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

test("readMcpServers reads a value parsed from a config.json", () => {
  // The production path is loadExtensionConfig() -> JSON.parse -> this reader.
  const parsed = JSON.parse(
    '{"port":7779,"mcpServers":{"booqi":{"type":"http","url":"http://127.0.0.1:3010/mcp"}}}',
  );

  assert.deepEqual(readMcpServers(parsed.mcpServers), CELL_MCP_SERVERS);
});

// ── The rest of the options object is unaffected ────────────────────

test("the existing options are unchanged by the new key", () => {
  const opts = optionsFor(
    baseConfig({ tools: ["mcp__booqi__open_invoices"], maxTurns: 12, effort: "medium" }),
  );

  assert.equal(opts.model, "claude-opus-4-6");
  assert.equal(opts.cwd, "/home/agent/.openclaw/workspace");
  assert.equal(opts.maxTurns, 12);
  assert.equal(opts.includePartialMessages, true);
  assert.equal(opts.permissionMode, "bypassPermissions");
  assert.equal(opts.sessionId, "session-1");
  assert.deepEqual(opts.tools, ["mcp__booqi__open_invoices"]);
  assert.equal(opts.effort, "medium");
});

test("maxTurns falls back to the default", () => {
  assert.equal(optionsFor(baseConfig()).maxTurns, 30);
});

// ── The options object really is the one query() receives ───────────

test("every query() call in the bridge is given buildQueryOptions output", () => {
  // buildQueryOptions is assertable in isolation; this keeps that isolation
  // honest by checking the transport still routes through it. Without this,
  // a future edit could add a query() call that builds its own options and
  // silently loses mcpServers, with every test above still green.
  const bridge = readFileSync(join(repoRoot, "src", "claude-bridge.ts"), "utf-8");

  const queryCalls = bridge.match(/\bquery\(\{/g) ?? [];
  const builtOptions = bridge.match(/const options = buildQueryOptions\(/g) ?? [];

  assert.ok(queryCalls.length > 0, "found no query() call in claude-bridge.ts");
  assert.equal(
    builtOptions.length,
    queryCalls.length,
    `claude-bridge.ts has ${queryCalls.length} query() call(s) but ${builtOptions.length} buildQueryOptions() call(s)`,
  );
  assert.match(bridge, /query\(\{\s*prompt,\s*options\s*\}\)/);
});

test("claude-bridge.ts defines no second copy of buildQueryOptions", () => {
  const bridge = readFileSync(join(repoRoot, "src", "claude-bridge.ts"), "utf-8");
  assert.equal(/function buildQueryOptions\(/.test(bridge), false);
});

// ── The plugin entry point really passes the value on ───────────────

test("index.ts carries mcpServers from extension config to the bridge", () => {
  // index.ts cannot be imported here: it pulls in `openclaw/plugin-sdk/core`,
  // which only exists inside an OpenClaw install. The plumbing is therefore
  // asserted structurally. Both hops matter -- dropping either one leaves the
  // SDK session without its Tool API server while every behavioural test above
  // stays green.
  const entry = readFileSync(join(repoRoot, "index.ts"), "utf-8");

  assert.match(
    entry,
    /mcpServers:\s*readMcpServers\(extConfig\.mcpServers\)/,
    "index.ts does not read mcpServers out of the extension config",
  );
  assert.match(
    entry,
    /mcpServers:\s*config\.mcpServers/,
    "index.ts does not forward mcpServers to startBridgeServer()",
  );
});

test("the plugin config schema admits mcpServers", () => {
  // configSchema has additionalProperties:false, so an mcpServers value in
  // config.json is refused before it ever reaches readMcpServers unless the
  // schema names it. This is the failure mode that would make every other
  // test here green while a real cell still came up without its Tool API.
  const schema = JSON.parse(readFileSync(join(repoRoot, "openclaw.plugin.json"), "utf-8"));

  assert.equal(schema.configSchema.additionalProperties, false);
  assert.equal(schema.configSchema.properties.mcpServers?.type, "object");
});

test("config.example.json is valid and its mcpServers value is readable", () => {
  const example = JSON.parse(readFileSync(join(repoRoot, "config.example.json"), "utf-8"));

  assert.deepEqual(readMcpServers(example.mcpServers), {
    booqi: { type: "http", url: "http://127.0.0.1:3010/mcp" },
  });
});
