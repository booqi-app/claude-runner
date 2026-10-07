/**
 * Compile-time check: every option name the bridge sets exists on the Agent
 * SDK's `Options` type.
 *
 * This file is never executed and never imported by the runtime. It exists
 * only so that `tsc` reads it against the real, installed SDK -- which is the
 * one thing the hermetic unit suite cannot do. `buildQueryOptions` returns
 * `Record<string, any>`, so without this a misspelt or invented option name
 * compiles, passes every behavioural test, and is discarded by the SDK.
 *
 * That is not hypothetical: the bridge used to set `appendSystemPrompt` and
 * the prompt was silently discarded for as long as it did. booqi-app/infra#202
 * replaced it with the real `systemPrompt` option, so
 * KNOWN_NON_SDK_OPTION_NAMES is now EMPTY -- the intended state.
 *
 * Note the limit of what a NAME check proves. `appendSystemPrompt` is still
 * not an `Options` key on @anthropic-ai/claude-agent-sdk@0.3.263, so this file
 * would still catch it -- but what the key DOES when discarded changed between
 * versions (0.2.92 then sent `systemPrompt: ""`; 0.3.263 leaves the preset
 * intact), and a legal name can be legal and still unusable:
 * `{ type: "preset", preset: "claude_code", append }` typechecks and is billed
 * as a third-party app. booqi-app/infra#333 therefore stopped relying on any
 * append-shaped option rather than listing one here.
 * The second assertion below is what keeps it honest: an entry there that the
 * SDK *does* accept is a compile error, so a listed name cannot outlive the
 * defect it records.
 *
 * Note the scope: this checks option NAMES, never value types. The options
 * object is a `Record<string, any>`, so nothing here verifies that e.g.
 * `tools` is given a `string[]`.
 */

import type { Options } from "@anthropic-ai/claude-agent-sdk";

import { KNOWN_NON_SDK_OPTION_NAMES, SDK_OPTION_NAMES } from "../src/bridge-config.ts";

/**
 * `true` when every name in SDK_OPTION_NAMES is an `Options` key. Otherwise a
 * tuple, so the compile error names the offending key instead of saying
 * "not assignable to never".
 */
type EveryNameIsAnSdkOption =
  Exclude<(typeof SDK_OPTION_NAMES)[number], keyof Options> extends never
    ? true
    : ["not an SDK Options key:", Exclude<(typeof SDK_OPTION_NAMES)[number], keyof Options>];

/** The reverse: a known-broken name that the SDK turns out to accept. */
type EveryKnownDefectIsStillADefect =
  Extract<(typeof KNOWN_NON_SDK_OPTION_NAMES)[number], keyof Options> extends never
    ? true
    : ["this IS an SDK Options key; move it to SDK_OPTION_NAMES:", Extract<(typeof KNOWN_NON_SDK_OPTION_NAMES)[number], keyof Options>];

// These two lines are the check. Deleting either disables it.
export const everyNameIsAnSdkOption: EveryNameIsAnSdkOption = true;
export const everyKnownDefectIsStillADefect: EveryKnownDefectIsStillADefect = true;
