import type { RuntimeConfig } from "./config.ts"
import {
    isRoutingDisabled,
    type JsonStorage,
    loadDecision,
    resolveModel,
    saveDecision,
} from "./decision.ts"
import { describeDecision, formatDecisionBlock } from "./display.ts"
import { buildConversation, type HistoryMessage } from "./history.ts"
import {
    askJev,
    buildJevRequest,
    type FetchLike,
    type JevRoutingResponse,
    type RoutingConversation,
    type RoutingFile,
    type RoutingSkill,
} from "./jev.ts"
import type { Logger } from "./logger.ts"
import { estimateFileTokens, estimateTokens, type Mention, stripMentions } from "./text.ts"
import { addUsage } from "./usage.ts"

export interface PromptEvent {
    readonly sessionID: string
    readonly messageID: string
    prompt: {
        text: string
        files?: Array<{
            uri: string
            name?: string
            mention?: Mention
        }>
        skills?: Array<{
            id: string
            mention?: Mention
        }>
        agents?: Array<{
            name: string
            mention?: Mention
        }>
    }
}

export interface PromptRouterDeps {
    config: RuntimeConfig
    logger: Logger
    storage: JsonStorage
    session: {
        switchModel(input: {
            sessionID: string
            model: { providerID: string; id: string }
        }): Promise<void>
        synthetic(input: {
            sessionID: string
            text: string
            description?: string
            resume?: boolean
        }): Promise<unknown>
        context(input: { sessionID: string }): Promise<readonly HistoryMessage[]>
    }
    /** Base URL of the provider hosting the JEV classifier, or undefined. */
    getRouterBaseUrl: () => Promise<string | undefined>
    /** API key for the router provider, or undefined. */
    getRouterApiKey: () => Promise<string | undefined>
    listSkills: () => Promise<Array<{ id: string; description?: string; content?: string }>>
    /** Canonical project directory, sent as classifier context. */
    repository?: string
    /** Registry check for a resolved model; when it reports false the plugin uses the fallback. */
    modelAvailable?: (providerID: string, modelID: string) => Promise<boolean>
    fetchImpl?: FetchLike
}

interface Classification {
    response: JevRoutingResponse
    conversation?: RoutingConversation
}

/**
 * Create the `session.hook("prompt", ...)` handler. The hook must never
 * throw: prompt admission fails otherwise, so every routing error is
 * contained and handled according to `onError`.
 */
export function createPromptRouter(deps: PromptRouterDeps) {
    const { config, logger, storage, session } = deps
    const inFlight = new Map<string, Promise<void>>()

    /** Forget the routed model so a skipped turn cannot apply stale effort. */
    async function clearRouted(sessionID: string): Promise<void> {
        const previous = await loadDecision(storage, sessionID)
        if (previous?.resolved) {
            await saveDecision(storage, { ...previous, resolved: undefined })
        }
    }

    /**
     * Toggle state for the session. A storage failure must never break prompt
     * admission, so an unreadable flag is treated as "routing enabled".
     */
    async function routingDisabled(sessionID: string): Promise<boolean> {
        try {
            return await isRoutingDisabled(storage, sessionID)
        } catch (error) {
            logger.warn("could not read the routing toggle:", error)
            return false
        }
    }

    return async function onPrompt(event: PromptEvent): Promise<void> {
        const { sessionID, messageID } = event
        const key = `${sessionID}:${messageID}`

        // Concurrent submissions of the same message share one classification.
        const pending = inFlight.get(key)
        if (pending) {
            await pending
            return
        }

        const task = run(event)
        inFlight.set(key, task)
        try {
            await task
        } finally {
            inFlight.delete(key)
        }
    }

    async function run(event: PromptEvent): Promise<void> {
        const { sessionID, prompt } = event
        const text = prompt.text ?? ""

        if (!text.trim()) {
            logger.debug("skipped: empty prompt")
            await clearRouted(sessionID)
            return
        }

        if (await routingDisabled(sessionID)) {
            logger.debug("skipped: routing disabled for session")
            await clearRouted(sessionID)
            return
        }

        const trimmedText = text.trimStart()
        if (config.ignoredPrefixes.some((prefix) => trimmedText.startsWith(prefix))) {
            logger.debug("skipped: ignored prefix", trimmedText.slice(0, 32))
            await clearRouted(sessionID)
            return
        }

        const mentionedAgents = prompt.agents ?? []
        if (mentionedAgents.some((agent) => config.ignoredAgents.includes(agent.name))) {
            logger.debug(
                "skipped: ignored agent mention",
                mentionedAgents.map((agent) => agent.name),
            )
            await clearRouted(sessionID)
            return
        }

        try {
            const routerBaseUrl = await deps.getRouterBaseUrl()
            if (!routerBaseUrl) {
                logger.warn(`provider ${config.router.provider} not found; skipping routing`)
                await clearRouted(sessionID)
                return
            }
            await routePrompt(event, routerBaseUrl)
        } catch (error: unknown) {
            if (await routingDisabled(sessionID)) {
                logger.debug("skipped fallback switch: routing disabled for session")
                await clearRouted(sessionID)
                return
            }
            if (config.onError === "keep") {
                logger.error("jev routing failed; keeping the session model:", error)
                await clearRouted(sessionID)
                return
            }
            logger.error("jev routing failed; using fallback:", error)
            try {
                await session.switchModel({
                    sessionID,
                    model: { providerID: config.fallback.provider, id: config.fallback.model },
                })
            } catch (switchError) {
                logger.error("failed to switch to fallback model:", switchError)
            }
            await clearRouted(sessionID)
        }
    }

    async function routePrompt(event: PromptEvent, routerBaseUrl: string): Promise<void> {
        const { messageID, sessionID, prompt } = event

        // Collect mentions first, then strip them in one pass so offsets stay valid.
        const mentions: Mention[] = [
            ...(prompt.skills ?? []).map((skill) => skill.mention),
            ...(prompt.files ?? []).map((file) => file.mention),
        ].filter((mention): mention is Mention => mention !== undefined)

        const userMessage = stripMentions(prompt.text ?? "", mentions)
        if (userMessage.trim().length < config.minimumPromptLength) {
            logger.debug("skipped: prompt too short after mention stripping", userMessage.length)
            await clearRouted(sessionID)
            return
        }

        // OpenCode can re-run the prompt hook for the same message; reuse the
        // decision instead of paying for a second classification.
        const previous = await loadDecision(storage, sessionID)
        const reused = previous?.messageID === messageID

        let response: JevRoutingResponse
        let conversation: RoutingConversation | undefined
        if (reused) {
            logger.debug("prompt hook re-run; reusing decision for", messageID)
            response = previous.response
        } else {
            const classification = await classify(event, userMessage, routerBaseUrl)
            response = classification.response
            conversation = classification.conversation
            await addUsage(storage, sessionID, messageID, response.usage)
        }

        let { model, provider, tier } = resolveModel(config, response)
        let keepSessionModel = false

        if (deps.modelAvailable && !(await deps.modelAvailable(provider, model))) {
            logger.warn(`resolved model ${provider}/${model} is not available; trying fallback`)
            if (await deps.modelAvailable(config.fallback.provider, config.fallback.model)) {
                provider = config.fallback.provider
                model = config.fallback.model
            } else {
                logger.warn(
                    `fallback model ${config.fallback.provider}/${config.fallback.model} is also unavailable; keeping the session model`,
                )
                keepSessionModel = true
            }
        }

        // Saved before the switch so the effort hook sees it on the next model call.
        await saveDecision(storage, {
            sessionID,
            messageID,
            createdAt: reused && previous ? previous.createdAt : Date.now(),
            response,
            resolved: keepSessionModel ? undefined : { provider, model },
        })

        const description = describeDecision(response, { provider, model }, tier)
        logger.info("routing decision:", description)

        if (!keepSessionModel) {
            // The toggle may have flipped while the classifier was running:
            // never override a manually chosen model after /jev-off.
            if (await routingDisabled(sessionID)) {
                logger.debug("skipped model switch: routing disabled for session")
                await clearRouted(sessionID)
                return
            }
            await session.switchModel({ sessionID, model: { providerID: provider, id: model } })
        }

        if (reused) {
            return
        }

        await session.synthetic({
            sessionID,
            text: formatDecisionBlock({
                response,
                resolved: { provider, model },
                tier,
                conversation,
            }),
            description,
            resume: false,
        })
        logger.debug("published routing decision")
    }

    async function classify(
        event: PromptEvent,
        userMessage: string,
        routerBaseUrl: string,
    ): Promise<Classification> {
        const { messageID, sessionID, prompt } = event

        const apiKey = await deps.getRouterApiKey()
        if (!apiKey) {
            throw new Error("no API key available for the router provider")
        }

        const ctxSkills = await deps.listSkills()
        const routingSkills: RoutingSkill[] = (prompt.skills ?? []).map((skill) => {
            const ctxSkill = ctxSkills.find((entry) => entry.id === skill.id)
            return {
                name: skill.id,
                description: ctxSkill?.description ?? "",
                estimatedTokenSize: ctxSkill?.content
                    ? estimateTokens(ctxSkill.content)
                    : undefined,
            }
        })

        const routingFiles: RoutingFile[] = await Promise.all(
            (prompt.files ?? []).map(async (file) => {
                let estimatedTokenSize: number | undefined
                try {
                    estimatedTokenSize = await estimateFileTokens(file.uri)
                } catch (error) {
                    // Missing or unreadable files are sent without a size.
                    logger.debug("could not estimate token size for", file.uri, error)
                }
                return { path: file.name ?? file.uri, estimatedTokenSize }
            }),
        )

        const conversation = config.previousContext.enabled
            ? buildConversation(await session.context({ sessionID }), {
                  currentMessageID: messageID,
                  maxPreviewChars: config.previousContext.maxPreviewChars,
                  maxFiles: config.previousContext.maxFiles,
              })
            : undefined

        const jevRequest = buildJevRequest({
            model: config.router.model,
            userMessage,
            files: routingFiles,
            skills: routingSkills,
            conversation,
            executionContext: { repository: deps.repository },
        })

        logger.debug("sending jev request", jevRequest)
        const response = await askJev(jevRequest, {
            baseUrl: routerBaseUrl,
            apiKey,
            timeoutMs: config.timeoutMs,
            fetchImpl: deps.fetchImpl,
        })
        logger.debug("received jev response", response)

        return { response, conversation }
    }
}
