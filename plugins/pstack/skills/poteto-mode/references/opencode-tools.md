# OpenCode V2 model routing

Read this before any pstack delegation in OpenCode. It overrides Claude-specific agent names and model parameters in the calling skill.

OpenCode's `subagent` tool selects a named agent. The agent profile selects the model and reasoning variant. A missing per-call model parameter does not prevent model routing.

Use the launcher and configuration of the current session. A custom launcher such as `opencode-muse` may have an isolated home, config directory, and credential database. Do not run the regular `opencode` CLI to verify that runtime. Delegation itself uses the native subagent tool, not a shell-launched CLI.

## Install and check the routes

Select the active sheet using [configuration scope](model-dispatch.md#configuration-scope), including project overrides and explicitly configured legacy paths. Do not use a guessed model or a mapping from an isolated runtime's empty home directory. Locate the active OpenCode configuration directory through `OPENCODE_CONFIG_DIR`, then `XDG_CONFIG_HOME/opencode`, then the user's global OpenCode directory.

Run the bundled `../scripts/opencode-agents.mjs` helper with explicit absolute paths:

```sh
node /path/to/poteto-mode/scripts/opencode-agents.mjs --mapping /path/to/pstack-models.md --config-dir /path/to/opencode --install
```

The helper creates model-specific Markdown agents and `pstack-routing.json`. It preserves unrelated configuration and refuses to overwrite unmanaged files. The helper uses the shared model/effort resolver: inline `model@effort` wins over model-wide `effort:` settings, which win over legacy reasoning-variant table rows. `@default` clears both defaults and uses the runtime default. Without an effort setting or legacy variant row, the profile uses the runtime default. Explicit effort on `auto` or `inherit-parent` is rejected because this adapter cannot apply it to the generic agent. Validate model and variant availability against the running runtime catalog before installation. Rerun installation when the sheet changes. Old generated profiles are retained, but only current routes may be used.

## Launch by role

Before spawning, resolve the role used by the calling skill:

```sh
node /path/to/poteto-mode/scripts/opencode-agents.mjs --mapping /path/to/pstack-models.md --config-dir /path/to/opencode --role feature
```

This checks that installed profiles match the current sheet and returns agent IDs with model and variant. Use the returned `agent` in `subagent`, retaining the task, file pointers, specialist instructions, and background behavior required by the calling skill. For a panel, launch each returned entry as specified by that skill. For a cross-judge pool, choose one entry according to the skill's selection rule.

Only `auto` and `inherit-parent` deliberately route to `general`. Never substitute `general` or `explore` for an explicit model assignment. A role missing from the sheet needs an explicit assignment before it can be routed with this helper.

If a newly installed agent is not recognized, refresh the location configuration using the running server's documented API or open a fresh session. Do not restart the whole service while other sessions are working. If refresh is unavailable, report that the profiles are installed but not yet usable in the current session.

Verify a smoke task through the actual subagent tool. Check the resulting child session's recorded provider, model, and variant through the server API. A model's own statement about its identity is not verification. Do not claim a mixed-model review unless the child session metadata confirms those assignments.

See the [OpenCode V2 agents documentation](https://opencode.ai/v2/docs/agents) for profile discovery and model inheritance.
