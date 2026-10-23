import {
    isRoutingDisabled,
    type JsonStorage,
    loadDecision,
    setRoutingDisabled,
} from "./decision.ts"
import { describeStatus, formatStatus } from "./display.ts"
import type { Logger } from "./logger.ts"
import { getUsage } from "./usage.ts"

export interface StatusCommandDeps {
    storage: JsonStorage
    logger: Logger
    session: {
        synthetic(input: {
            sessionID: string
            text: string
            description?: string
            resume?: boolean
        }): Promise<unknown>
    }
}

export interface StatusCommand {
    name: string
    description: string
    execute(input: { sessionID: string }): Promise<void>
}

export function createStatusCommand({
    storage,
    logger,
    session,
}: StatusCommandDeps): StatusCommand {
    return {
        name: "jev",
        description: "Show JEV router usage and the last routing decision for this session",
        async execute({ sessionID }) {
            try {
                const [decision, usage, routingEnabled] = await Promise.all([
                    loadDecision(storage, sessionID),
                    getUsage(storage, sessionID),
                    isRoutingEnabled(storage, sessionID),
                ])
                const options = { routingEnabled }
                await session.synthetic({
                    sessionID,
                    text: formatStatus(decision, usage, options),
                    description: describeStatus(decision, usage, options),
                    resume: false,
                })
            } catch (error) {
                logger.error("/jev failed:", error)
            }
        },
    }
}

export interface ToggleCommandDeps extends StatusCommandDeps {
    /** True builds the `/jev-off` command, false the `/jev-on` command. */
    disabled: boolean
}

/**
 * `/jev-off` and `/jev-on` switch the router for one session. While routing is
 * off the plugin never changes the model, so a model chosen by hand stays.
 */
export function createToggleCommand({
    storage,
    logger,
    session,
    disabled,
}: ToggleCommandDeps): StatusCommand {
    const name = disabled ? "jev-off" : "jev-on"

    return {
        name,
        description: disabled
            ? "Disable JEV routing for this session and keep the selected model"
            : "Re-enable JEV routing for this session",
        async execute({ sessionID }) {
            try {
                await setRoutingDisabled(storage, sessionID, disabled)
                const text = disabled
                    ? "JEV routing disabled for this session. The model you select manually is preserved. Use /jev-on to re-enable."
                    : "JEV routing enabled for this session. The next prompt may switch models automatically."
                await session.synthetic({
                    sessionID,
                    text,
                    description: disabled ? "JEV routing disabled" : "JEV routing enabled",
                    resume: false,
                })
            } catch (error) {
                logger.error(`/${name} failed:`, error)
                await reportFailure(session, sessionID, error)
            }
        },
    }
}

/** True unless the session switched routing off. */
async function isRoutingEnabled(storage: JsonStorage, sessionID: string): Promise<boolean> {
    return !(await isRoutingDisabled(storage, sessionID))
}

/**
 * Surface a command failure in the TUI. The log alone is invisible to the
 * user, and a failed toggle would silently keep the old routing state.
 */
async function reportFailure(
    session: StatusCommandDeps["session"],
    sessionID: string,
    error: unknown,
): Promise<void> {
    const message = error instanceof Error ? error.message : String(error)
    try {
        await session.synthetic({
            sessionID,
            text: `JEV router: command failed — ${message}`,
            description: "jev command failed",
            resume: false,
        })
    } catch {
        // The session may already be gone; the logger has the error.
    }
}
