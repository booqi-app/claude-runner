# openclaw-claude-runner

OpenClaw extension that routes LLM requests through the [Claude Agent SDK](https://www.npmjs.com/package/@anthropic-ai/claude-agent-sdk) instead of API calls.

Instead of paying per-token via the Anthropic API, this uses the Agent SDK with your Max plan subscription — giving you full agentic capabilities (tool use, file editing, multi-step reasoning, MCP servers, memory) at flat-rate pricing.

## How it works

```
Request → OpenClaw Gateway → claude-runner provider
  → bridge server (OpenAI-compat on localhost:7779)
    → SDK query() with session resume
      → SDKMessage stream → SSE translation → back to OpenClaw

Discord context overlay (separate process):
  → watches bot messages → fetches bridge sessions API
    → edits message to append context fill embed
```

The extension registers as an OpenClaw LLM provider. When the gateway sends a chat completion request, the bridge invokes the Claude Agent SDK's `query()` function and translates the streaming messages back into OpenAI-compatible SSE chunks.

### Session continuity

The bridge derives a stable session ID from the conversation's first user message. On subsequent messages in the same conversation, the SDK resumes the session — maintaining full context including tool use history, file edits, and reasoning chains.

### Context tracking & auto-compaction

The bridge tracks token usage per session from SDK result messages. When context fill reaches 75%, the session automatically rotates — a summary is injected into the next request's system prompt so the conversation continues seamlessly with a fresh context window.

## Prerequisites

- [OpenClaw](https://github.com/openclaw/openclaw) installed and running
- [Claude Code CLI](https://docs.anthropic.com/en/docs/claude-code) installed and authenticated (`claude login`)
- Anthropic Max subscription

## Install

```bash
git clone https://github.com/siimvene/openclaw-claude-runner.git
cd openclaw-claude-runner
bash install.sh
```

The install script:
- Copies the extension to `~/.openclaw/extensions/claude-runner/`
- Runs `npm install` for the Agent SDK dependency
- Enables the plugin via `openclaw plugins enable`
- Registers the provider via `openclaw config set`
- Creates a default `config.json` if one doesn't exist
- Installs the Discord context overlay (if Discord token found in OpenClaw config)
- Creates a systemd service for the overlay

After install:

```bash
# 1. Authenticate Claude Code CLI (if not already done)
claude login

# 2. Restart the gateway to pick up the extension
openclaw gateway restart

# 3. Start the context overlay (if installed)
systemctl --user start openclaw-context-overlay
```

## Configuration

Extension settings are in `~/.openclaw/extensions/claude-runner/config.json`:

| Option | Default | Description |
|---|---|---|
| `port` | `7779` | Port for the local bridge server |
| `skipPermissions` | `true` | Use `bypassPermissions` mode |
| `maxTurns` | `30` | Max agentic turns per request |
| `defaultModel` | `"claude-opus-4-6"` | Default model when none specified |
| `workDir` | — | **Ignored.** The bridge takes its working directory from the OpenClaw workspace it is started in. The key is still accepted so that an existing `config.json` carrying it is not refused. |
| `queueMinDelayMs` | `1000` | Min delay between SDK queries (ms) |
| `queueMaxDelayMs` | `4000` | Max delay between SDK queries (ms) |
| `queueMaxConcurrency` | `1` | Max concurrent SDK queries |
| `sessionTtlMs` | `3600000` | Session cache TTL (ms) |
| `maxRetries` | `2` | How many times a transient SDK failure is retried before the request fails |
| `effort` | `"medium"` | Effort level: low, medium, high, max |
| `maxBudgetUsd` | — | Cost cap per request (optional) |
| `tools` | — | Restrict available tools (optional) |
| `mcpServers` | — | MCP servers handed to the SDK session as `mcpServers` in the query options. Keyed by server name; each value is a transport object the Agent SDK understands, e.g. `{"booqi": {"type": "http", "url": "http://127.0.0.1:3010/mcp"}}`. Tool names derive from the key (`mcp__<name>__<tool>`). **This value MUST NOT carry a credential:** the SDK serialises the whole map onto the `claude` subprocess command line as `--mcp-config`, where it is readable in `ps` and `/proc/<pid>/cmdline`. |
| `strictMcpConfig` | `true` | Use only the servers in `mcpServers`, ignoring MCP configuration the SDK would otherwise discover on the filesystem (a `.mcp.json` in the working directory, user-level MCP settings). Set it to `false` for the SDK's own default. **This is a change from earlier versions of this fork**, which left the SDK to discover whatever it found. Two things to know before leaving it on: with no `mcpServers` configured the session then has no MCP server at all, and on a host carrying an **enterprise-managed MCP configuration** the `claude` subprocess refuses to start while this is enabled — set it to `false` there. |

To set as default model (optional):

```bash
openclaw config set agents.defaults.model.primary "claude-runner/claude-opus-4-6"
openclaw config set agents.defaults.model.fallbacks '["anthropic/claude-opus-4-5"]'
```

## Available models

| Model ID | Description |
|---|---|
| `claude-runner/claude-opus-4-6` | Claude Opus 4.6 via SDK |
| `claude-runner/claude-opus-4-5` | Claude Opus 4.5 via SDK |
| `claude-runner/claude-sonnet-4-6` | Claude Sonnet 4.6 via SDK |
| `claude-runner/claude-sonnet-4` | Claude Sonnet 4 via SDK |
| `claude-runner/claude-haiku-4-5` | Claude Haiku 4.5 via SDK |

## Discord context overlay

The overlay is a standalone process that enhances bot messages with a context fill indicator — similar to Claude Code's context window display.

After each bot response, it appends a colored embed footer:

```
████░░░░░░ 38% · Turn 5 · 380.0k / 1000k tokens
```

Colors: green (< 50%), yellow (50-74%), red (75%+).

### Discord commands

| Command | Description |
|---|---|
| `!context` | Show current context fill for all sessions |
| `!compact` | Force session compaction — next message starts fresh |

### Manual overlay setup

If the install script didn't detect a Discord token, or you want to install the overlay separately:

```bash
cd overlay
npm install
export DISCORD_TOKEN="your-bot-token"
export BRIDGE_URL="http://127.0.0.1:7779/v1"  # optional, this is the default
node --import tsx discord-context-overlay.ts
```

Or use the overlay's own install script to create a systemd service:

```bash
cd overlay
bash install.sh
systemctl --user enable --now openclaw-context-overlay
```

## Bridge API

The bridge exposes additional endpoints beyond the OpenAI-compatible chat completions:

| Endpoint | Method | Description |
|---|---|---|
| `/health` | GET | Health check |
| `/v1/models` | GET | List available models |
| `/v1/chat/completions` | POST | Chat completions (OpenAI-compatible) |
| `/v1/sessions` | GET | List all active sessions with context info |
| `/v1/sessions/{id}` | GET | Get session details (context fill, turn count, tokens) |
| `/v1/sessions/{id}/compact` | POST | Force session compaction |

### Session info response

```json
{
  "session_id": "derived-e6f26fa0464d41fa",
  "turn_count": 5,
  "context": {
    "fill_percent": 0.38,
    "fill_percent_display": "38%",
    "context_window": 1000000,
    "input_tokens": 340000,
    "output_tokens": 40000,
    "total_tokens": 380000,
    "cost_usd": 0
  },
  "needs_compaction": false
}
```

## Why use this instead of the Anthropic API directly?

| | API (per-token) | SDK (this extension) |
|---|---|---|
| **Billing** | Pay per token | Max plan flat rate |
| **Capabilities** | Chat completions only | Full Claude Code: tool use, file editing, MCP, memory |
| **Reasoning** | Single-turn | Multi-step agentic loops |
| **Tool handling** | Build your own | Delegated to SDK |
| **Session continuity** | Stateless | Resume across messages |
| **Context management** | Manual | Auto-tracked with compaction |

## Troubleshooting

**"Invalid API key" or "Please run /login"**

Claude CLI is not authenticated. Run `claude login` on the server.

**"No API key found for provider claude-runner"**

OpenClaw requires an auth profile even though the SDK authenticates via your Claude Code login. The install script creates this automatically, but if you see this error, add it manually:

```bash
# For the main agent
mkdir -p ~/.openclaw/agents/main/agent
echo '{"version":1,"profiles":{"claude-runner:default":{"type":"api_key","provider":"claude-runner","key":"claude-runner-local"}}}' > ~/.openclaw/agents/main/agent/auth-profiles.json
```

If you have multiple agents, copy the profile to each agent's directory or merge it into the existing `auth-profiles.json`.

**Bridge not responding**

Check if the bridge is running: `curl http://127.0.0.1:7779/health`

If not, check gateway logs: `journalctl --user -u openclaw-gateway -n 50`

**Context overlay not showing embeds**

Check the overlay is running: `systemctl --user status openclaw-context-overlay`

Check logs: `journalctl --user -u openclaw-context-overlay -f`

Verify the bridge has session data: `curl http://127.0.0.1:7779/v1/sessions`

## License

MIT

## Known limitations

- **The system prompt a caller sends does not reach the model.** The bridge passes it to the Agent SDK as `appendSystemPrompt`, which is not an SDK query option — it exists only on the SDK's internal control-protocol message, which the SDK derives from `systemPrompt`. Measured against `@anthropic-ai/claude-agent-sdk@0.2.92`: the key is discarded, `systemPrompt` is then sent as `""`, and the CLI treats that as falsy and falls back to its own default prompt. So a session runs on the Claude Code default system prompt, not on the one the agent was configured with. This predates the Booqi fork. Fixing it carries a product decision — whether to keep the Claude Code default and append to it, or to replace it — and a second change to the resume path, which only sends a system prompt on the first turn. Tracked in [booqi-app/infra#202](https://github.com/booqi-app/infra/issues/202); the name is listed in `KNOWN_NON_SDK_OPTIONS` in `src/bridge-config.ts`, and a compile-time check will fail if the SDK ever starts accepting it.

## Relationship to upstream

This is a patch fork of [`siimvene/openclaw-claude-runner`](https://github.com/siimvene/openclaw-claude-runner). The fork point is `6286a07`; every commit up to and including it is upstream's.

Files that are Booqi-only, and therefore the ones a rebase onto upstream will have to carry rather than merge:

- `src/bridge-config.ts` — `BridgeConfig`, `buildBridgeOptions()`, `readMcpServers()` and `buildQueryOptions()`. **`buildQueryOptions()` was moved out of `src/claude-bridge.ts`**, so an upstream change to it will land as a conflict in a file that no longer contains it. That is the known cost of making the SDK query options testable without the SDK installed.
- `test/`, `typecheck/`, `tsconfig.json` and `.github/workflows/ci.yml` — none of them exist upstream.

### Running the checks locally

`npm test` needs nothing installed: the suite imports only `src/bridge-config.ts`, which imports nothing, and Node strips the types as it runs.

The option-name check is the exception. `typecheck/sdk-options.ts` asserts that every option name the bridge hands to the SDK is a real key of the SDK's `Options` type, so it needs the SDK present and runs only under the typecheck job:

```
npm install --no-save typescript@5 @types/node@24 @anthropic-ai/claude-agent-sdk@0.2.92
npx tsc --noEmit -p tsconfig.json
```

A wrong option name is therefore invisible to `npm test` and fails in CI.
