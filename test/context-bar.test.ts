/**
 * The context status bar is switchable, on BOTH answer paths (booqi-app/infra#363).
 *
 * Every answer used to end with a line like
 *
 *   ░░░░░░░░░░ 0% · Turn 1 · 0.2k / 1000k tokens
 *
 * appended unconditionally by `handleStreamingResponse` (as a final text
 * delta) and by `handleNonStreamingResponse` (onto the result text). In a
 * Booqi cell that line landed under every answer a tenant's user reads.
 *
 * These tests drive the REAL entry point, `handleCompletions`, with a fake
 * Agent SDK `query()` and read what goes over the transport: the SSE chunks of
 * a streaming answer and the JSON body of a non-streaming one. Nothing here
 * asserts on source text. Each arm names the mutant it kills:
 *
 *   M1  re-add the unconditional append on the STREAMING path
 *   M2  re-add the unconditional append on the NON-STREAMING path
 *   M3  drop the bar unconditionally (the positive controls go red)
 *   M4  coerce the key instead of refusing a non-boolean
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import { __testing, startBridgeServer, type QueryFn } from "../src/claude-bridge.ts";
import {
  buildBridgeOptions,
  DEFAULT_CONTEXT_BAR,
  readContextBar,
  type BridgeConfig,
} from "../src/bridge-config.ts";

const baseConfig: BridgeConfig = {
  port: 7779,
  workDir: "/home/agent/.openclaw/workspace",
  skipPermissions: true,
  maxRetries: 0,
  queueMinDelayMs: 0,
  queueMaxDelayMs: 0,
  tools: [],
};

const ANSWER_PARTS = ["Hello", " world"];
const ANSWER = ANSWER_PARTS.join("");

/** The two characters the bar draws with, and the separator it always carries. */
const BAR_GLYPHS = /[█░]/;
const TURN_MARK = " · Turn ";

/**
 * A fake `query()` that answers like the SDK does on each path: token-level
 * text deltas (read only by the streaming handler), then a `result` carrying
 * the full text and the model usage the bar is computed from.
 */
function fakeQuery(): QueryFn {
  return (() => (async function* () {
    for (const text of ANSWER_PARTS) {
      yield {
        type: "stream_event",
        event: { type: "content_block_delta", delta: { type: "text_delta", text } },
      } as any;
    }
    yield {
      type: "result",
      subtype: "success",
      result: ANSWER,
      session_id: "sdk-session-ctx",
      modelUsage: {
        "claude-opus-4-6": {
          inputTokens: 1200,
          outputTokens: 34,
          cacheReadInputTokens: 0,
          cacheCreationInputTokens: 0,
          contextWindow: 1_000_000,
          costUSD: 0,
        },
      },
    } as any;
  })()) as unknown as QueryFn;
}

/** Minimal ServerResponse stand-in: only what the handlers touch. */
function fakeRes() {
  return {
    headersSent: false,
    writableEnded: false,
    statusCode: 0,
    headers: {} as Record<string, unknown>,
    body: "",
    setHeader() {},
    writeHead(status: number, headers?: Record<string, unknown>) {
      this.statusCode = status;
      this.headers = headers ?? {};
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
      this.writableEnded = true;
    },
  } as any;
}

/** A fake IncomingMessage carrying a JSON body, async-iterable like the real one. */
function fakeReq(body: unknown): any {
  const payload = Buffer.from(JSON.stringify(body));
  return {
    headers: {},
    async *[Symbol.asyncIterator]() { yield payload; },
  };
}

type Answer = {
  /** Every text the client receives, concatenated in order. */
  text: string;
  /** How many SSE chunks carried a non-empty text delta (streaming only). */
  textChunks: number;
  /** The machine-readable usage the answer carried, path-independent. */
  usage: unknown;
  context: unknown;
  sawDone: boolean;
};

async function ask(config: BridgeConfig, stream: boolean): Promise<Answer> {
  __testing.initialiseStores(config);
  __testing.setQuery(fakeQuery());
  __testing.setLog(() => {});
  const res = fakeRes();
  try {
    await __testing.handleCompletions(
      fakeReq({
        model: "claude-runner/claude-opus-4-6",
        stream,
        messages: [{ role: "user", content: "what is my VAT position?" }],
      }),
      res,
      config,
    );
  } finally {
    __testing.setQuery(undefined);
    __testing.setLog(undefined);
  }
  assert.equal(res.statusCode, 200, `the request did not succeed: ${res.body}`);
  assert.equal(res.writableEnded, true, "the response was never ended");

  if (!stream) {
    const json = JSON.parse(res.body);
    return {
      text: json.choices[0].message.content,
      textChunks: 0,
      usage: json.usage,
      context: json.context,
      sawDone: false,
    };
  }

  const frames = res.body.split("\n\n").filter((f: string) => f.startsWith("data: "));
  let text = "";
  let textChunks = 0;
  let usage: unknown;
  let context: unknown;
  let sawDone = false;
  for (const frame of frames) {
    const data = frame.slice("data: ".length);
    if (data === "[DONE]") { sawDone = true; continue; }
    const chunk = JSON.parse(data);
    const content = chunk.choices?.[0]?.delta?.content;
    if (typeof content === "string" && content.length > 0) {
      text += content;
      textChunks += 1;
    }
    if (chunk.usage) usage = chunk.usage;
    if (chunk.context) context = chunk.context;
  }
  return { text, textChunks, usage, context, sawDone };
}

const withBar = (v: unknown): BridgeConfig => ({ ...baseConfig, contextBar: v as boolean });
const absentKey: BridgeConfig = { ...baseConfig };

for (const stream of [true, false]) {
  const via = stream ? "streaming" : "non-streaming";

  test(`contextBar: false -> the ${via} answer carries NO bar, and the answer itself is intact`, async () => {
    // Kills M1 (streaming) / M2 (non-streaming): an unconditional append puts
    // the bar back into the text and this equality fails.
    const answer = await ask(withBar(false), stream);
    assert.equal(answer.text, ANSWER, `the ${via} answer is not exactly the model's text`);
    assert.equal(BAR_GLYPHS.test(answer.text), false, `bar glyphs in the ${via} answer: ${JSON.stringify(answer.text)}`);
    assert.equal(answer.text.includes(TURN_MARK), false, `a Turn line in the ${via} answer`);
    if (stream) {
      // One text chunk per SDK delta and not one more: the bar travelled as an
      // EXTRA chunk, so a count is a second reader that does not depend on the
      // bar's spelling.
      assert.equal(answer.textChunks, ANSWER_PARTS.length);
      assert.equal(answer.sawDone, true, "the stream ended without [DONE]");
    }
  });

  test(`contextBar: true -> the ${via} answer ends with the bar (positive control)`, async () => {
    // Kills M3, and proves the reader above can see a bar at all: the same
    // `ask()` and the same predicates find it when it is there.
    const answer = await ask(withBar(true), stream);
    assert.ok(answer.text.startsWith(ANSWER), `the ${via} answer lost the model's text`);
    const tail = answer.text.slice(ANSWER.length);
    assert.ok(BAR_GLYPHS.test(tail), `no bar glyphs after the ${via} answer: ${JSON.stringify(tail)}`);
    assert.ok(tail.includes(TURN_MARK), `no Turn line after the ${via} answer: ${JSON.stringify(tail)}`);
    assert.match(tail, /1\.2k \/ 1000k tokens/, "the bar is not computed from this answer's usage");
    if (stream) assert.equal(answer.textChunks, ANSWER_PARTS.length + 1);
  });

  test(`contextBar absent -> the ${via} answer still ends with the bar (default unchanged)`, async () => {
    // AC-1: other users of the runner see no change unless they write the key.
    const answer = await ask(absentKey, stream);
    const tail = answer.text.slice(ANSWER.length);
    assert.ok(answer.text.startsWith(ANSWER));
    assert.ok(BAR_GLYPHS.test(tail) && tail.includes(TURN_MARK), `default lost the ${via} bar: ${JSON.stringify(tail)}`);
  });

  test(`contextBar: false -> the ${via} usage/context data is unchanged`, async () => {
    // The switch removes text a person reads, not data a client parses.
    const off = await ask(withBar(false), stream);
    const on = await ask(withBar(true), stream);
    assert.ok(off.usage, `no usage on the ${via} answer with the bar off`);
    assert.ok(off.context, `no context on the ${via} answer with the bar off`);
    assert.deepEqual(off.usage, on.usage);
    assert.deepEqual(off.context, on.context);
  });
}

test("config.json -> buildBridgeOptions -> handleCompletions: contextBar false switches the bar off end to end", async () => {
  // The wire from a parsed config.json to the handler, not a hand-built
  // BridgeConfig: dropping `contextBar` from buildBridgeOptions turns this red.
  const fromJson = { ...buildBridgeOptions({ tools: [], contextBar: false, maxRetries: 0 }),
    workDir: baseConfig.workDir, queueMinDelayMs: 0, queueMaxDelayMs: 0 };
  assert.equal(fromJson.contextBar, false);
  for (const stream of [true, false]) {
    const answer = await ask(fromJson, stream);
    assert.equal(answer.text, ANSWER, `bar present via config.json (stream=${stream})`);
  }
});

test("readContextBar: absent means the default, which is ON", () => {
  assert.equal(DEFAULT_CONTEXT_BAR, true);
  assert.equal(readContextBar(undefined), true);
  assert.equal(buildBridgeOptions({ tools: [] }).contextBar, true);
});

test("readContextBar: booleans are returned as given", () => {
  assert.equal(readContextBar(true), true);
  assert.equal(readContextBar(false), false);
});

for (const bad of ["off", "false", "on", 0, 1, null, {}, []]) {
  test(`readContextBar: ${JSON.stringify(bad)} is REFUSED, not coerced (M4)`, () => {
    assert.throws(() => readContextBar(bad), /"contextBar"/);
    assert.throws(() => buildBridgeOptions({ tools: [], contextBar: bad }), /"contextBar"/);
  });
}

test("startBridgeServer refuses an unusable contextBar before binding a socket", () => {
  // Synchronous throw: no Promise, so no listener was ever created.
  assert.throws(
    () => startBridgeServer({ ...baseConfig, port: 0, contextBar: "off" as unknown as boolean }),
    /"contextBar"/,
  );
});
