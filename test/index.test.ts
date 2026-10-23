import { describe, expect, test } from "bun:test"
import plugin, * as entry from "../src/index.ts"
import { FakeStorage } from "./support/harness.ts"

type Context = Parameters<typeof plugin.setup>[0]

/**
 * Only the parts of the OpenCode context the plugin touches. The fake is typed
 * against this so its fields are checked against the SDK's shapes, and `Context`
 * is assignable to `SetupContext` so the single cast to `Context` is sound.
 */
type SetupContext = {
    options: Context["options"]
    location: { project: { canonical: string } | undefined }
    storage: { get(key: string): Promise<unknown> }
    provider: { get(...args: never[]): Promise<unknown> }
    skill: { list(...args: never[]): Promise<{ data: readonly unknown[] }> }
    model: {
        list(
            ...args: never[]
        ): Promise<{ data: readonly { providerID: string; modelID: string }[] }>
    }
    integration: {
        connection: {
            active(...args: never[]): Promise<unknown>
            resolve(...args: never[]): Promise<unknown>
        }
    }
    session: {
        hook(...args: never[]): Promise<{ dispose(): Promise<void> | void }>
        switchModel(...args: never[]): Promise<unknown>
        synthetic(...args: never[]): Promise<unknown>
        context(...args: never[]): Promise<readonly unknown[]>
    }
    command: {
        transform(...args: never[]): Promise<{ dispose(): Promise<void> | void }>
    }
}

function fakeContext(options: Record<string, unknown>) {
    const hooks: Array<{ name: string; providerID?: string }> = []
    const commands: string[] = []
    let disposed = 0
    const registration = () => ({
        dispose: async () => {
            disposed += 1
        },
    })

    const ctx: SetupContext = {
        options: { logLevel: "off", ...options },
        storage: new FakeStorage(),
        location: { project: { canonical: "/repo" } },
        session: {
            hook: async (name: string, _callback: unknown, scope?: { providerID?: string }) => {
                hooks.push({ name, providerID: scope?.providerID })
                return registration()
            },
            switchModel: async () => {},
            synthetic: async () => {},
            context: async () => [],
        },
        command: {
            transform: async (
                edit: (editor: { add(definition: { name: string }): void }) => void,
            ) => {
                edit({ add: (definition) => commands.push(definition.name) })
                return registration()
            },
        },
        provider: { get: async () => undefined },
        skill: { list: async () => ({ data: [] }) },
        model: { list: async () => ({ data: [] }) },
        integration: {
            connection: { active: async () => undefined, resolve: async () => undefined },
        },
    }

    return { ctx: ctx as Context, hooks, commands, disposed: () => disposed }
}

describe("plugin entrypoint", () => {
    test("exposes only a default runtime export", () => {
        expect(Object.keys(entry)).toEqual(["default"])
        expect(plugin.id).toBe("opencode-jev-router-plugin")
    })

    test("registers the prompt hook, scoped context hooks and the /jev commands, and disposes them", async () => {
        const fake = fakeContext({})

        const cleanup = await plugin.setup(fake.ctx)

        expect(fake.hooks).toEqual([
            { name: "prompt", providerID: undefined },
            { name: "context", providerID: "openrouter" },
            { name: "context", providerID: "openai" },
        ])
        expect(fake.commands).toEqual(["jev", "jev-off", "jev-on"])
        expect(typeof cleanup).toBe("function")
        if (typeof cleanup === "function") {
            await cleanup()
        }
        expect(fake.disposed()).toBe(4)
    })

    test("registers nothing when disabled", async () => {
        const fake = fakeContext({ enabled: false })

        expect(await plugin.setup(fake.ctx)).toBeUndefined()
        expect(fake.hooks).toEqual([])
        expect(fake.commands).toEqual([])
    })

    test("skips /jev when statusCommand is false", async () => {
        const fake = fakeContext({ statusCommand: false })

        const cleanup = await plugin.setup(fake.ctx)

        expect(fake.commands).toEqual([])
        expect(typeof cleanup).toBe("function")
        if (typeof cleanup === "function") {
            await cleanup()
        }
        expect(fake.disposed()).toBe(3)
    })

    test("skips context hooks for providers disabled with an empty option key", async () => {
        const fake = fakeContext({ reasoningEffort: { providers: { openai: "" } } })

        await plugin.setup(fake.ctx)

        expect(fake.hooks.map((hook) => hook.providerID)).toEqual([undefined, "openrouter"])
    })
})
