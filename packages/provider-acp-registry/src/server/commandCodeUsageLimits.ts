import type { ServerProviderUsageLimits, ServerProviderUsageWindow } from "@t3tools/contracts";
import {
  clampPercent,
  makeUnavailableUsageLimits,
  makeUsageLimits,
} from "@t3tools/provider-core/server/usageLimits";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Hex from "effect/encoding/Hex";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientRequest from "effect/http/HttpClientRequest";
import * as HttpClientResponse from "effect/http/HttpClientResponse";
import * as HostProcess from "@t3tools/shared/HostProcess";

const API_BASE_URL = "https://api.commandcode.ai";
const PROBE_TIMEOUT = "10 seconds";

const CommandCodeAuth = Schema.Struct({
  apiKey: Schema.optional(Schema.String),
  userName: Schema.optional(Schema.String),
});
const decodeAuth = Schema.decodeUnknownOption(Schema.fromJsonString(CommandCodeAuth));

const WindowLimit = Schema.Struct({
  used: Schema.optional(Schema.Number),
  cap: Schema.optional(Schema.Number),
  resetAt: Schema.optional(Schema.Number),
});

const CreditsResponse = Schema.Struct({
  credits: Schema.optional(
    Schema.Struct({
      monthlyCredits: Schema.optional(Schema.Number),
      purchasedCredits: Schema.optional(Schema.Number),
      freeCredits: Schema.optional(Schema.Number),
    }),
  ),
  windowLimits: Schema.optional(
    Schema.Struct({
      fiveHour: Schema.optional(WindowLimit),
      weekly: Schema.optional(WindowLimit),
    }),
  ),
});

const WhoamiResponse = Schema.Struct({
  user: Schema.optional(Schema.Struct({ email: Schema.optional(Schema.String) })),
  org: Schema.optional(Schema.NullOr(Schema.Struct({ id: Schema.optional(Schema.String) }))),
});

const SubscriptionResponse = Schema.Struct({
  data: Schema.optional(
    Schema.Struct({
      status: Schema.optional(Schema.String),
      planId: Schema.optional(Schema.String),
    }),
  ),
});

const PLAN_TIERS = new Set(["go", "goat", "pro", "max"]);

/** `individual-goat` and `team-max` both mean the GOAT and Max plans. */
export function commandCodePlanLabel(planId: string | undefined): string | undefined {
  const segment = planId?.trim().toLowerCase().split(/[-_]/).at(-1);
  if (!segment) return undefined;
  return PLAN_TIERS.has(segment)
    ? segment.toUpperCase()
    : segment.charAt(0).toUpperCase() + segment.slice(1);
}

function windowFromLimit(
  id: string,
  kind: ServerProviderUsageWindow["kind"],
  label: string,
  limit: typeof WindowLimit.Type,
  windowDurationMins: number,
): ServerProviderUsageWindow | null {
  const used = limit.used;
  const cap = limit.cap;
  if (typeof used !== "number" || typeof cap !== "number") return null;
  if (!Number.isFinite(used) || !Number.isFinite(cap) || cap <= 0) return null;
  const reset = limit.resetAt;
  const resetsAt =
    typeof reset === "number" && Number.isFinite(reset) ? DateTime.make(reset) : Option.none();
  return {
    id,
    kind,
    label,
    usedPercent: clampPercent((used / cap) * 100),
    windowDurationMins,
    ...(Option.isSome(resetsAt) ? { resetsAt: DateTime.formatIso(resetsAt.value) } : {}),
  };
}

export function commandCodeUsageLimits(input: {
  readonly credits: typeof CreditsResponse.Type;
  readonly subscription?: typeof SubscriptionResponse.Type;
  readonly checkedAt: string;
}): ServerProviderUsageLimits {
  const limits = input.credits.windowLimits;
  const windows: ServerProviderUsageWindow[] = [];
  if (limits?.fiveHour) {
    const window = windowFromLimit("five_hour", "session", "Session", limits.fiveHour, 5 * 60);
    if (window) windows.push(window);
  }
  if (limits?.weekly) {
    const window = windowFromLimit("weekly", "weekly", "Weekly", limits.weekly, 7 * 24 * 60);
    if (window) windows.push(window);
  }
  if (windows.length === 0) {
    return makeUnavailableUsageLimits({ checkedAt: input.checkedAt, reason: "unsupported" });
  }
  return makeUsageLimits({ checkedAt: input.checkedAt, windows });
}

const readAuthFile = Effect.fn("readCommandCodeAuthFile")(function* (
  environment: NodeJS.ProcessEnv,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const home = environment.HOME || environment.USERPROFILE || (yield* HostProcess.HomeDirectory);
  const contents = yield* fs.readFileString(path.join(home, ".commandcode", "auth.json")).pipe(
    Effect.catchTags({
      PlatformError: (error) =>
        error.reason._tag === "NotFound" ? Effect.succeed("{}") : Effect.fail(error),
    }),
  );
  return Option.getOrUndefined(decodeAuth(contents));
});

const readApiKey = Effect.fn("readCommandCodeApiKey")(function* (environment: NodeJS.ProcessEnv) {
  const fromEnv = environment.COMMAND_CODE_API_KEY?.trim();
  if (fromEnv) return fromEnv;
  const auth = yield* readAuthFile(environment);
  const key = auth?.apiKey?.trim();
  return key ? key : undefined;
});

export const readCommandCodeAccount = Effect.fn("readCommandCodeAccount")(function* (
  environment: NodeJS.ProcessEnv,
) {
  const checkedAt = DateTime.formatIso(yield* DateTime.now);
  const unsupported = makeUnavailableUsageLimits({ checkedAt, reason: "unsupported" });
  const probeFailed = makeUnavailableUsageLimits({
    checkedAt,
    reason: "probeFailed",
    message: "Command Code could not read usage limits.",
  });
  // BYOK-only runs never reach the Command Code API, so there is no subscription to report.
  const localOnly = environment.CMD_LOCAL_ONLY?.trim().toLowerCase();
  if (localOnly === "1" || localOnly === "true") {
    return { email: undefined, plan: undefined, usageLimits: unsupported };
  }
  const apiKey = yield* readApiKey(environment).pipe(Effect.orElseSucceed(() => undefined));
  if (apiKey === undefined) {
    return { email: undefined, plan: undefined, usageLimits: unsupported };
  }

  const account = yield* Effect.gen(function* () {
    const client = yield* HttpClient.HttpClient;
    const crypto = yield* Crypto.Crypto;
    // Cloudflare rejects non-CLI user agents on the Command Code API.
    const get = <A, I>(route: string, schema: Schema.Codec<A, I>) =>
      client
        .execute(
          HttpClientRequest.get(`${API_BASE_URL}${route}`).pipe(
            HttpClientRequest.bearerToken(apiKey),
            HttpClientRequest.setHeaders({ accept: "application/json", "user-agent": "cli" }),
          ),
        )
        .pipe(
          Effect.flatMap(HttpClientResponse.filterStatusOk),
          Effect.flatMap(HttpClientResponse.schemaBodyJson(schema)),
        );

    const whoami = yield* get("/alpha/whoami?limits=1", WhoamiResponse);
    const orgId = whoami.org?.id?.trim();
    const orgQuery = orgId ? `?orgId=${encodeURIComponent(orgId)}` : "";
    const [credits, subscription] = yield* Effect.all(
      [
        get(`/alpha/billing/credits${orgQuery}`, CreditsResponse),
        get(`/alpha/billing/subscriptions${orgQuery}`, SubscriptionResponse),
      ],
      { concurrency: 2 },
    );
    const credentialFingerprint = yield* crypto
      .digest("SHA-256", new TextEncoder().encode(`commandcode\0${apiKey}`))
      .pipe(Effect.map(Hex.encode), Effect.orDie);
    return {
      email: whoami.user?.email?.trim() || undefined,
      plan:
        subscription.data?.status === "active"
          ? commandCodePlanLabel(subscription.data?.planId)
          : undefined,
      usageLimits: {
        ...commandCodeUsageLimits({ credits, subscription, checkedAt }),
        credentialFingerprint,
      },
    };
  }).pipe(
    Effect.timeout(PROBE_TIMEOUT),
    Effect.orElseSucceed(() => null),
  );

  if (account === null) return { email: undefined, plan: undefined, usageLimits: probeFailed };
  return account;
});
