import { ROUTING_TASK_TYPES, type RoutingTaskType } from "./jev.ts"
import { LOG_LEVELS, type LogLevel } from "./logger.ts"
import { defaultLogFile } from "./paths.ts"

export interface ChoiceConfig {
    provider: string
    model: string
}

export type EffortValues = Partial<Record<string, string>>

export interface ReasoningEffortConfig {
    /** Provider ID → provider option key that receives the effort value. `""` disables a provider. */
    providers?: Record<string, string>
    /** Classifier effort choice → value sent to the provider. */
    values?: EffortValues
}

export interface PreviousContextConfig {
    enabled?: boolean
    maxPreviewChars?: number
    maxFiles?: number
}

export const ERROR_MODES = ["fallback", "keep"] as const
export type ErrorMode = (typeof ERROR_MODES)[number]

export interface PluginConfig {
    enabled?: boolean
    router?: ChoiceConfig
    cheap?: ChoiceConfig
    powerful?: ChoiceConfig
    fallback?: ChoiceConfig
    taskTypeModels?: Partial<Record<RoutingTaskType, ChoiceConfig>>
    minimumPromptLength?: number
    minimumThresholdConfidence?: number
    timeoutMs?: number
    ignoredPrefixes?: string[]
    ignoredAgents?: string[]
    previousContext?: PreviousContextConfig
    reasoningEffort?: ReasoningEffortConfig
    /** What to do when routing fails: switch to `fallback`, or keep the session model. */
    onError?: ErrorMode
    /** Register the `/jev` status command. */
    statusCommand?: boolean
    logLevel?: LogLevel
    logFile?: string
    /** @deprecated Use `logLevel`. `true` maps to `"info"`, `false` to `"off"`. */
    logging?: boolean
}

export type RuntimeConfig = Required<
    Omit<PluginConfig, "logging" | "previousContext" | "reasoningEffort">
> & {
    previousContext: Required<PreviousContextConfig>
    reasoningEffort: Required<ReasoningEffortConfig>
}

export type Warn = (message: string) => void

function defaults(): RuntimeConfig {
    return {
        enabled: true,
        router: { provider: "openrouter", model: "typesafe/jev-1.13" },
        cheap: { provider: "openrouter", model: "qwen/qwen3.6-flash" },
        powerful: { provider: "openrouter", model: "deepseek/deepseek-v4-pro-0813" },
        fallback: { provider: "openrouter", model: "z-ai/glm-5.3-flash" },
        taskTypeModels: {},
        minimumPromptLength: 100,
        minimumThresholdConfidence: 0.5,
        timeoutMs: 5000,
        ignoredPrefixes: [
            "/help",
            "/models",
            "/connect",
            "/logout",
            "/clear",
            "/jev",
            "/jev-off",
            "/jev-on",
        ],
        ignoredAgents: ["title", "compaction"],
        previousContext: { enabled: true, maxPreviewChars: 240, maxFiles: 10 },
        reasoningEffort: {
            providers: { openrouter: "reasoning_effort", openai: "reasoningEffort" },
            values: {},
        },
        onError: "fallback",
        statusCommand: true,
        logLevel: "warn",
        logFile: defaultLogFile(),
    }
}

/**
 * Every option name accepted from user config. Keep in sync with the
 * `PluginConfig` interface; `logging` is the deprecated alias of `logLevel`.
 * A literal list (not derived from `defaults()`) so module evaluation never
 * calls `os.homedir()`, which throws in a HOME-less container.
 */
const OPTION_NAMES = [
    "enabled",
    "router",
    "cheap",
    "powerful",
    "fallback",
    "taskTypeModels",
    "minimumPromptLength",
    "minimumThresholdConfidence",
    "timeoutMs",
    "ignoredPrefixes",
    "ignoredAgents",
    "previousContext",
    "reasoningEffort",
    "onError",
    "statusCommand",
    "logLevel",
    "logFile",
    "logging",
] as const

const KNOWN_OPTIONS = new Set<string>(OPTION_NAMES)

type Input = Record<string, unknown>
type Check<T> = (value: unknown) => value is T

const isPlainObject = (value: unknown): value is Input =>
    typeof value === "object" && value !== null && !Array.isArray(value)
const isBoolean: Check<boolean> = (value) => typeof value === "boolean"
const isNonEmptyString: Check<string> = (value): value is string =>
    typeof value === "string" && value.trim() !== ""
const isStringArray: Check<string[]> = (value): value is string[] =>
    Array.isArray(value) && value.every((item) => typeof item === "string")
const isStringRecord: Check<Record<string, string>> = (value): value is Record<string, string> =>
    isPlainObject(value) && Object.values(value).every((item) => typeof item === "string")
const isUnitInterval: Check<number> = (value): value is number =>
    typeof value === "number" && value >= 0 && value <= 1
const isChoice: Check<ChoiceConfig> = (value): value is ChoiceConfig =>
    isPlainObject(value) && isNonEmptyString(value.provider) && isNonEmptyString(value.model)

function integerAtLeast(min: number): Check<number> {
    return (value): value is number => Number.isInteger(value) && (value as number) >= min
}

function oneOf<T extends string>(values: readonly T[]): Check<T> {
    return (value): value is T =>
        typeof value === "string" && (values as readonly string[]).includes(value)
}

function pick<T>(
    name: string,
    value: unknown,
    fallback: T,
    valid: Check<T>,
    expected: string,
    warn: Warn,
): T {
    if (value === undefined) {
        return fallback
    }
    if (valid(value)) {
        return value
    }
    warn(`option "${name}" must be ${expected}; using default ${JSON.stringify(fallback)}`)
    return fallback
}

function choice(name: string, value: unknown, fallback: ChoiceConfig, warn: Warn): ChoiceConfig {
    if (value === undefined) {
        return fallback
    }
    const merged = isPlainObject(value) ? { ...fallback, ...value } : value
    if (isChoice(merged)) {
        return { provider: merged.provider, model: merged.model }
    }
    warn(
        `option "${name}" must be { provider, model } with non-empty strings; using default ${JSON.stringify(fallback)}`,
    )
    return fallback
}

function section(name: string, value: unknown, warn: Warn): Input {
    if (value === undefined) {
        return {}
    }
    if (isPlainObject(value)) {
        return value
    }
    warn(`option "${name}" must be an object; using defaults`)
    return {}
}

function taskTypeModels(
    value: unknown,
    warn: Warn,
): Partial<Record<RoutingTaskType, ChoiceConfig>> {
    const isTaskType = oneOf(ROUTING_TASK_TYPES)
    const result: Partial<Record<RoutingTaskType, ChoiceConfig>> = {}

    for (const [key, entry] of Object.entries(section("taskTypeModels", value, warn))) {
        if (!isTaskType(key)) {
            warn(`option "taskTypeModels.${key}" is not a known task type; ignored`)
            continue
        }
        if (!isChoice(entry)) {
            warn(
                `option "taskTypeModels.${key}" must be { provider, model } with non-empty strings; ignored`,
            )
            continue
        }
        result[key] = { provider: entry.provider, model: entry.model }
    }

    return result
}

function logLevel(input: Input, fallback: LogLevel, warn: Warn): LogLevel {
    let legacy: LogLevel | undefined
    if (input.logging !== undefined) {
        warn('option "logging" is deprecated; use "logLevel"')
        legacy = input.logging === true ? "info" : input.logging === false ? "off" : undefined
    }
    return pick(
        "logLevel",
        input.logLevel,
        legacy ?? fallback,
        oneOf(LOG_LEVELS),
        `one of ${LOG_LEVELS.join(", ")}`,
        warn,
    )
}

/**
 * Validate plugin options against the defaults. Never throws: every invalid
 * value is reported through `warn` and replaced by its default, so a typo in
 * user config degrades one option instead of disabling routing.
 */
export function normalizeConfig(options: unknown, warn: Warn = () => {}): RuntimeConfig {
    const base = defaults()

    if (options === undefined || options === null) {
        return base
    }
    if (!isPlainObject(options)) {
        warn("plugin options must be an object; using defaults")
        return base
    }

    for (const key of Object.keys(options)) {
        if (!KNOWN_OPTIONS.has(key)) {
            warn(`unknown option "${key}" ignored`)
        }
    }

    const previous = section("previousContext", options.previousContext, warn)
    const effort = section("reasoningEffort", options.reasoningEffort, warn)
    const nonNegative = integerAtLeast(0)

    const resolved: RuntimeConfig = {
        enabled: pick("enabled", options.enabled, base.enabled, isBoolean, "a boolean", warn),
        router: choice("router", options.router, base.router, warn),
        cheap: choice("cheap", options.cheap, base.cheap, warn),
        powerful: choice("powerful", options.powerful, base.powerful, warn),
        fallback: choice("fallback", options.fallback, base.fallback, warn),
        taskTypeModels: taskTypeModels(options.taskTypeModels, warn),
        minimumPromptLength: pick(
            "minimumPromptLength",
            options.minimumPromptLength,
            base.minimumPromptLength,
            nonNegative,
            "an integer >= 0",
            warn,
        ),
        minimumThresholdConfidence: pick(
            "minimumThresholdConfidence",
            options.minimumThresholdConfidence,
            base.minimumThresholdConfidence,
            isUnitInterval,
            "a number between 0 and 1",
            warn,
        ),
        timeoutMs: pick(
            "timeoutMs",
            options.timeoutMs,
            base.timeoutMs,
            integerAtLeast(1),
            "an integer >= 1",
            warn,
        ),
        ignoredPrefixes: pick(
            "ignoredPrefixes",
            options.ignoredPrefixes,
            base.ignoredPrefixes,
            isStringArray,
            "an array of strings",
            warn,
        ),
        ignoredAgents: pick(
            "ignoredAgents",
            options.ignoredAgents,
            base.ignoredAgents,
            isStringArray,
            "an array of strings",
            warn,
        ),
        previousContext: {
            enabled: pick(
                "previousContext.enabled",
                previous.enabled,
                base.previousContext.enabled,
                isBoolean,
                "a boolean",
                warn,
            ),
            maxPreviewChars: pick(
                "previousContext.maxPreviewChars",
                previous.maxPreviewChars,
                base.previousContext.maxPreviewChars,
                nonNegative,
                "an integer >= 0",
                warn,
            ),
            maxFiles: pick(
                "previousContext.maxFiles",
                previous.maxFiles,
                base.previousContext.maxFiles,
                nonNegative,
                "an integer >= 0",
                warn,
            ),
        },
        reasoningEffort: {
            providers: {
                ...base.reasoningEffort.providers,
                ...pick(
                    "reasoningEffort.providers",
                    effort.providers,
                    {},
                    isStringRecord,
                    "an object of strings",
                    warn,
                ),
            },
            values: {
                ...base.reasoningEffort.values,
                ...pick(
                    "reasoningEffort.values",
                    effort.values,
                    {},
                    isStringRecord,
                    "an object of strings",
                    warn,
                ),
            },
        },
        onError: pick(
            "onError",
            options.onError,
            base.onError,
            oneOf(ERROR_MODES),
            `one of ${ERROR_MODES.join(", ")}`,
            warn,
        ),
        statusCommand: pick(
            "statusCommand",
            options.statusCommand,
            base.statusCommand,
            isBoolean,
            "a boolean",
            warn,
        ),
        logLevel: logLevel(options, base.logLevel, warn),
        logFile: pick(
            "logFile",
            options.logFile,
            base.logFile,
            isNonEmptyString,
            "a non-empty string",
            warn,
        ),
    }

    if (resolved.statusCommand) {
        // The plugin's own commands must never be classified as prompts.
        for (const command of ["/jev", "/jev-off", "/jev-on"]) {
            if (!resolved.ignoredPrefixes.includes(command)) {
                resolved.ignoredPrefixes = [...resolved.ignoredPrefixes, command]
            }
        }
    }

    return resolved
}
