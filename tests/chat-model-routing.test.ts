import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  REPROBE_AFTER_MS,
  attemptOrder,
  classifyModelError,
  currentSpecialistModel,
  describeRouting,
  emptyRoutingState,
  parseRoutingState,
  recordModelOutcome,
  regionPrefix,
  specialistCandidates,
  type ModelRoutingState,
} from "@/lib/model-routing";

const MAIN = "eu.anthropic.claude-opus-4-6-v1";
const HAIKU = "eu.anthropic.claude-haiku-4-5-20251001-v1:0";
const SONNET = "eu.anthropic.claude-sonnet-4-5-20250929-v1:0";
const NOW = Date.parse("2026-11-12T10:00:00.000Z");

const awsError = (name: string, message: string) => Object.assign(new Error(message), { name });
const ACCESS_DENIED = awsError("AccessDeniedException", "You don't have access to the model with the specified model ID.");

describe("regionPrefix", () => {
  it.each([
    ["eu.anthropic.claude-opus-4-6-v1", "eu."],
    ["us.anthropic.claude-sonnet-4-5-20250929-v1:0", "us."],
    ["apac.anthropic.claude-haiku-4-5-20251001-v1:0", "apac."],
    ["global.anthropic.claude-opus-4-6-v1", "global."],
    ["anthropic.claude-3-haiku-20240307-v1:0", ""],
    ["arn:aws:bedrock:eu-central-1:123456789012:inference-profile/eu.anthropic.claude-opus-4-6-v1", "eu."],
    ["", ""],
  ])("%s → %j", (id, prefix) => {
    expect(regionPrefix(id)).toBe(prefix);
  });
});

describe("specialistCandidates", () => {
  it("is Haiku 4.5 then Sonnet 4.5 in the main model's region family", () => {
    expect(specialistCandidates(MAIN)).toEqual([HAIKU, SONNET]);
    expect(specialistCandidates("anthropic.claude-opus-4-6-v1")).toEqual([
      "anthropic.claude-haiku-4-5-20251001-v1:0",
      "anthropic.claude-sonnet-4-5-20250929-v1:0",
    ]);
  });

  it("takes the env list as written and never lists the main model", () => {
    expect(specialistCandidates(MAIN, ` us.custom-a , ${MAIN},us.custom-a,, us.custom-b `)).toEqual([
      "us.custom-a",
      "us.custom-b",
    ]);
    expect(specialistCandidates(HAIKU)).toEqual([SONNET]);
    expect(specialistCandidates(MAIN, " , ")).toEqual([HAIKU, SONNET]);
  });
});

describe("classifyModelError", () => {
  it.each([
    [ACCESS_DENIED, "model_unavailable"],
    [awsError("ValidationException", "The provided model identifier is invalid."), "model_unavailable"],
    [
      awsError(
        "ValidationException",
        "Invocation of model ID anthropic.claude-haiku-4-5-20251001-v1:0 with on-demand throughput isn’t supported. Retry your request with the ID or ARN of an inference profile that contains this model."
      ),
      "model_unavailable",
    ],
    [awsError("ResourceNotFoundException", "Could not resolve the foundation model from the provided model identifier."), "model_unavailable"],
    [awsError("Error", "AccessDeniedException: User is not authorized to perform: bedrock:InvokeModel"), "model_unavailable"],
    [awsError("ValidationException", "max_tokens: 99999 > 64000, which is the maximum allowed"), "other"],
    [awsError("ThrottlingException", "Too many requests, please wait before trying again."), "throttled"],
    [awsError("ExpiredTokenException", "The security token included in the request is expired"), "auth"],
    [awsError("CredentialsProviderError", "The SSO session associated with this profile has expired"), "auth"],
    [awsError("Error", "getaddrinfo ENOTFOUND bedrock-runtime.eu-central-1.amazonaws.com"), "network"],
    [awsError("AbortError", "Request aborted"), "aborted"],
    [awsError("ModelTimeoutException", "Model has timed out in processing the request"), "other"],
    ["something odd", "other"],
  ])("%o → %s", (error, kind) => {
    expect(classifyModelError(error)).toBe(kind);
  });
});

describe("state transitions", () => {
  const candidates = [HAIKU, SONNET];

  it("starts with the first candidate and ends at the main model", () => {
    const state = emptyRoutingState();
    expect(attemptOrder(candidates, MAIN, state, NOW)).toEqual([HAIKU, SONNET, MAIN]);
    expect(currentSpecialistModel(candidates, MAIN, state, NOW)).toBe(HAIKU);
    expect(attemptOrder([], MAIN, state, NOW)).toEqual([MAIN]);
  });

  it("skips a model that was refused, and tries it again after 7 days", () => {
    const refused = recordModelOutcome(emptyRoutingState(), HAIKU, "model_unavailable", NOW, "  no   access\n to it ");
    expect(refused.models[HAIKU]).toEqual({ usable: false, checkedAt: new Date(NOW).toISOString(), reason: "no access to it" });
    expect(attemptOrder(candidates, MAIN, refused, NOW + 1000)).toEqual([SONNET, MAIN]);
    expect(attemptOrder(candidates, MAIN, refused, NOW + REPROBE_AFTER_MS - 1)).toEqual([SONNET, MAIN]);
    expect(attemptOrder(candidates, MAIN, refused, NOW + REPROBE_AFTER_MS)).toEqual([HAIKU, SONNET, MAIN]);

    const both = recordModelOutcome(refused, SONNET, "model_unavailable", NOW);
    expect(currentSpecialistModel(candidates, MAIN, both, NOW)).toBe(MAIN);
  });

  it("remembers a model that answered, once", () => {
    const ok = recordModelOutcome(emptyRoutingState(), HAIKU, "ok", NOW);
    expect(ok.models[HAIKU]).toEqual({ usable: true, checkedAt: new Date(NOW).toISOString() });
    // Nothing new to remember: the same object, so the caller skips the write.
    expect(recordModelOutcome(ok, HAIKU, "ok", NOW + 5000)).toBe(ok);
    // A re-probe that works clears the refusal.
    const refused = recordModelOutcome(emptyRoutingState(), HAIKU, "model_unavailable", NOW);
    expect(recordModelOutcome(refused, HAIKU, "ok", NOW + REPROBE_AFTER_MS).models[HAIKU].usable).toBe(true);
  });

  it.each(["throttled", "auth", "network", "aborted", "other"] as const)("%s marks nothing", (kind) => {
    const state = recordModelOutcome(emptyRoutingState(), HAIKU, "ok", NOW);
    expect(recordModelOutcome(state, HAIKU, kind, NOW)).toBe(state);
    const blank = emptyRoutingState();
    expect(recordModelOutcome(blank, HAIKU, kind, NOW)).toBe(blank);
  });

  it("reads a stored file defensively", () => {
    expect(parseRoutingState(null)).toEqual({ models: {} });
    expect(
      parseRoutingState({
        models: {
          a: { usable: false, checkedAt: "2026-11-01T00:00:00.000Z", reason: "denied" },
          b: { usable: "yes", checkedAt: "2026-11-01T00:00:00.000Z" },
          c: { usable: true, checkedAt: "not a date" },
          d: null,
        },
      })
    ).toEqual({ models: { a: { usable: false, checkedAt: "2026-11-01T00:00:00.000Z", reason: "denied" } } });
  });

  it("describes the routing for Settings", () => {
    const state = recordModelOutcome(emptyRoutingState(), HAIKU, "model_unavailable", NOW, "denied");
    expect(describeRouting({ mainModelId: MAIN, candidates, state, now: NOW })).toEqual({
      specialist: {
        mode: "auto",
        modelId: SONNET,
        tried: [{ modelId: HAIKU, usable: false, checkedAt: new Date(NOW).toISOString(), reason: "denied" }],
      },
      mainModelId: MAIN,
    });
    expect(describeRouting({ fixedModelId: ` ${MAIN} `, mainModelId: MAIN, candidates, state, now: NOW })).toEqual({
      specialist: { mode: "fixed", modelId: MAIN, tried: [] },
      mainModelId: MAIN,
    });
  });
});

// --- The runtime side: real calls replaced by a scripted Bedrock ------------

const bedrock = vi.hoisted(() => ({
  /** What each model does when called. */
  behaviour: {} as Record<string, () => string>,
  calls: [] as string[],
  state: { models: {} } as ModelRoutingState,
  saves: 0,
}));

vi.mock("@/lib/bedrock-client", () => ({ DEFAULT_BEDROCK_MODEL_ID: "eu.anthropic.claude-opus-4-6-v1" }));
vi.mock("@/lib/chat-debug", () => ({ logChatEvent: vi.fn() }));
vi.mock("@/lib/bedrock-claude", () => ({
  callClaudeText: vi.fn(async (_p: string, _m: number, _t: number, modelId: string) => {
    bedrock.calls.push(modelId);
    return (bedrock.behaviour[modelId] || (() => `answer from ${modelId}`))();
  }),
}));
vi.mock("@/lib/model-routing-store", () => ({
  loadModelRoutingState: () => bedrock.state,
  saveModelRoutingState: (next: ModelRoutingState) => {
    bedrock.state = next;
    bedrock.saves += 1;
  },
  clearModelRoutingState: () => {
    bedrock.state = { models: {} };
  },
}));

import { logChatEvent } from "@/lib/chat-debug";
import { runWithRequestContext } from "@/lib/chat/request-context";
import {
  callSpecialistClaude,
  getModelRoutingStatus,
  recheckSpecialistModels,
  resolveSpecialistModel,
} from "@/lib/chat/specialist-model";

const fail = (error: unknown) => () => {
  throw error;
};
const ask = (fixedModelId?: string) => callSpecialistClaude("q", 100, 0, { fixedModelId });

describe("callSpecialistClaude", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    bedrock.behaviour = {};
    bedrock.calls = [];
    bedrock.state = { models: {} };
    bedrock.saves = 0;
    delete process.env.BEDROCK_SPECIALIST_MODEL_IDS;
  });

  it("uses the first candidate, remembers that it works and logs the model", async () => {
    expect(await ask()).toEqual({ text: `answer from ${HAIKU}`, modelId: HAIKU });
    expect(bedrock.state.models[HAIKU].usable).toBe(true);
    await ask();
    expect(bedrock.calls).toEqual([HAIKU, HAIKU]);
    expect(bedrock.saves).toBe(1);
    expect(vi.mocked(logChatEvent).mock.calls[0]).toEqual(["specialist_model_used", { modelId: HAIKU, mode: "auto", fallbacks: 0 }]);
  });

  it("falls through refused models to the main one and stops trying them", async () => {
    bedrock.behaviour[HAIKU] = fail(ACCESS_DENIED);
    bedrock.behaviour[SONNET] = fail(awsError("ValidationException", "The provided model identifier is invalid."));
    expect((await ask()).modelId).toBe(MAIN);
    expect(bedrock.calls).toEqual([HAIKU, SONNET, MAIN]);
    expect(bedrock.state.models[HAIKU]).toMatchObject({ usable: false, reason: expect.stringContaining("don't have access") });
    expect(bedrock.state.models[SONNET].usable).toBe(false);
    // The main model is the last resort, not a candidate: nothing is remembered about it.
    expect(bedrock.state.models[MAIN]).toBeUndefined();

    bedrock.calls = [];
    expect((await ask()).modelId).toBe(MAIN);
    expect(bedrock.calls).toEqual([MAIN]);
    expect(resolveSpecialistModel()).toBe(MAIN);
    expect(getModelRoutingStatus().specialist).toMatchObject({ mode: "auto", modelId: MAIN });
    expect(getModelRoutingStatus().specialist.tried.map((t) => t.modelId)).toEqual([HAIKU, SONNET]);
  });

  it("probes again after Re-check", async () => {
    bedrock.behaviour[HAIKU] = fail(ACCESS_DENIED);
    await ask();
    bedrock.behaviour = {};
    recheckSpecialistModels();
    expect((await ask()).modelId).toBe(HAIKU);
  });

  it("a throttled cheap model is skipped for that call only", async () => {
    bedrock.behaviour[HAIKU] = fail(awsError("ThrottlingException", "Too many requests"));
    expect((await ask()).modelId).toBe(SONNET);
    expect(bedrock.state.models[HAIKU]).toBeUndefined();
    bedrock.behaviour = {};
    expect((await ask()).modelId).toBe(HAIKU);
  });

  it.each([
    ["an expired login", awsError("ExpiredTokenException", "The security token included in the request is expired")],
    ["a network error", awsError("Error", "getaddrinfo ENOTFOUND bedrock-runtime.eu-central-1.amazonaws.com")],
    ["a cancelled request", awsError("AbortError", "Request aborted")],
  ])("%s is thrown as is and marks nothing", async (_what, error) => {
    bedrock.behaviour[HAIKU] = fail(error);
    await expect(ask()).rejects.toBe(error);
    expect(bedrock.calls).toEqual([HAIKU]);
    expect(bedrock.state).toEqual({ models: {} });
    expect(bedrock.saves).toBe(0);
  });

  it("throws what the main model throws", async () => {
    bedrock.behaviour[HAIKU] = fail(ACCESS_DENIED);
    bedrock.behaviour[SONNET] = fail(ACCESS_DENIED);
    bedrock.behaviour[MAIN] = fail(ACCESS_DENIED);
    await expect(ask()).rejects.toBe(ACCESS_DENIED);
    expect(bedrock.state.models[MAIN]).toBeUndefined();
  });

  it("a fixed model is used as is, without fallback or memory", async () => {
    expect((await ask(MAIN)).modelId).toBe(MAIN);
    bedrock.behaviour["us.custom"] = fail(ACCESS_DENIED);
    await expect(ask("us.custom")).rejects.toBe(ACCESS_DENIED);
    expect(bedrock.calls).toEqual([MAIN, "us.custom"]);
    expect(bedrock.state).toEqual({ models: {} });
    expect(getModelRoutingStatus("us.custom")).toEqual({
      specialist: { mode: "fixed", modelId: "us.custom", tried: [] },
      mainModelId: MAIN,
    });
  });

  it("takes the candidates from BEDROCK_SPECIALIST_MODEL_IDS", async () => {
    process.env.BEDROCK_SPECIALIST_MODEL_IDS = "us.one, us.two";
    bedrock.behaviour["us.one"] = fail(ACCESS_DENIED);
    expect((await ask()).modelId).toBe("us.two");
    expect(bedrock.calls).toEqual(["us.one", "us.two"]);
  });

  it("a dry run plans one call on the current model and changes nothing", async () => {
    bedrock.behaviour[HAIKU] = fail(ACCESS_DENIED);
    await runWithRequestContext({ dryRun: true }, async () => {
      // The mocked Bedrock stands in for the real dry-run short-circuit: one call, no fallback.
      await expect(ask()).rejects.toBe(ACCESS_DENIED);
    });
    expect(bedrock.calls).toEqual([HAIKU]);
    expect(bedrock.state).toEqual({ models: {} });
    expect(bedrock.saves).toBe(0);
  });
});
