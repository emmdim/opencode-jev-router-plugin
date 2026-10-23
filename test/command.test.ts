import { describe, expect, test } from "bun:test"
import { createStatusCommand, createToggleCommand } from "../src/command.ts"
import { isRoutingDisabled, saveDecision, setRoutingDisabled } from "../src/decision.ts"
import { noopLogger } from "../src/logger.ts"
import { addUsage } from "../src/usage.ts"
import { FakeStorage, makeStoredDecision } from "./support/harness.ts"

type Published = { sessionID: string; text: string; description?: string; resume?: boolean }

describe("/jev command", () => {
    test("publishes the session status", async () => {
        const storage = new FakeStorage()
        await saveDecision(storage, makeStoredDecision())
        await addUsage(storage, "ses_test", "msg_1", {
            input_tokens: 1200,
            output_tokens: 96,
            cost: 0.0000024,
        })
        const published: Published[] = []
        const command = createStatusCommand({
            storage,
            logger: noopLogger,
            session: {
                synthetic: async (input) => {
                    published.push(input)
                },
            },
        })

        expect(command.name).toBe("jev")
        await command.execute({ sessionID: "ses_test" })

        expect(published).toHaveLength(1)
        expect(published[0]).toMatchObject({ sessionID: "ses_test", resume: false })
        expect(published[0]?.text).toContain("requests: 1")
        expect(published[0]?.description).toStartWith("⚡ jev: 1 classifier call ·")
    })

    test("logs instead of throwing when publishing fails", async () => {
        const errors: unknown[][] = []
        const command = createStatusCommand({
            storage: new FakeStorage(),
            logger: { ...noopLogger, error: (...args: unknown[]) => errors.push(args) },
            session: {
                synthetic: async () => {
                    throw new Error("session gone")
                },
            },
        })

        await expect(command.execute({ sessionID: "ses_test" })).resolves.toBeUndefined()
        await Bun.sleep(0)
        expect(errors).toHaveLength(1)
    })

    test("reports the routing toggle state", async () => {
        const storage = new FakeStorage()
        await setRoutingDisabled(storage, "ses_test", true)

        const published: Published[] = []
        const command = createStatusCommand({
            storage,
            logger: noopLogger,
            session: {
                synthetic: async (input) => {
                    published.push(input)
                },
            },
        })

        await command.execute({ sessionID: "ses_test" })

        expect(published[0]?.text).toContain("routing: off")
        expect(published[0]?.description).toContain("routing off")
    })
})

describe("/jev-off and /jev-on", () => {
    test("disables and re-enables routing for the session", async () => {
        const storage = new FakeStorage()
        const published: Published[] = []
        const deps = {
            storage,
            logger: noopLogger,
            session: {
                synthetic: async (input: Published) => {
                    published.push(input)
                },
            },
        }

        const off = createToggleCommand({ ...deps, disabled: true })
        const on = createToggleCommand({ ...deps, disabled: false })

        expect(off.name).toBe("jev-off")
        expect(on.name).toBe("jev-on")

        await off.execute({ sessionID: "ses_test" })
        expect(await isRoutingDisabled(storage, "ses_test")).toBe(true)
        expect(published[0]?.text).toContain("disabled")
        expect(published[0]?.resume).toBe(false)

        await on.execute({ sessionID: "ses_test" })
        expect(await isRoutingDisabled(storage, "ses_test")).toBe(false)
        expect(published[1]?.text).toContain("enabled")
    })

    test("reports a failure in the session instead of only logging it", async () => {
        const published: Published[] = []
        const errors: unknown[][] = []
        const command = createToggleCommand({
            storage: {
                get: async () => undefined,
                set: async () => {
                    throw new Error("storage offline")
                },
            },
            logger: { ...noopLogger, error: (...args: unknown[]) => errors.push(args) },
            session: {
                synthetic: async (input) => {
                    published.push(input)
                },
            },
            disabled: true,
        })

        await expect(command.execute({ sessionID: "ses_test" })).resolves.toBeUndefined()
        expect(errors).toHaveLength(1)
        expect(published[0]?.text).toContain("command failed")
        expect(published[0]?.text).toContain("storage offline")
    })
})
