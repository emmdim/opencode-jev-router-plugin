# opencode-jev-router-plugin

[![CI](https://github.com/emmdim/opencode-jev-router-plugin/actions/workflows/ci.yml/badge.svg)](https://github.com/emmdim/opencode-jev-router-plugin/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/v/opencode-jev-router-plugin)](https://www.npmjs.com/package/opencode-jev-router-plugin)

OpenCode v2 plugin that routes every prompt to the cheapest model likely to
handle it. Before a prompt is admitted, the plugin sends it (mentions
stripped, file and skill sizes, a summary of the previous turn) to the
[JEV](https://openrouter.ai/typesafe/jev-1.13) classifier, asks six questions
in one call, switches the session model and maps the `effort` answer to the
target provider's reasoning option.

Routing is best-effort. Every failure is contained: the prompt is always
admitted, on the fallback model or on the current session model.

```
prompt ──► prompt hook ──► skip? (empty, prefix, agent, length, routing off) ──► yes: unchanged
                │
                ▼
     stored decision for this messageID? ──► yes: reuse (hook re-run)
                │ no
                ▼
     JEV classifier  POST {baseURL}/systemone  (one call, six questions)
                │
                ▼
     taskTypeModels[task_type] ─► trusted model_tier ─► fallback
                │
                ▼
     model registry check ─► fallback ─► keep session model
                │
                ▼
     save decision ─► switchModel ─► synthetic decision message
                                          │
context hook (per model call) ◄───────────┘
     model == routed model? ──► set reasoning option from `effort`
```

## Requirements

- OpenCode v2 (`@opencode/plugin` 2.x API).
- A router provider exposing the JEV `systemone` endpoint. The default is
  OpenRouter (`openrouter`), connected in OpenCode so the provider has a
  `baseURL`.
- An API key for the router provider (see [Credentials](#credentials)).
- Routed target models use OpenCode's normal provider auth. A target model
  that is not in the registry is never selected (see
  [Model resolution](#model-resolution)).

## Install

Add the package to `plugins` in `opencode.json(c)` (global or project):

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "plugins": ["opencode-jev-router-plugin@0.1.0"]
}
```

With options:

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "plugins": [
    {
      "package": "opencode-jev-router-plugin@0.1.0",
      "options": {
        "cheap": { "provider": "openrouter", "model": "qwen/qwen3.6-flash" },
        "powerful": { "provider": "openrouter", "model": "deepseek/deepseek-v4-pro-0813" },
        "fallback": { "provider": "openrouter", "model": "z-ai/glm-5.3-flash" },
        "taskTypeModels": {
          "review": { "provider": "anthropic", "model": "claude-sonnet-4-5" }
        },
        "logLevel": "info"
      }
    }
  ]
}
```

Pin a version. The plugin reacts to classifier output and switches models on
your behalf; an unpinned upgrade can change routing without notice.

From a checkout, point the entry at the built package:

```sh
git clone https://github.com/emmdim/opencode-jev-router-plugin
cd opencode-jev-router-plugin && bun install && bun run build
```

```jsonc
{ "plugins": ["/absolute/path/to/opencode-jev-router-plugin"] }
```

The package is compiled ESM with type declarations and has no runtime
dependencies. `@opencode/plugin` is an optional peer used for types only: the
emitted `index.d.ts` references it, so TypeScript consumers who type-check
against this package must have `@opencode/plugin` installed (OpenCode plugin
authors normally do). It is never loaded at runtime — the `dist/*.js` output
contains no SDK import.

To type your options without the SDK peer, import the config types from the
peer-independent subpath:

```ts
import type { PluginConfig } from "opencode-jev-router-plugin/config"
```

`opencode-jev-router-plugin/config` resolves to `dist/config.d.ts`, which has
no `@opencode/plugin` import. The root entry re-exports the same type for
convenience when the peer is present.

## Credentials

The router key is resolved per prompt; the first non-empty source wins:

| Order | Source | Notes |
| --- | --- | --- |
| 1 | `JEV_ROUTER_API_KEY` | Environment of the OpenCode service process. Useful in CI and containers. |
| 2 | OpenCode integration connection for `router.provider` | `ctx.integration.connection`; key credentials only, OAuth credentials are ignored. |
| 3 | `auth.json` entry for `router.provider` | `$XDG_DATA_HOME/opencode/auth.json` (default `~/.local/share/opencode/auth.json`), entry `type` `"api"` or `"key"`. |

A source that throws is logged at `warn` and skipped. With no key, routing
fails and `onError` applies. The key is sent only to
`{router baseURL}/systemone` as `Authorization: Bearer`. It is never logged.

## Configuration

All options are optional. Every option is validated when the plugin starts:
an invalid value is replaced by its default and logged at `warn` as
`config: option "<name>" must be <expected>; using default <value>`. Unknown
keys are logged and ignored. The plugin never fails to start because of its
options.

| Option | Type | Default | Description |
| --- | --- | --- | --- |
| `enabled` | boolean | `true` | `false` registers nothing. |
| `router` | `{provider, model}` | `openrouter` / `typesafe/jev-1.13` | Classifier provider and model. The provider supplies `baseURL` and the key. |
| `cheap` | `{provider, model}` | `openrouter` / `qwen/qwen3.6-flash` | Target for a trusted `model_tier: cheap`. |
| `powerful` | `{provider, model}` | `openrouter` / `deepseek/deepseek-v4-pro-0813` | Target for a trusted `model_tier: powerful`. |
| `fallback` | `{provider, model}` | `openrouter` / `z-ai/glm-5.3-flash` | Target for `default`, untrusted or missing tiers, unavailable targets and (with `onError: "fallback"`) failures. |
| `taskTypeModels` | `{[taskType]: {provider, model}}` | `{}` | Per-`task_type` override. Wins over the tier and ignores confidence. Unknown task types are dropped with a warning. |
| `minimumPromptLength` | integer ≥ 0 | `100` | Characters after mention stripping. Shorter prompts are not classified. |
| `minimumThresholdConfidence` | number in [0, 1] | `0.5` | Minimum `model_tier` confidence to trust the tier. |
| `timeoutMs` | integer ≥ 1 | `5000` | Classifier request timeout. |
| `ignoredPrefixes` | string[] | `["/help", "/models", "/connect", "/logout", "/clear", "/jev", "/jev-off", "/jev-on"]` | Prompts starting with one of these (after leading whitespace) are not classified. Replaces the default list; when `statusCommand` is true, the plugin's own commands are appended if absent. |
| `ignoredAgents` | string[] | `["title", "compaction"]` | Prompts mentioning one of these agents are not classified. Replaces the default list. |
| `previousContext.enabled` | boolean | `true` | Send a summary of the previous turn. |
| `previousContext.maxPreviewChars` | integer ≥ 0 | `240` | Length of the previous user and assistant text previews. |
| `previousContext.maxFiles` | integer ≥ 0 | `10` | Files listed for the previous turn. |
| `reasoningEffort.providers` | `{[providerID]: string}` | `{"openrouter": "reasoning_effort", "openai": "reasoningEffort"}` | Provider option key that receives the effort. Merged over the default; `""` opts a provider out. |
| `reasoningEffort.values` | `{[effort]: string}` | `{}` | Rewrite effort values, e.g. `{"high": "xhigh"}`. Merged over the default. |
| `onError` | `"fallback"` \| `"keep"` | `"fallback"` | On classifier or routing failure: switch to `fallback`, or leave the session model alone. |
| `statusCommand` | boolean | `true` | Register the `/jev`, `/jev-off` and `/jev-on` commands. |
| `logLevel` | `"off"` \| `"error"` \| `"warn"` \| `"info"` \| `"debug"` | `"warn"` | See [Logging](#logging). |
| `logFile` | string | `$XDG_STATE_HOME/opencode/jev-router.log` | Default `~/.local/state/opencode/jev-router.log`. |
| `logging` | boolean | — | Deprecated. `true` maps to `logLevel: "info"`, `false` to `"off"`. An explicit `logLevel` wins. |

Task types: `question`, `implementation`, `bugfix`, `refactor`, `review`,
`research`, `debugging`, `other`.

## Classifier questions

One request, six choice questions. Every answer is optional; a missing answer
degrades to the fallback path, never to an error. Wire format:
[docs/classifier-protocol.md](docs/classifier-protocol.md).

| Question | Choices | Used for |
| --- | --- | --- |
| `model_tier` | `cheap`, `default`, `powerful` | Target model (with confidence). |
| `task_type` | see above | `taskTypeModels` override. |
| `effort` | `low`, `medium`, `high` | Reasoning option on the routed model. |
| `reasoning_complexity` | `low`, `medium`, `high` | Recorded in the decision message. |
| `task_scope` | `single`, `multi`, `system` | Recorded in the decision message. |
| `ambiguity` | `low`, `medium`, `high` | Recorded in the decision message. |

The request carries: the prompt with `@file` and `@skill` mentions removed;
mentioned files with `min(ceil(bytes / 4), 200000)` token estimates (from
`stat`, contents are not read; directories and special files are sent without
a size);
mentioned skills with description and token estimate; the project directory;
and, with `previousContext.enabled`, the previous turn:

| Field | Content |
| --- | --- |
| `turnCount` | User messages before the current one (assistant messages are not counted). |
| `contextTokens` | Input + output + reasoning + cache-read + cache-write tokens of the previous assistant message. |
| `previous.userTextPreview` / `userTextTokens` | Whitespace-collapsed preview and token estimate of the previous user message. |
| `previous.files` / `fileCount` | Names from the previous user message plus the assistant's touched-file snapshot, deduplicated; `files` is capped at `maxFiles`, `fileCount` is the uncapped count. |
| `previous.assistant` | Model, agent, finish reason, cost, tool count, text preview and token breakdown of the previous answer. |

The whole `previous` block is sent only when the session already has a completed
assistant message; otherwise the conversation object is omitted.

## Model resolution

1. `taskTypeModels[task_type]` if configured.
2. `powerful` or `cheap` if `model_tier` is that value and its confidence is
   ≥ `minimumThresholdConfidence`.
3. `fallback` otherwise (`default` tier, low confidence, missing answer).

The result is checked against the OpenCode model registry. If it is not
registered, `fallback` is used; if `fallback` is not registered either, the
session model is kept. Each step logs at `warn`.

While routing is off for the session (`/jev-off`) nothing is resolved at all:
no classifier call, no model switch.

The decision is stored, the session is switched, and a synthetic message is
added to the transcript with `resume: false`:

- description (TUI one-liner):
  `⚡ jev: powerful (93%) · → openrouter/deepseek/deepseek-v4-pro-0813 · implementation · effort high · $0.00000240`
- text: a `[JEV ROUTING DECISION]` block with one `key: value` line per
  answer and the resolved model, readable by the model and by you.

OpenCode may run the prompt hook more than once for the same message. When
the stored decision has the same `messageID`, it is reused: no classifier
call, no usage increment, no second decision message.

## Reasoning effort

A context hook is registered per provider in `reasoningEffort.providers`
(provider-scoped, so other providers never call it). On each model call it
sets `options[<key>] = values[effort] ?? effort` only when all hold:

- the stored decision has an `effort` answer;
- the call's provider and model equal the model the router selected for that
  decision (so a manual `/models` switch, the fallback, or a kept session
  model never receives a stale effort);
- no earlier hook already set that option.

A prompt that is skipped (short, ignored prefix or agent), or a routing
failure that switches to `fallback`, clears the stored routed model, so no
effort is applied until the next classified prompt.

## `/jev`

Adds a synthetic message for the current session, `resume: false`, no model
call:

```text
[JEV ROUTER STATUS]
routing: on
requests: 2
input_tokens: 2400
output_tokens: 192
cost_usd: 0.00000480
last_message: msg_…
last_decided_at: 2026-10-02T10:15:00.000Z
last_model: openrouter/deepseek/deepseek-v4-pro-0813
model_tier: powerful (93%)
…
```

`last_model` is `session model kept` when no target was available, and the
block ends with `last_decision: none` before the first classification. Set
`statusCommand: false` to not register the command.

## `/jev-off` and `/jev-on`

`/jev-off` switches the router off for the current session: no classifier
call, no model switch, and the model chosen by hand is preserved.
`/jev-on` switches it back on. Both are per session and survive a plugin
reload; the state is stored in the plugin storage.

The toggle is also checked while a prompt is in flight. If `/jev-off` runs
while the classifier is answering, the pending model switch is dropped, so a
manual model is never overridden after the toggle was flipped.

`/jev` shows the current state (`routing: on` / `routing: off`).

## Failure semantics

| Situation | Classifier call | Model change | Log |
| --- | --- | --- | --- |
| Empty prompt, ignored prefix, ignored agent, too short | no | none | `debug` |
| Routing disabled for the session (`/jev-off`) | no | none | `debug` |
| Router provider missing or without `baseURL` | no | none | `warn` `provider … not found; skipping routing` |
| No key, timeout, HTTP error, malformed response | yes (except no key) | `fallback`, or none with `onError: "keep"` | `error` `jev routing failed; …` |
| Routed model not registered | yes | `fallback` | `warn` |
| Routed and fallback model not registered | yes | none | `warn` `… keeping the session model` |
| Prompt hook re-run for the same message | no | same as first run | `debug` |
| Switching to `fallback` fails | — | none | `error` `failed to switch to fallback model:` |

The hook never throws, so a routing problem never blocks a prompt.

## Storage

Plugin storage (`ctx.storage`), one entry per session:

| Key | Value |
| --- | --- |
| `jev/decision/<sessionID>` | `{sessionID, messageID, createdAt, response, resolved?: {provider, model}}`; last decision; `resolved` is absent when the session model was kept, after a skipped prompt, and after a routing failure. |
| `jev/usage/<sessionID>` | `{cost, inputTokens, outputTokens, requests, lastMessageID}`; classifier usage, counted once per message. |
| `jev/routing-disabled/<sessionID>` | `true` while `/jev-off` is active for the session; the entry is deleted by `/jev-on`. |

## Logging

| Level | Writes |
| --- | --- |
| `error` | Routing failures, fallback switch failures. |
| `warn` | Config warnings, missing provider, unavailable models, failing credential sources. |
| `info` | `routing decision:` per classified prompt (including a re-run that reuses a decision), `enabled; router <provider>/<model>`, `router API key from <source>`, `disabled by configuration`. |
| `debug` | Skip reasons and the full classifier request and response. |

> `debug` writes prompt text, file paths and previous-turn previews to the
> log file. Use it for reproduction only.

The log directory is created with mode `0700` when the plugin creates it, and
the file with `0600`. Write failures are swallowed; a write failure never
affects routing, and the first one also prints
`[jev-router] cannot write log file <path>` to stderr once.

```sh
tail -f ~/.local/state/opencode/jev-router.log | grep 'routing decision:'
```

## Troubleshooting

| Symptom | Check |
| --- | --- |
| Model never changes | `logLevel: "debug"`; look for `skipped:` lines (prompt shorter than `minimumPromptLength`, ignored prefix) or `provider … not found`. |
| Always on the fallback model | `error` lines `jev routing failed`: missing key, HTTP status from `systemone`, timeout (raise `timeoutMs`). Low `model_tier` confidence also resolves to fallback. |
| `… is not available; trying fallback` | Target model ID is not in the OpenCode registry; fix `cheap`/`powerful`/`taskTypeModels`. |
| Effort not applied | Provider key missing or `""` in `reasoningEffort.providers`; current model differs from the routed one; another hook set the option first. |
| `config: option …` warnings | Value replaced by its default; fix the option. |
| No log file | `logLevel: "off"`, or the parent of `logFile` is not writable (the first failed write prints `[jev-router] cannot write log file <path>` to stderr). |

## Migrating from upstream

| Upstream | Here |
| --- | --- |
| `"plugins": ["./plugins/jev-router/src"]` | `"plugins": ["opencode-jev-router-plugin@<version>"]` |
| `logging: true` (default, all levels) | `logLevel: "warn"` default; `logging` still accepted. |
| Log file `/tmp/opencode/jev-router.log` | `$XDG_STATE_HOME/opencode/jev-router.log` |
| Key only from `~/.local/share/opencode/auth.json`, `type: "api"` | Env → integration → XDG-aware `auth.json` (`api` or `key`). |
| Invalid options used as-is | Validated, defaults with warnings. |
| Effort applied to every model call | Only to the routed model, never overriding earlier hooks. |
| Hook re-runs reclassify and double-count usage | Decision reused, usage counted once. |

## Development

Requires Bun (tests) and Node ≥ 20 (package checks).

```sh
bun install
bun test                     # all tests
bun test test/router.test.ts # one file
bun test -t "re-run"         # by name
bun run typecheck
bun run lint                 # bun run format to fix
bun run build                # dist/
bun run check:package        # publint + attw
bun run smoke                # npm-install the packed tarball, import it in Node
```

See [CONTRIBUTING.md](CONTRIBUTING.md).

## Credits

Derived from
[flower-of-the-bridges/opencode-jev-router-plugin](https://github.com/flower-of-the-bridges/opencode-jev-router-plugin)
by Giovanni Fiordeponti, which designed the routing flow, the classifier
questions and the decision display. This repository adds packaging,
validation, credential handling, idempotence, effort scoping and the status
command.

## License

[MIT](LICENSE)
