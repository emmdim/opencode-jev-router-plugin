import { describe, expect, test } from "bun:test"
import { normalizeConfig } from "../src/config.ts"

function load(options: unknown) {
    const warnings: string[] = []
    const config = normalizeConfig(options, (message) => warnings.push(message))
    return { config, warnings }
}

describe("normalizeConfig defaults", () => {
    test("returns the documented defaults without warnings", () => {
        const { config, warnings } = load({})

        expect(warnings).toEqual([])
        expect(config.enabled).toBe(true)
        expect(config.router).toEqual({ provider: "openrouter", model: "typesafe/jev-1.13" })
        expect(config.cheap).toEqual({ provider: "openrouter", model: "qwen/qwen3.6-flash" })
        expect(config.powerful).toEqual({
            provider: "openrouter",
            model: "deepseek/deepseek-v4-pro-0813",
        })
        expect(config.fallback).toEqual({ provider: "openrouter", model: "z-ai/glm-5.3-flash" })
        expect(config.taskTypeModels).toEqual({})
        expect(config.minimumPromptLength).toBe(100)
        expect(config.minimumThresholdConfidence).toBe(0.5)
        expect(config.timeoutMs).toBe(5000)
        expect(config.ignoredPrefixes).toEqual([
            "/help",
            "/models",
            "/connect",
            "/logout",
            "/clear",
            "/jev",
            "/jev-off",
            "/jev-on",
        ])
        expect(config.ignoredAgents).toEqual(["title", "compaction"])
        expect(config.previousContext).toEqual({
            enabled: true,
            maxPreviewChars: 240,
            maxFiles: 10,
        })
        expect(config.reasoningEffort).toEqual({
            providers: { openrouter: "reasoning_effort", openai: "reasoningEffort" },
            values: {},
        })
        expect(config.onError).toBe("fallback")
        expect(config.statusCommand).toBe(true)
        expect(config.logLevel).toBe("warn")
        expect(config.logFile).toEndWith("opencode/jev-router.log")
    })

    test("treats null and undefined as no options", () => {
        expect(load(null).warnings).toEqual([])
        expect(load(undefined).warnings).toEqual([])
    })

    test("warns and uses defaults for non-object options", () => {
        const { config, warnings } = load("nope")

        expect(config.enabled).toBe(true)
        expect(warnings).toEqual(["plugin options must be an object; using defaults"])
    })

    test("returns fresh objects on every call", () => {
        normalizeConfig({}).ignoredPrefixes.push("/mutated")

        expect(normalizeConfig({}).ignoredPrefixes).not.toContain("/mutated")
    })
})

describe("normalizeConfig overrides", () => {
    test("merges partial model choices over the defaults", () => {
        const { config, warnings } = load({ cheap: { model: "qwen/qwen3.7-flash" } })

        expect(warnings).toEqual([])
        expect(config.cheap).toEqual({ provider: "openrouter", model: "qwen/qwen3.7-flash" })
    })

    test("merges effort provider and value maps over the defaults", () => {
        const { config } = load({
            reasoningEffort: {
                providers: { anthropic: "effort", openai: "" },
                values: { high: "xhigh" },
            },
        })

        expect(config.reasoningEffort).toEqual({
            providers: { openrouter: "reasoning_effort", openai: "", anthropic: "effort" },
            values: { high: "xhigh" },
        })
    })

    test("merges previousContext field by field", () => {
        const { config } = load({ previousContext: { enabled: false } })

        expect(config.previousContext).toEqual({
            enabled: false,
            maxPreviewChars: 240,
            maxFiles: 10,
        })
    })

    test("keeps valid task type overrides", () => {
        const review = { provider: "anthropic", model: "claude-reviewer" }

        expect(load({ taskTypeModels: { review } }).config.taskTypeModels).toEqual({ review })
    })
})

describe("normalizeConfig validation", () => {
    test("reverts invalid scalars and warns once per option", () => {
        const { config, warnings } = load({
            timeoutMs: 0,
            minimumThresholdConfidence: 1.5,
            ignoredPrefixes: "/help",
        })

        expect(config.timeoutMs).toBe(5000)
        expect(config.minimumThresholdConfidence).toBe(0.5)
        expect(config.ignoredPrefixes).toContain("/models")
        expect(warnings).toHaveLength(3)
        expect(warnings).toContain('option "timeoutMs" must be an integer >= 1; using default 5000')
        expect(warnings).toContain(
            'option "minimumThresholdConfidence" must be a number between 0 and 1; using default 0.5',
        )
    })

    test("rejects model choices with empty fields", () => {
        const { config, warnings } = load({ cheap: { provider: "" } })

        expect(config.cheap).toEqual({ provider: "openrouter", model: "qwen/qwen3.6-flash" })
        expect(warnings).toHaveLength(1)
        expect(warnings[0]).toStartWith('option "cheap" must be { provider, model }')
    })

    test("drops unknown task types and malformed overrides", () => {
        const valid = { provider: "anthropic", model: "claude-reviewer" }
        const { config, warnings } = load({
            taskTypeModels: { review: valid, poetry: valid, bugfix: { provider: "x" } },
        })

        expect(config.taskTypeModels).toEqual({ review: valid })
        expect(warnings).toEqual([
            'option "taskTypeModels.poetry" is not a known task type; ignored',
            'option "taskTypeModels.bugfix" must be { provider, model } with non-empty strings; ignored',
        ])
    })

    test("rejects non-object sections", () => {
        const { config, warnings } = load({ previousContext: true })

        expect(config.previousContext.enabled).toBe(true)
        expect(warnings).toEqual(['option "previousContext" must be an object; using defaults'])
    })

    test("validates enum options", () => {
        const { config, warnings } = load({ logLevel: "verbose", onError: "crash" })

        expect(config.logLevel).toBe("warn")
        expect(config.onError).toBe("fallback")
        expect(warnings).toHaveLength(2)
    })

    test("warns about unknown options", () => {
        expect(load({ routr: {} }).warnings).toEqual(['unknown option "routr" ignored'])
    })

    test("maps the deprecated logging boolean onto logLevel", () => {
        const deprecated = 'option "logging" is deprecated; use "logLevel"'

        expect(load({ logging: false })).toEqual({
            config: expect.objectContaining({ logLevel: "off" }),
            warnings: [deprecated],
        })
        expect(load({ logging: true }).config.logLevel).toBe("info")
        expect(load({ logging: false, logLevel: "debug" }).config.logLevel).toBe("debug")
    })

    test("forces /jev into ignoredPrefixes when the command is enabled", () => {
        const enabled = load({ statusCommand: true, ignoredPrefixes: ["/help"] }).config
        expect(enabled.ignoredPrefixes).toContain("/help")
        expect(enabled.ignoredPrefixes).toContain("/jev")

        const disabled = load({ statusCommand: false, ignoredPrefixes: ["/help"] }).config
        expect(disabled.ignoredPrefixes).toEqual(["/help"])
    })
})
