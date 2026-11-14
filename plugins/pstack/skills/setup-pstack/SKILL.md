---
name: setup-pstack
description: Configure which models pstack uses per role. Detects available models and writes the current runtime's override sheet. Use for /setup-pstack, "configure pstack models", changing pstack's model choices, or turning the SessionStart hook on or off.
---

# Setup pstack

On Codex, read the [platform mapping](../poteto-mode/references/codex-tools.md), including its per-skill notes, before following this skill.

On GitHub Copilot, read the [platform mapping](../poteto-mode/references/copilot-tools.md), including its per-skill notes, before following this skill.

On Muse, read the [platform mapping](../poteto-mode/references/muse-tools.md), including its per-skill notes, before following this skill.

On Antigravity, read the [platform mapping](../poteto-mode/references/agy-tools.md), including its per-skill notes, before following this skill.

Write the current runtime's per-role model override sheet. Each pstack skill names a default model inline; the override sheet adapts those defaults to the models you actually have access to.

On any runtime other than Claude Code, read [Other runtimes](references/runtimes.md) first. Its table gives the sheet path, how the sheet loads, and how to list models, and your runtime's section says which steps change. The rest of this file describes Claude Code.

On Claude Code the config directory is `$CLAUDE_CONFIG_DIR` when that variable is set and `~/.claude` otherwise. This skill calls it `<config>`, and the user sheet is `<config>/pstack-models.md`. A project may keep its own sheet, which replaces the user sheet there, as [Project scope](#project-scope) describes. Claude Code has no auto-applied "rules" mechanism like Cursor's `.mdc`, so inclusion is explicit: the user adds a line to `<config>/CLAUDE.md` such as:

```text
@<config>/pstack-models.md
```

with `<config>` written as the resolved path, so the file is loaded as context for every session. A project sheet loads from `@.pstack/models.md` in the project's `CLAUDE.md`.

## Steps

### 1. Detect available models

Enumerate the model names the `Agent` tool's `model` parameter accepts in this session. That is the dependable source. On Claude Code they are the family names listed in [Models](#models) below, each running that family's current model, and a full model ID is rejected. The default panel is listed there too. The panel is chosen for cross-family diversity. Ask the user to confirm or paste any additional slugs they want available. Never write a real slug you have not confirmed is available. The aliases `inherit-parent` and `auto` are always valid even though they are not detected slugs. Both mean the role runs on the parent session's model, which the `Agent` call expresses by omitting `model`.

Also detect the other CLI harnesses a role can run on with `command -v` on each `command` in the [registry](../poteto-mode/scripts/harnesses.json), and whether this session has T3 Code's `delegate_task` tool or runs inside herdr, tuios, tmux, or Rex (`HERDR_ENV`, `TUIOS_ENV`, `TMUX`, `REX_SESSION`). An entry is `model[->harness][@effort]`. A model runs on its provider's harness, so `gpt-6.1-sol@xhigh` runs on Codex, and `->harness` names another harness that serves the provider, as in `gpt-6.1-sol->pi@max`. Such an entry runs through [foreign-harness subagents](../poteto-mode/references/foreign-harness.md), so offer the installed harnesses' models only when one of those routes exists.

### 2. Load current state

The default role-to-model mapping is the rule shape shown in the Write the override sheet step below. If the current runtime's sheet already exists, read it and treat its values as the current choices. Otherwise start from those defaults. A line whose role is not in that shape, such as `how critics`, is from a retired role. Drop it. An older sheet may name full model IDs that start with `claude-`, which the `Agent` tool rejects. Replace each with its family name, the word after `claude-`. An older sheet may also put a space before an effort's `@`, or set it per model with `effort: model = value` lines. Remove the space, as in `sonnet@xhigh`. Fold each `effort:` line into the entries of that model that carry no suffix, then drop the line. List every rewrite in step 3.

#### Project scope

A project may keep its own sheet at `<project-root>/.pstack/models.md`. An existing project sheet replaces the user sheet as a whole for that project, and missing roles take the skill defaults, never the user sheet's values. A project sheet is seldom tracked by git, so a linked worktree of the project has no copy. Such a worktree reads the main checkout's project sheet unless it has one of its own. `node /path/to/poteto-mode/scripts/resolve-models.mjs --session <harness> --active` prints the sheet in force and each path it checked. Configure the scope the user names. Otherwise keep the project scope when a project sheet exists, and ask which scope to configure when neither is established. On Claude Code the session hook finds the project sheet in the same order, and a `session hook` line in it holds for that project. A project sheet without the line leaves the user sheet's line in force. Other runtimes' hooks read only the user sheet. For a project sheet, step 7 adds `@.pstack/models.md` to the project's `CLAUDE.md` on Claude Code, or a plain instruction naming the path to the project's `AGENTS.md` on other runtimes.

#### Presets

List saved presets with the [preset helper](../pstack-preset/scripts/presets.mjs), run from the project root: `node /path/to/presets.mjs list user` and `node /path/to/presets.mjs list project`. When either scope has one, offer the presets, labelled `user/NAME` and `project/NAME`, beside keeping the current mapping and configuring by hand. Honor a preset the user already chose without asking again. For a chosen preset, run `show SCOPE NAME` and take its mapping as the proposal for step 3. Roles it lacks take this runtime's defaults. A preset saved elsewhere does not prove its models exist here, so step 5 still validates every entry. A preset scope and the configured scope are independent: a user preset can configure a project, and a project preset can become the user default.

### 3. Map and confirm

Show every role with its current model, marking any real slug not in the detected set as needing a choice. Also list each line step 2 dropped or rewrote. Ask whether to accept as-is or change specific roles, offering the detected models plus `inherit-parent` and `auto` as the options. Prefer `AskUserQuestion` over free text. For panel roles (arena runners, architect runners, interrogate reviewers) the value is a list, and one subagent runs per entry, alias entries included, so the list length sets the count. `arena cross-judge pool` is also a list, but Arena runs one judge. It tries only values from a family other than the parent's, in list order, so order it by preference. An `inherit-parent` or `auto` value never judges. `swarm workers` is the default model for every worker unless a race or comparison assigns another model per arm.

Then ask for the default reasoning effort, the `default effort` line. It is `session`, which keeps the parent session's effort, or one of the levels in [Models](#models). Start from the default listed there. Every role value without a suffix runs at it. Then ask whether any role should run at another level. A role value may carry one after its slug, as in `<slug>@xhigh`; panel entries take their own, as in `<slug>@xhigh, <slug>@max`. Each level is passed as the dispatch's effort, so the choice holds without changing the session. Leave the suffix off for the default effort.

### 4. Choose whether the session hook routes tasks

On Claude Code, the plugin's `SessionStart` hook injects the poteto-mode mandate on startup, resume, clear, and compact. Ask whether to keep the hook. The default is on. The answer is the `session hook` line in the current runtime's sheet: `on` or `off`. With no sheet or no line, the hook injects. The line is inert on other runtimes without a pstack routing hook.

### 5. Validate

Every real slug written must be in the detected set. `inherit-parent` and `auto` always pass. Validate the slug without any `@<level>` suffix, and the level against the effort levels in [Models](#models). The `default effort` value is one of those levels or `session`. An entry on another harness is checked against that harness instead. Its model comes from the user or that harness's own model list, and its level must be one the [registry](../poteto-mode/scripts/harnesses.json) accepts. Run `node /path/to/poteto-mode/scripts/resolve-models.mjs <sheet> "<role>"` on the written sheet for every role. It rejects an entry the grammar cannot read. If a chosen real slug or level is not available, stop and ask again.

### 6. Write the override sheet

Write the current runtime's sheet with the shape below. Overwrite the whole file so re-runs stay idempotent. A project sheet also gets this line under its heading, so a session that loads both sheets knows which one counts: `This project's sheet. In this repository it replaces the user's pstack-models.md; ignore that sheet's lines.`

```markdown
# pstack model configuration

Per-role model overrides for pstack skills. Each pstack SKILL.md names its defaults in a Models section; the values here override those defaults. Delete a line to fall back to the skill default. A value of `inherit-parent` or `auto` runs that role on the parent session's model (the `Agent` call omits `model`); an alias entry in a panel list still counts toward that panel's fan-out. A model may carry a reasoning effort, as in `opus@xhigh` (levels: low, medium, high, xhigh, max); the role's subagent then runs at that level, each entry of a panel list on its own. `default effort` sets the level for a value without one; `session` uses the runtime's platform mapping to start from the parent session's effort. On Codex this requires active-turn metadata or an explicit effort choice. `session hook: off` stops the supported runtime's pstack routing hook from injecting the poteto-mode mandate; any other value, or no line, leaves it on.

feature, refactoring: sonnet
bug-fix: opus
perf-issue: opus
hillclimb: opus
judgment and prose: opus
strongest judgment: fable
how explorer: opus
how explainer: opus
why investigators: opus
why synthesizer: opus
reflect tooling: opus
reflect judgment, divergent, synthesizer: opus
arena runners: opus, fable, sonnet, haiku
arena cross-judge pool: opus, fable, sonnet, haiku
swarm workers: opus
architect runners: opus, fable, sonnet, haiku
interrogate reviewers: opus, fable, sonnet, haiku
thermos reviewers: opus
no-comments reviewer: opus

default effort: session
session hook: on
```

### 7. Wire it in

On Claude Code, if `<config>/CLAUDE.md` does not already include `<config>/pstack-models.md`, append an `@` line naming the sheet's resolved path, such as `@~/.claude/pstack-models.md`, so the model rows load on every session. For a project sheet, append `@.pstack/models.md` to the project's `CLAUDE.md` instead, if it is not there.

### 8. Confirm

Tell the user where the override was written, its scope, the preset it started from if any, how its model rows load, and whether the plugin hook is on. Name each entry that runs on another harness and whether T3 Code or a multiplexer can run it from here. Mention `pstack-preset` to save the result for reuse and `pstack-effort` to edit it on a page. Re-running this skill updates the override sheet, never the preset it started from.

### 9. Offer a verification skill (optional)

Check whether the project has a way to drive the real app for proof (a project `verify` or `verify-*` skill, or an existing harness). If not, offer once: "want a project-local verification skill, so agents can drive the app the way a user does and prove changes work? I can generate one with /create-verification-skill." On yes, invoke [`/create-verification-skill`](../create-verification-skill/SKILL.md). On no, move on without pushing.

### 10. Offer a formal verification skill (optional)

Check whether the project already has a formal verification skill (a project skill that runs a model checker, a proof, or another verifier against the code). If not, offer once: "want a formal verification skill, so agents can prove a key property of your code holds in every case in scope, not only the cases tests reach? I can generate one with /create-formal-verification-skill." On yes, invoke [`/create-formal-verification-skill`](../create-formal-verification-skill/SKILL.md). On no, move on without pushing.

## Models

Stamped from `plugins/pstack/models.json` (edit there, rerun `tools/generate.mjs`).

- Available Claude models: `opus`, `fable`, `sonnet`, `haiku`
- Default panel: `opus`, `fable`, `sonnet`, `haiku`
- Reasoning effort levels: `low`, `medium`, `high`, `xhigh`, `max`
- Default reasoning effort: `session`
- Single-role default: `opus`
