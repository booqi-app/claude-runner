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
 * That is not hypothetical: `appendSystemPrompt` lived here for the life of
 * the fork and is not an `Options` key at all.
 */

import type { Options } from "@anthropic-ai/claude-agent-sdk";

import { SDK_OPTION_NAMES } from "../src/bridge-config.ts";

type SetOptionName = (typeof SDK_OPTION_NAMES)[number];

/**
 * Resolves to `never` for any name that is not an `Options` key, so the
 * assignment below fails to compile and names the offending key.
 */
type NotAnSdkOption = Exclude<SetOptionName, keyof Options>;

const everyNameIsAnSdkOption: NotAnSdkOption[] = [];

// Referenced so the binding is not unused; the check is the type above.
export const sdkOptionNameCheck: readonly never[] = everyNameIsAnSdkOption;
