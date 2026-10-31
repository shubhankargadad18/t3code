import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

import {
  parseTimestampMs,
  tokenCount,
  totalTokens,
  type ProviderUsageReader,
  type TranscriptUsageFormat,
  type UsageRecord,
} from "@t3tools/provider-core/server/usage";
import * as HostProcess from "@t3tools/shared/HostProcess";

import type { AcpRegistrySettings } from "../settings.ts";

const CommandCodeScanState = Schema.Struct({
  sessionId: Schema.mutableKey(Schema.String),
  model: Schema.mutableKey(Schema.String),
});

const Usage = Schema.Struct({
  inputTokens: Schema.optional(Schema.Unknown),
  outputTokens: Schema.optional(Schema.Unknown),
  cacheReadTokens: Schema.optional(Schema.Unknown),
  cacheWriteTokens: Schema.optional(Schema.Unknown),
  costUsd: Schema.optional(Schema.Unknown),
});

const Entry = Schema.Union([
  Schema.Struct({ type: Schema.Literal("session"), id: Schema.NonEmptyString }),
  Schema.Struct({ type: Schema.Literal("model_change"), model: Schema.NonEmptyString }),
  Schema.Struct({
    type: Schema.Literal("message"),
    id: Schema.optional(Schema.NonEmptyString),
    timestamp: Schema.String,
    model: Schema.optional(Schema.NonEmptyString),
    usage: Usage,
  }),
]);
const decodeEntry = Schema.decodeUnknownOption(Entry);

// A local command is Command Code when its executable or package directory says so.
// Matching is on path segments so the wrapper T3 users write for `cmd acp` is recognized.
const COMMAND_CODE_EXECUTABLE =
  /(?:^|[\\/])(?:cmd|command-code|commandcode)(?:-acp)?(?:\.(?:mjs|cjs|js|sh|cmd|exe))?$/i;
const COMMAND_CODE_PACKAGE = /(?:^|[\\/])\.?command[-_]?code[\\/]/i;

export function isCommandCodeInstance(config: AcpRegistrySettings): boolean {
  for (const candidate of [config.commandPath, config.agentId, ...config.commandArgs]) {
    const value = candidate.trim();
    if (value.length === 0) continue;
    if (COMMAND_CODE_EXECUTABLE.test(value) || COMMAND_CODE_PACKAGE.test(value)) return true;
  }
  return false;
}

function parseRecord(
  parsed: unknown,
  state: typeof CommandCodeScanState.Type,
): readonly UsageRecord[] {
  const decoded = decodeEntry(parsed);
  if (Option.isNone(decoded)) return [];
  const entry = decoded.value;
  if (entry.type === "session") {
    state.sessionId = entry.id;
    return [];
  }
  if (entry.type === "model_change") {
    state.model = entry.model;
    return [];
  }
  const timestampMs = parseTimestampMs(entry.timestamp);
  if (timestampMs === null) return [];
  const model = entry.model ?? state.model;
  if (model.length === 0) return [];
  const usage = entry.usage;
  const inputTokens = tokenCount(usage.inputTokens);
  const cachedInputTokens = Math.min(inputTokens, tokenCount(usage.cacheReadTokens));
  const cacheCreationTokens = Math.min(
    inputTokens - cachedInputTokens,
    tokenCount(usage.cacheWriteTokens),
  );
  const outputTokens = tokenCount(usage.outputTokens);
  const totals = {
    // Command Code reports inputTokens inclusive of cache reads and writes.
    uncachedInputTokens: inputTokens - cachedInputTokens - cacheCreationTokens,
    cachedInputTokens,
    cacheCreationTokens,
    outputTokens,
    reasoningTokens: 0,
  };
  // Zero cost means the provider priced the turn at nothing, not that it reported a cost.
  const cost = usage.costUsd;
  const reportedCostUsd =
    typeof cost === "number" && Number.isFinite(cost) && cost > 0 ? cost : null;
  if (totalTokens(totals) === 0 && reportedCostUsd === null) return [];
  return [
    {
      provider: "commandcode",
      timestampMs,
      model,
      rateModel: model,
      sessionId: state.sessionId,
      totals,
      reportedCostUsd,
      speed: "standard",
      // Branches repeat parent entries with the same id, so the parent id alone is not unique.
      dedupeKey: JSON.stringify([
        "commandcode",
        state.sessionId,
        entry.id ?? null,
        entry.timestamp,
        model,
      ]),
    },
  ];
}

export const commandCodeUsageFormat: TranscriptUsageFormat<typeof CommandCodeScanState.Type> = {
  selectFields: {
    type: true,
    id: true,
    timestamp: true,
    model: true,
    usage: {
      inputTokens: true,
      outputTokens: true,
      cacheReadTokens: true,
      cacheWriteTokens: true,
      costUsd: true,
    },
  },
  usageMarkers: ['"usage"', '"session"', '"model_change"'],
  parseLine: (line, state) => {
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      return [];
    }
    return parseRecord(parsed, state);
  },
  parseProjected: parseRecord,
  state: { initial: () => ({ sessionId: "", model: "" }), schema: CommandCodeScanState },
};

export const commandCodeUsageReader: ProviderUsageReader<AcpRegistrySettings, Path.Path> = {
  kind: "transcripts",
  provider: "commandcode",
  format: commandCodeUsageFormat,
  directories: Effect.fn("commandCodeUsageReader.directories")(function* ({ config }) {
    if (config === undefined || !isCommandCodeInstance(config)) return [];
    const path = yield* Path.Path;
    const home = yield* HostProcess.HomeDirectory;
    return [{ dir: path.resolve(home, ".commandcode", "projects") }];
  }),
};
