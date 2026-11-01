import * as NodeServices from "@effect/platform-node/NodeServices";
import { it } from "@effect/vitest";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientResponse from "effect/http/HttpClientResponse";
import * as Layer from "effect/Layer";
import { describe, expect } from "vite-plus/test";

import {
  commandCodePlanLabel,
  commandCodeUsageLimits,
  readCommandCodeAccount,
} from "./commandCodeUsageLimits.ts";

const checkedAt = "2026-10-31T18:00:00.000Z";
const isoOf = (ms: number) => DateTime.formatIso(Option.getOrThrow(DateTime.make(ms)));
const fiveHourResetMs = 1_793_490_202_163;
const weeklyResetMs = 1_793_813_249_160;

const credits = {
  credits: { monthlyCredits: 62.95, purchasedCredits: 0, freeCredits: 0 },
  windowLimits: {
    fiveHour: { used: 0.1458, cap: 14, exceeded: false, resetAt: fiveHourResetMs },
    weekly: { used: 5.7286, cap: 35, exceeded: false, resetAt: weeklyResetMs },
  },
};

describe("commandCodeUsageLimits", () => {
  it("maps the five-hour and weekly windows", () => {
    const limits = commandCodeUsageLimits({ credits, checkedAt });
    expect(limits.unavailable).toBeUndefined();
    expect(limits.windows).toEqual([
      {
        id: "five_hour",
        kind: "session",
        label: "Session",
        usedPercent: (0.1458 / 14) * 100,
        windowDurationMins: 300,
        resetsAt: isoOf(fiveHourResetMs),
      },
      {
        id: "weekly",
        kind: "weekly",
        label: "Weekly",
        usedPercent: (5.7286 / 35) * 100,
        windowDurationMins: 10_080,
        resetsAt: isoOf(weeklyResetMs),
      },
    ]);
  });

  it("drops a window without a positive cap", () => {
    const limits = commandCodeUsageLimits({
      credits: { windowLimits: { fiveHour: { used: 1, cap: 0, resetAt: fiveHourResetMs } } },
      checkedAt,
    });
    expect(limits.windows).toEqual([]);
    expect(limits.unavailable?.reason).toBe("unsupported");
  });

  it("stays unsupported without window limits", () => {
    const limits = commandCodeUsageLimits({
      credits: { credits: { monthlyCredits: 10 } },
      checkedAt,
    });
    expect(limits.unavailable?.reason).toBe("unsupported");
  });
});

describe("commandCodePlanLabel", () => {
  it.each([
    ["individual-goat", "GOAT"],
    ["team-max", "MAX"],
    ["individual-pro", "PRO"],
    ["individual-go", "GO"],
    ["custom-tier", "Tier"],
    [undefined, undefined],
  ])("labels %s as %s", (planId, expected) => {
    expect(commandCodePlanLabel(planId)).toBe(expected);
  });
});

describe("readCommandCodeAccount", () => {
  const respond = (routes: (url: string) => { status?: number; body: unknown }) =>
    HttpClient.make((request) => {
      const { status, body } = routes(request.url);
      return Effect.succeed(
        HttpClientResponse.fromWeb(
          request,
          new Response(JSON.stringify(body), { status: status ?? 200 }),
        ),
      );
    });

  it.effect("reports windows, email, plan, and a credential fingerprint", () =>
    Effect.gen(function* () {
      const account = yield* readCommandCodeAccount({
        COMMAND_CODE_API_KEY: "test-key",
      }).pipe(
        Effect.provideService(
          HttpClient.HttpClient,
          respond((url) => {
            if (url.includes("/whoami")) {
              return { body: { user: { email: "dev@example.com" }, org: null } };
            }
            if (url.includes("/billing/credits")) return { body: credits };
            if (url.includes("/billing/subscriptions")) {
              return { body: { data: { status: "active", planId: "individual-goat" } } };
            }
            throw new Error(`unexpected route ${url}`);
          }),
        ),
      );
      expect(account.email).toBe("dev@example.com");
      expect(account.plan).toBe("GOAT");
      expect(account.usageLimits.windows.map((window) => window.kind)).toEqual([
        "session",
        "weekly",
      ]);
      expect(account.usageLimits.credentialFingerprint).toMatch(/^[0-9a-f]{64}$/);
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("reports a failed probe when the API rejects the key", () =>
    Effect.gen(function* () {
      const account = yield* readCommandCodeAccount({ COMMAND_CODE_API_KEY: "revoked" }).pipe(
        Effect.provideService(
          HttpClient.HttpClient,
          respond(() => ({ status: 401, body: { error: "unauthorized" } })),
        ),
      );
      expect(account.usageLimits.unavailable?.reason).toBe("probeFailed");
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("is unsupported for a BYOK-only run", () =>
    Effect.gen(function* () {
      const account = yield* readCommandCodeAccount({
        COMMAND_CODE_API_KEY: "test-key",
        CMD_LOCAL_ONLY: "1",
      }).pipe(
        Effect.provideService(
          HttpClient.HttpClient,
          respond(() => ({ body: {} })),
        ),
      );
      expect(account.usageLimits).toEqual({
        checkedAt: account.usageLimits.checkedAt,
        windows: [],
        unavailable: { reason: "unsupported" },
      });
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("is unsupported when no credential exists", () =>
    Effect.gen(function* () {
      const account = yield* readCommandCodeAccount({ HOME: "/nonexistent-home" }).pipe(
        Effect.provideService(
          HttpClient.HttpClient,
          respond(() => ({ body: {} })),
        ),
      );
      expect(account.usageLimits.unavailable?.reason).toBe("unsupported");
    }).pipe(Effect.provide(Layer.mergeAll(NodeServices.layer))),
  );
});
