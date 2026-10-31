import * as NodeServices from "@effect/platform-node/NodeServices";
import { ProviderInstanceId } from "@t3tools/contracts";
import * as HostProcess from "@t3tools/shared/HostProcess";
import { it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import { describe, expect } from "vite-plus/test";

import { AcpRegistrySettings } from "../settings.ts";
import {
  commandCodeUsageFormat,
  commandCodeUsageReader,
  isCommandCodeInstance,
} from "./commandCodeUsage.ts";

const decodeSettings = Schema.decodeSync(AcpRegistrySettings);
const initialState = () => commandCodeUsageFormat.state!.initial();

function parse(line: unknown) {
  const state = initialState();
  const records = commandCodeUsageFormat.parseLine(
    typeof line === "string" ? line : JSON.stringify(line),
    state,
  );
  return { records, state };
}

const sessionLine = { type: "session", version: 3, id: "session-1" };

const assistantLine = {
  type: "message",
  id: "message-1",
  parentId: "message-0",
  timestamp: "2026-10-31T18:46:01.989Z",
  model: "deepseek/deepseek-v4.1-flash",
  message: { role: "assistant", content: [] },
  usage: {
    inputTokens: 22_971,
    outputTokens: 9,
    cacheReadTokens: 6_144,
    cacheWriteTokens: 0,
    costUsd: 0.002_547_882,
  },
};

describe("commandCodeUsageFormat", () => {
  it("tracks the session id and model across lines", () => {
    const state = initialState();
    expect(commandCodeUsageFormat.parseLine(JSON.stringify(sessionLine), state)).toEqual([]);
    expect(state.sessionId).toBe("session-1");
    expect(
      commandCodeUsageFormat.parseLine(
        JSON.stringify({ type: "model_change", model: "deepseek/deepseek-v4-pro" }),
        state,
      ),
    ).toEqual([]);
    expect(state.model).toBe("deepseek/deepseek-v4-pro");
  });

  it("splits inclusive input tokens and keeps the reported cost", () => {
    const { records } = parse(assistantLine);
    expect(records).toHaveLength(1);
    const record = records[0]!;
    expect(record.provider).toBe("commandcode");
    expect(record.model).toBe("deepseek/deepseek-v4.1-flash");
    expect(record.rateModel).toBe("deepseek/deepseek-v4.1-flash");
    expect(record.timestampMs).toBe(Date.parse(assistantLine.timestamp));
    expect(record.sessionId).toBe("");
    expect(record.totals).toEqual({
      uncachedInputTokens: 16_827,
      cachedInputTokens: 6_144,
      cacheCreationTokens: 0,
      outputTokens: 9,
      reasoningTokens: 0,
    });
    expect(record.reportedCostUsd).toBe(0.002_547_882);
    expect(record.speed).toBe("standard");
  });

  it("falls back to the last model change and carries the session id", () => {
    const state = initialState();
    commandCodeUsageFormat.parseLine(
      JSON.stringify({ type: "model_change", model: "z-ai/glm-5.3-flash" }),
      state,
    );
    const records = commandCodeUsageFormat.parseLine(
      JSON.stringify({ ...assistantLine, model: undefined }),
      state,
    );
    expect(records[0]?.model).toBe("z-ai/glm-5.3-flash");
  });

  it("subtracts cache writes from the inclusive input count", () => {
    const { records } = parse({
      ...assistantLine,
      usage: { ...assistantLine.usage, cacheWriteTokens: 1_000 },
    });
    expect(records[0]?.totals).toEqual({
      uncachedInputTokens: 15_827,
      cachedInputTokens: 6_144,
      cacheCreationTokens: 1_000,
      outputTokens: 9,
      reasoningTokens: 0,
    });
  });

  it("ignores lines without usage, non-JSON lines, and unknown model lines", () => {
    expect(
      parse({ type: "message", id: "user-1", timestamp: "2026-10-31T18:46:01.989Z" }).records,
    ).toEqual([]);
    expect(parse("{not json").records).toEqual([]);
    expect(
      parse({ ...assistantLine, model: undefined, usage: { ...assistantLine.usage } }).records,
    ).toEqual([]);
  });

  it("omits a zero reported cost so shared pricing estimates it", () => {
    const { records } = parse({ ...assistantLine, usage: { ...assistantLine.usage, costUsd: 0 } });
    expect(records[0]?.reportedCostUsd).toBeNull();
  });

  it("reads the projected fields of a streamed line", () => {
    const records = commandCodeUsageFormat.parseProjected(
      {
        type: "message",
        id: "message-1",
        timestamp: assistantLine.timestamp,
        model: assistantLine.model,
        usage: { inputTokens: 100, outputTokens: 7, cacheReadTokens: 40, costUsd: 0.5 },
      },
      initialState(),
    );
    expect(records).toHaveLength(1);
    expect(records[0]?.totals.uncachedInputTokens).toBe(60);
  });

  it("dedupes the same message id across branches", () => {
    const first = parse(assistantLine).records[0]!;
    const second = parse(assistantLine).records[0]!;
    expect(first.dedupeKey).toBe(second.dedupeKey);
    expect(parse({ ...assistantLine, id: "message-2" }).records[0]!.dedupeKey).not.toBe(
      first.dedupeKey,
    );
  });
});

describe("isCommandCodeInstance", () => {
  it("recognizes the T3 local command wrapper", () => {
    expect(
      isCommandCodeInstance(
        decodeSettings({
          source: "local",
          commandPath: "/Users/dev/.t3/local-acp/command-code-acp",
        }),
      ),
    ).toBe(true);
  });

  it("recognizes a registry entry by agent id", () => {
    expect(
      isCommandCodeInstance(decodeSettings({ source: "registry", agentId: "command-code" })),
    ).toBe(true);
  });

  it.each(["/opt/homebrew/bin/cmd", "/Users/dev/node_modules/command-code/dist/cli.mjs"])(
    "recognizes %s as the executable",
    (commandPath) => {
      expect(isCommandCodeInstance(decodeSettings({ source: "local", commandPath }))).toBe(true);
    },
  );

  it("rejects other local commands", () => {
    expect(isCommandCodeInstance(decodeSettings({}))).toBe(false);
    expect(
      isCommandCodeInstance(decodeSettings({ source: "local", commandPath: "/usr/bin/gemini" })),
    ).toBe(false);
    expect(isCommandCodeInstance(decodeSettings({ source: "registry", agentId: "devin" }))).toBe(
      false,
    );
  });
});

describe("commandCodeUsageReader", () => {
  it.effect("reads ~/.commandcode/projects for a Command Code instance", () =>
    Effect.gen(function* () {
      const path = yield* Path.Path;
      if (commandCodeUsageReader.kind !== "transcripts") throw new Error("Expected a reader");
      const directories = yield* commandCodeUsageReader.directories({
        instanceId: ProviderInstanceId.make("acpRegistry_command_code"),
        configured: true,
        config: decodeSettings({
          source: "local",
          commandPath: "/Users/dev/.t3/local-acp/command-code-acp",
        }),
        environment: {},
      });
      expect(directories).toEqual([{ dir: path.join("/test-home", ".commandcode", "projects") }]);
    }).pipe(
      Effect.provide(NodeServices.layer),
      Effect.provideService(HostProcess.HomeDirectory, "/test-home"),
    ),
  );

  it.effect("reads nothing for another ACP command or an unconfigured instance", () =>
    Effect.gen(function* () {
      if (commandCodeUsageReader.kind !== "transcripts") throw new Error("Expected a reader");
      expect(
        yield* commandCodeUsageReader.directories({
          instanceId: ProviderInstanceId.make("acpRegistry_gemini"),
          configured: true,
          config: decodeSettings({ source: "local", commandPath: "/usr/bin/gemini" }),
          environment: {},
        }),
      ).toEqual([]);
      expect(
        yield* commandCodeUsageReader.directories({
          instanceId: ProviderInstanceId.make("acpRegistry"),
          configured: false,
          config: undefined,
          environment: {},
        }),
      ).toEqual([]);
    }).pipe(Effect.provide(NodeServices.layer)),
  );
});
