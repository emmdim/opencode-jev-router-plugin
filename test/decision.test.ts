import { describe, expect, test } from "bun:test"
import { normalizeConfig } from "../src/config.ts"
import {
    decisionKey,
    isRoutingDisabled,
    loadDecision,
    pickTier,
    resolveModel,
    routingDisabledKey,
    saveDecision,
    setRoutingDisabled,
} from "../src/decision.ts"
import { makeDecisionFixture } from "./support/fixtures.ts"
import { FakeStorage } from "./support/harness.ts"

const config = normalizeConfig({})

describe("pickTier", () => {
    test("trusts the tier at or above the confidence floor", () => {
        const pick = pickTier(config, makeDecisionFixture())
        expect(pick.tier).toBe("powerful")
        expect(pick.trusted).toBe(true)
    })

    test("distrusts the tier below the confidence floor", () => {
        const pick = pickTier(
            config,
            makeDecisionFixture({
                answers: { model_tier: { type: "choice", choice: "cheap", confidence: 0.2 } },
            }),
        )

        expect(pick.tier).toBe("cheap")
        expect(pick.trusted).toBe(false)
    })

    test("reports untrusted when the answer is missing", () => {
        const pick = pickTier(config, makeDecisionFixture({ answers: {} }))
        expect(pick.tier).toBeUndefined()
        expect(pick.trusted).toBe(false)
    })
})

describe("resolveModel", () => {
    test("maps tiers to configured models", () => {
        const powerful = resolveModel(config, makeDecisionFixture())
        expect(powerful.model).toBe("deepseek/deepseek-v4-pro-0813")
        expect(powerful.provider).toBe("openrouter")

        const cheap = resolveModel(
            config,
            makeDecisionFixture({
                answers: { model_tier: { type: "choice", choice: "cheap", confidence: 0.9 } },
            }),
        )
        expect(cheap.model).toBe("qwen/qwen3.6-flash")

        const fallback = resolveModel(
            config,
            makeDecisionFixture({
                answers: { model_tier: { type: "choice", choice: "default", confidence: 0.9 } },
            }),
        )
        expect(fallback.model).toBe("z-ai/glm-5.3-flash")
    })

    test("falls back on low confidence or missing answers", () => {
        const lowConfidence = resolveModel(
            config,
            makeDecisionFixture({
                answers: { model_tier: { type: "choice", choice: "powerful", confidence: 0.1 } },
            }),
        )
        expect(lowConfidence.model).toBe("z-ai/glm-5.3-flash")

        const missing = resolveModel(config, makeDecisionFixture({ answers: {} }))
        expect(missing.model).toBe("z-ai/glm-5.3-flash")
    })

    test("applies per-task-type overrides over the tier model", () => {
        const withOverride = normalizeConfig({
            taskTypeModels: {
                review: { provider: "anthropic", model: "claude-reviewer" },
            },
        })

        const resolved = resolveModel(
            withOverride,
            makeDecisionFixture({
                answers: {
                    model_tier: { type: "choice", choice: "cheap", confidence: 0.9 },
                    task_type: { type: "choice", choice: "review", confidence: 0.9 },
                },
            }),
        )

        expect(resolved.model).toBe("claude-reviewer")
        expect(resolved.provider).toBe("anthropic")
        expect(resolved.tier.tier).toBe("cheap")
    })

    test("ignores overrides for unmapped task types", () => {
        const resolved = resolveModel(config, makeDecisionFixture())
        expect(resolved.taskType).toBe("implementation")
        expect(resolved.model).toBe("deepseek/deepseek-v4-pro-0813")
    })
})

describe("decision persistence", () => {
    test("round-trips through storage", async () => {
        const storage = new FakeStorage()
        const stored = {
            sessionID: "ses_1",
            messageID: "msg_1",
            createdAt: 123,
            response: makeDecisionFixture(),
        }

        await saveDecision(storage, stored)

        expect(storage.map.has(decisionKey("ses_1"))).toBe(true)
        expect(await loadDecision(storage, "ses_1")).toEqual(stored)
    })

    test("returns undefined for missing or corrupt entries", async () => {
        const storage = new FakeStorage()
        expect(await loadDecision(storage, "ses_missing")).toBeUndefined()

        storage.map.set(decisionKey("ses_bad"), "not-a-decision")
        expect(await loadDecision(storage, "ses_bad")).toBeUndefined()
    })
})

describe("routing toggle", () => {
    test("is off by default", async () => {
        const storage = new FakeStorage()
        expect(await isRoutingDisabled(storage, "ses_1")).toBe(false)
    })

    test("stores and clears the disabled flag", async () => {
        const storage = new FakeStorage()

        await setRoutingDisabled(storage, "ses_1", true)
        expect(storage.map.get(routingDisabledKey("ses_1"))).toBe(true)
        expect(await isRoutingDisabled(storage, "ses_1")).toBe(true)

        await setRoutingDisabled(storage, "ses_1", false)
        expect(await isRoutingDisabled(storage, "ses_1")).toBe(false)
    })

    test("falls back to an explicit false when storage cannot delete", async () => {
        const values = new Map<string, unknown>()
        const storage = {
            async get(key: string) {
                return values.get(key)
            },
            async set(key: string, value: unknown) {
                values.set(key, value)
            },
        }

        await setRoutingDisabled(storage, "ses_1", true)
        expect(await isRoutingDisabled(storage, "ses_1")).toBe(true)

        await setRoutingDisabled(storage, "ses_1", false)
        expect(values.get(routingDisabledKey("ses_1"))).toBe(false)
        expect(await isRoutingDisabled(storage, "ses_1")).toBe(false)
    })
})
