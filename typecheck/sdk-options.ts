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

/* -------------------------------------------------------------------------
 * System-prompt handling, asserted explicitly (booqi-app/infra#333).
 *
 * The two checks above are about the NAMES the bridge happens to set today.
 * They did not, and could not, catch infra#333: the bridge's system-prompt
 * handling was WRITTEN against @anthropic-ai/claude-agent-sdk@0.2.92 while the
 * cell image installed 0.3.263, and CI typechecked against 0.2.92, so no job
 * in this repository ever read the type the product actually runs on. The
 * manifest now pins 0.3.263 exactly and CI installs from the lockfile, so
 * `tsc` reads the real one -- and the assertions below are the tripwires that
 * turn the next change in this area into a RED BUILD instead of a silent
 * inversion of meaning.
 *
 * WHAT THESE PROVE
 *
 *   - that `appendSystemPrompt` is still not an `Options` key, so passing it
 *     is still a discard rather than a supported append (A);
 *   - that no OTHER append-shaped system-prompt key appeared on `Options`
 *     under a different spelling, which is the way the next version of this
 *     defect would arrive (B);
 *   - that `systemPrompt` still accepts the bare `string` the bridge sets in
 *     `"replace"` mode (C);
 *   - that `systemPrompt` is still OPTIONAL, which is the whole of `"append"`
 *     mode: it sets no system-prompt option at all and delivers the prompt as
 *     first-turn content (D);
 *   - that the preset-with-append object form still typechecks (E) -- asserted
 *     as a fact, not as a recommendation, precisely because it typechecks and
 *     is nonetheless unusable.
 *
 * WHAT THESE DO NOT PROVE, AND CANNOT
 *
 * Nothing here says anything about BILLING. `{ type: "preset", preset:
 * "claude_code", append }` and a bare `systemPrompt` string are both perfectly
 * well-typed and both replace the Claude Code preset, which is what makes
 * Anthropic answer `400 Third-party apps now draw from your extra usage, not
 * your plan limits.` That is a property of the live Anthropic endpoint and is
 * only reproducible against it; no type and no hermetic test can observe it.
 * The measurement table that DID observe it is on
 * `BridgeConfig.systemPromptMode` in `src/bridge-config.ts`, and it stays the
 * authority for what each form COSTS. These assertions only guarantee that the
 * SHAPES that table describes are still the shapes the SDK exposes, so the
 * table cannot go stale behind a green build.
 *
 * Nor do they prove the running image installs this version. The manifest and
 * the lockfile are this repository's declaration; the cell image installs the
 * SDK from `ARG CELL_CLAUDE_AGENT_SDK_VERSION` in `booqi-app/infra`'s
 * `docker/cell/Dockerfile` and does not copy this lockfile at all. Keeping the
 * two in step is an infra-side assertion, not one this file can make.
 * ------------------------------------------------------------------------- */

/** (A) `appendSystemPrompt` is not an `Options` key. */
type AppendSystemPromptIsNotAnOption = "appendSystemPrompt" extends keyof Options
  ? [
      "`appendSystemPrompt` IS an Options key on this SDK. Re-read the billing/delivery table on BridgeConfig.systemPromptMode before using it: a legal name is not evidence the call stays first-party.",
    ]
  : true;

/**
 * (B) `systemPrompt` is the ONLY `Options` key whose name mentions a system
 * prompt. A future SDK that grows `appendSystemPrompt`, `systemPromptSuffix`
 * or any other spelling fails here and names the new key in the error, which
 * forces the decision to be made rather than discovered in production.
 */
type SystemPromptIsTheOnlySuchOption =
  Exclude<Extract<keyof Options, `${string}ystemPrompt${string}`>, "systemPrompt"> extends never
    ? true
    : [
        "a new system-prompt-shaped Options key appeared; decide what it does to billing and to the preset before using it:",
        Exclude<Extract<keyof Options, `${string}ystemPrompt${string}`>, "systemPrompt">,
      ];

/** (C) `"replace"` mode assigns a bare string. */
type SystemPromptAcceptsAString = string extends NonNullable<Options["systemPrompt"]>
  ? true
  : ["Options['systemPrompt'] no longer accepts a bare string, which is what buildQueryOptions assigns"];

/**
 * (D) `"append"` mode sets NO system-prompt key, so the key must stay
 * optional. If the SDK ever makes it required, append mode stops compiling
 * here instead of failing at runtime.
 */
type SystemPromptIsOptional = {} extends Pick<Options, "systemPrompt">
  ? true
  : ["Options['systemPrompt'] is now REQUIRED; append mode sets no system-prompt option at all"];

/**
 * (E) The preset-with-append form still typechecks. Asserted so that the
 * sentence "it typechecks and is billed as a third-party app" stays a
 * verifiable claim about THIS SDK. If this ever goes red the form was removed
 * or reshaped, and the table on `BridgeConfig.systemPromptMode` must be
 * re-measured rather than edited.
 */
type PresetAppendFormStillTypechecks = { type: "preset"; preset: "claude_code"; append: string } extends NonNullable<
  Options["systemPrompt"]
>
  ? true
  : ["the { type: 'preset', preset: 'claude_code', append } form no longer typechecks; re-measure BridgeConfig.systemPromptMode"];

// Five more lines that are the check. Deleting any of them disables it.
export const appendSystemPromptIsNotAnOption: AppendSystemPromptIsNotAnOption = true;
export const systemPromptIsTheOnlySuchOption: SystemPromptIsTheOnlySuchOption = true;
export const systemPromptAcceptsAString: SystemPromptAcceptsAString = true;
export const systemPromptIsOptional: SystemPromptIsOptional = true;
export const presetAppendFormStillTypechecks: PresetAppendFormStillTypechecks = true;
