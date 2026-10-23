import type { Plugin } from "@opencode/plugin"
import { authFileSource, envSource, integrationSource, resolveApiKey } from "./auth.ts"
import { createStatusCommand, createToggleCommand } from "./command.ts"
import { normalizeConfig } from "./config.ts"
import { createEffortHook, effortProviders } from "./effort.ts"
import { initLogger } from "./logger.ts"
import { createPromptRouter } from "./router.ts"

export type { PluginConfig } from "./config.ts"

const PLUGIN_ID = "opencode-jev-router-plugin"

const plugin: Plugin.Plugin = {
    id: PLUGIN_ID,
    async setup(ctx) {
        const warnings: string[] = []
        const config = normalizeConfig(ctx.options, (message) => warnings.push(message))
        const logger = initLogger(PLUGIN_ID, { logLevel: config.logLevel, logFile: config.logFile })
        for (const warning of warnings) {
            logger.warn("config:", warning)
        }

        if (!config.enabled) {
            logger.info("disabled by configuration")
            return
        }

        const onPrompt = createPromptRouter({
            config,
            logger,
            storage: ctx.storage,
            session: ctx.session,
            getRouterBaseUrl: async () => {
                const provider = await ctx.provider.get({ providerID: config.router.provider })
                return provider?.data?.settings?.baseURL
            },
            getRouterApiKey: async () => {
                const resolved = await resolveApiKey(
                    [
                        envSource(),
                        integrationSource(ctx.integration.connection, config.router.provider),
                        authFileSource(config.router.provider),
                    ],
                    (source, error) => logger.warn(`credential source ${source} failed:`, error),
                )
                if (resolved) {
                    logger.info("router API key from", resolved.source)
                }
                return resolved?.key
            },
            listSkills: async () => (await ctx.skill.list()).data ?? [],
            repository: ctx.location.project?.canonical,
            modelAvailable: async (providerID, modelID) => {
                const models = (await ctx.model.list()).data ?? []
                return models.some(
                    (model) => model.providerID === providerID && model.modelID === modelID,
                )
            },
            fetchImpl: fetch,
        })
        const onContext = createEffortHook({ config, logger, storage: ctx.storage })

        const registrations: Array<Awaited<ReturnType<typeof ctx.session.hook>>> = []

        try {
            registrations.push(await ctx.session.hook("prompt", onPrompt))
            for (const providerID of effortProviders(config)) {
                registrations.push(await ctx.session.hook("context", onContext, { providerID }))
            }
            if (config.statusCommand) {
                const commands = [
                    createStatusCommand({
                        storage: ctx.storage,
                        session: ctx.session,
                        logger,
                    }),
                    createToggleCommand({
                        storage: ctx.storage,
                        session: ctx.session,
                        logger,
                        disabled: true,
                    }),
                    createToggleCommand({
                        storage: ctx.storage,
                        session: ctx.session,
                        logger,
                        disabled: false,
                    }),
                ]
                registrations.push(
                    await ctx.command.transform((editor) => {
                        for (const command of commands) {
                            editor.add(command)
                        }
                    }),
                )
            }
        } catch (error) {
            await Promise.allSettled(registrations.map((registration) => registration.dispose()))
            throw error
        }

        logger.info("enabled; router", `${config.router.provider}/${config.router.model}`)

        return async () => {
            await Promise.allSettled(registrations.map((registration) => registration.dispose()))
        }
    },
}

export default plugin
