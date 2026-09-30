# Claude Code effort routing

The `Agent` tool takes a `model` but no effort. Claude Code applies effort only through a subagent definition's `effort:` frontmatter, so a role entry with explicit effort needs a generated agent that carries both its model and its effort. An entry without effort needs nothing new: keep the calling skill's `subagent_type` and pass `model` on the call, or omit `model` for `inherit-parent` and `auto`.

## Install and check the routes

Select the active sheet using [configuration scope](model-dispatch.md#configuration-scope). The agents directory follows the same scope: `<project-root>/.claude` for a project sheet, `~/.claude` for a user sheet.

Run the bundled `../scripts/claude-agents.mjs` helper with explicit absolute paths:

```sh
node /path/to/poteto-mode/scripts/claude-agents.mjs --mapping /path/to/pstack-models.md --config-dir /path/to/.claude --install
```

The helper writes one `pstack-<model>-<effort>` agent per distinct effort-bearing pair, with `model:` and `effort:` frontmatter, and a `pstack-routing.json` manifest in the config directory. It uses the shared resolver, so inline `model@effort` wins over `effort: model = value`, and `@default` clears both. Effort must be one of `low`, `medium`, `high`, `xhigh`, `max`; anything else fails the install. Explicit effort on `inherit-parent` or `auto` becomes an agent with `model: inherit`. An entry with a `codex:` or other foreign `harness:` prefix installs no agent. A `claude:` entry is native here and installs like an unprefixed one. The helper refuses to overwrite agents or a manifest it did not generate. Rerun the install whenever the sheet changes; generated agents from old mappings stay on disk, but only current routes are used.

A running session may not see newly installed agents: the `Agent` tool rejects an unknown `subagent_type` and lists the agents it knows. If a routed agent is missing from that list, report that the agents are installed but usable from the next session, and do not fall back to a generic agent with prompt-text effort.

## Launch by role

Before spawning, resolve the calling skill's role:

```sh
node /path/to/poteto-mode/scripts/claude-agents.mjs --mapping /path/to/pstack-models.md --config-dir /path/to/.claude --role "arena runners"
```

The helper fails if the installed agents do not match the current sheet. Each returned entry has `agent`, `model`, and `effort`:

- `agent` set: call `Agent` with `subagent_type` set to that agent and **no** `model` parameter. A per-call `model` overrides the definition's `model:` frontmatter. Keep the calling skill's task, specialist prompt, file pointers, and background behavior in the brief, because the generated agent is a generic pstack worker.
- `agent` null and `pane` true: the entry names another harness. Do not call `Agent`. Launch it through [foreign-harness subagents](foreign-harness.md), passing the returned `harness`, `model`, and `effort` to the launch helper.
- `agent` null otherwise: dispatch as the calling skill prescribes, passing `model` unless it is `inherit-parent`.

For a panel, launch one worker per returned entry, duplicates included. For a cross-judge pool, choose one entry by the skill's selection rule.

A subagent's own claim about its model or effort is not verification. The subagent's transcript under the session's `subagents` directory records `message.model` and `effort` on every turn; check both before claiming routing works.
