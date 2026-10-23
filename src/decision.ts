import type { ChoiceConfig, RuntimeConfig } from "./config.ts"
import type { JevRoutingResponse, ModelTier, RoutingTaskType } from "./jev.ts"

/**
 * Minimal storage contract satisfied by the plugin's `ctx.storage`.
 * Keeps this module free of SDK imports so tests can pass a plain map.
 */
export interface JsonStorage {
    get(key: string): Promise<unknown>
    set(key: string, value: unknown): Promise<void>
    /** Optional delete; used to drop the routing toggle instead of storing false. */
    remove?(key: string): Promise<void>
}

/**
 * The latest decision for a session. One entry per session: each new prompt
 * overwrites it, and persistence via storage survives plugin reloads.
 */
export interface StoredDecision {
    sessionID: string
    messageID: string
    createdAt: number
    response: JevRoutingResponse
    /** Model the session was switched to; absent when the session model was kept. */
    resolved?: ChoiceConfig
}

export const DECISION_KEY_PREFIX = "jev/decision/"

export function decisionKey(sessionID: string): string {
    return `${DECISION_KEY_PREFIX}${sessionID}`
}

/** Per-session routing toggle. Absent means routing is enabled. */
export const ROUTING_DISABLED_KEY_PREFIX = "jev/routing-disabled/"

export function routingDisabledKey(sessionID: string): string {
    return `${ROUTING_DISABLED_KEY_PREFIX}${sessionID}`
}

/** True when routing is switched off for the session. */
export async function isRoutingDisabled(storage: JsonStorage, sessionID: string): Promise<boolean> {
    return (await storage.get(routingDisabledKey(sessionID))) === true
}

/** Switch routing off or on for the session. */
export async function setRoutingDisabled(
    storage: JsonStorage,
    sessionID: string,
    disabled: boolean,
): Promise<void> {
    const key = routingDisabledKey(sessionID)

    if (!disabled) {
        // Prefer deleting the key; fall back to an explicit false value.
        if (typeof storage.remove === "function") {
            await storage.remove(key)
            return
        }
        await storage.set(key, false)
        return
    }

    await storage.set(key, true)
}

export async function saveDecision(storage: JsonStorage, decision: StoredDecision): Promise<void> {
    await storage.set(decisionKey(decision.sessionID), decision)
}

export async function loadDecision(
    storage: JsonStorage,
    sessionID: string,
): Promise<StoredDecision | undefined> {
    const stored = await storage.get(decisionKey(sessionID))

    if (
        typeof stored !== "object" ||
        stored === null ||
        typeof (stored as StoredDecision).response !== "object" ||
        (stored as StoredDecision).response === null
    ) {
        return undefined
    }

    return stored as StoredDecision
}

export interface TierPick {
    tier?: ModelTier
    confidence?: number
    /** False when the answer is missing or below the configured confidence floor. */
    trusted: boolean
}

/**
 * Extract the model tier, applying the configured confidence floor.
 * Below the floor the tier is reported but not trusted.
 */
export function pickTier(config: RuntimeConfig, response: JevRoutingResponse): TierPick {
    const answer = response.answers.model_tier

    if (!answer) {
        return { trusted: false }
    }

    const trusted = answer.confidence >= config.minimumThresholdConfidence

    return { tier: answer.choice, confidence: answer.confidence, trusted }
}

/**
 * Resolve the model for a decision:
 *
 * 1. a configured per-task-type override, when the classifier returned a
 *    task type the user mapped in `taskTypeModels`;
 * 2. otherwise the tier model (`powerful`/`cheap`), when the tier answer is
 *    trusted;
 * 3. otherwise the fallback/default model.
 */
export function resolveModel(
    config: RuntimeConfig,
    response: JevRoutingResponse,
): { model: string; provider: string; tier: TierPick; taskType?: RoutingTaskType } {
    const tier = pickTier(config, response)
    const taskType = response.answers.task_type?.choice

    const override = taskType ? config.taskTypeModels[taskType] : undefined

    if (override) {
        return { model: override.model, provider: override.provider, tier, taskType }
    }

    if (tier.trusted && tier.tier === "powerful") {
        return { model: config.powerful.model, provider: config.powerful.provider, tier, taskType }
    }

    if (tier.trusted && tier.tier === "cheap") {
        return { model: config.cheap.model, provider: config.cheap.provider, tier, taskType }
    }

    return { model: config.fallback.model, provider: config.fallback.provider, tier, taskType }
}
