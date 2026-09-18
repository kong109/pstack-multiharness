---
name: setup-pstack
description: Configure pstack role models and effort at project or user scope, optionally starting from a saved preset, and install model-specific subagents for OpenCode V2. Use for /setup-pstack, pstack-setup, choosing a pstack preset, or changing role mappings.
---

# Setup pstack

On OpenCode V2, follow [OpenCode model routing](../poteto-mode/references/opencode-tools.md). Detect models and reasoning variants from the running OpenCode catalog, preserve the user's role sheet, and install named agent profiles with the bundled helper after any mapping change. Confirm a live child session's recorded model and variant before claiming routing works. The Claude-specific include and per-call model instructions below do not apply to OpenCode.

On Codex, read the [platform mapping](../poteto-mode/references/codex-tools.md), including its per-skill notes, before following this skill.

Configure the project or user override sheet using [configuration scope](../poteto-mode/references/model-dispatch.md#configuration-scope). Respect a scope named by the user. Otherwise keep the existing project scope when one exists; if no target is established, ask whether to configure this project or the user default. Preset storage scope and the scope being configured are independent. A user preset can be applied to a project, and a project preset can become the user default.

## Steps

### 1. Detect available models

Enumerate the model slugs you can pass to an `Agent` subagent in this session — that is the dependable source. The currently available Claude models and the default panel are listed in [Models](#models) below; the quad is chosen for cross-family, cross-tier diversity, and the single-role default stays out of the panels because it already covers the single-model roles. Ask the user to confirm or paste any additional slugs they want available. Never write a real slug you have not confirmed is available. The aliases `inherit-parent` and `auto` are always valid even though they are not detected slugs; both mean the role runs on the parent session's model, which the `Agent` call expresses by omitting `model`.

### 2. Load current state

Read the target sheet if it exists. For a new project config, start from the effective user sheet if present; otherwise use the role defaults in step 5, translated to the current runtime.

List saved presets using the [preset helper](../pstack-preset/scripts/presets.mjs), running from the project root: `node /path/to/presets.mjs list user` and `node /path/to/presets.mjs list project`. If any exist, offer the scope-labeled presets alongside keeping the current mapping and configuring manually. Honor an already selected preset without asking again. Disambiguate same-name presets by scope. If neither scope has presets, continue normal setup.

For a selected preset, run `show SCOPE NAME` and use its mapping as the proposed configuration. Do not write the active sheet yet. Missing roles use runtime defaults, not stale roles from the previous sheet. Validate models and effort for this runtime in step 4; saving a preset does not certify availability elsewhere.

### 3. Map and confirm

Follow [model and effort resolution](../poteto-mode/references/model-dispatch.md). Show resolved effort beside every model, including each panel entry. Offer model-wide defaults with `effort: model = value` and per-role overrides with `model@effort`. Preserve existing effort choices when changing model mappings, including legacy `effort:` lines. Do not replace them with the bare-model template below. Ask only for missing choices.

Show every role with its current model, marking any real slug not in the detected set as needing a choice. Ask whether to accept as-is or change specific roles, offering the detected models plus `inherit-parent` and `auto` as the options. Prefer `AskUserQuestion` over free text. For panel roles (arena runners, architect runners, interrogate reviewers) the value is a list, and one subagent runs per entry, alias entries included, so the list length sets the count. `arena cross-judge pool` is also a list, but Arena selects one value from it whose model family differs from the parent's when possible. `swarm workers` is the default model for every worker unless a race or comparison assigns another model per arm.

### 4. Validate

Run the resolver for every role using the proposed sheet and its default model list. Single-model roles must have one entry. Validate explicit effort against the host model capabilities and confirm a concrete dispatch control can apply it. Prompt text is not an effort control. Report unsupported settings instead of dropping them. Remove legacy prose describing effort as only a worker-brief instruction, while preserving its `effort:` settings.

Every real slug written must be in the detected set; `inherit-parent` and `auto` always pass. If a chosen real slug is not available, stop and ask again.

### 5. Write the override sheet

Write the selected target sheet with the shape below and all effective role rows and effort defaults. A project target is `<project-root>/.pstack/models.md`; user targets follow configuration scope. Preserve user adjustments made after selecting a preset. If applying an unchanged complete preset, the helper supports `apply SCOPE NAME /absolute/target.md`; use `--replace` when setup is replacing an existing target as requested. Applying creates an independent copy; subsequent edits do not change the preset.

```markdown
# pstack model configuration

Per-role model overrides for pstack skills. Each pstack SKILL.md names its defaults in a Models section; the values here override those defaults. Delete a line to fall back to the skill default. A value of `inherit-parent` or `auto` runs that role on the parent session's model (the `Agent` call omits `model`); an alias entry in a panel list still counts toward that panel's fan-out. Entries accept model@effort for per-role effort. A line `effort: model = value` sets a model-wide default; inline effort wins, and @default clears it. Resolve both fields with pstack's resolve-models.mjs before dispatch; apply effort through runtime controls, never through the worker brief.

feature, refactoring: claude-opus-5
bug-fix: claude-fable-5-1
perf-issue: claude-fable-5-1
hillclimb: claude-fable-5-1
judgment and prose: claude-opus-5
strongest judgment: claude-fable-5-1
how explorer: claude-opus-5
how explainer: claude-opus-5
why investigators: claude-opus-5
why synthesizer: claude-opus-5
reflect tooling: claude-opus-5
reflect judgment, divergent, synthesizer: claude-opus-5
arena runners: claude-opus-5, claude-fable-5-1, claude-sonnet-5
arena cross-judge pool: claude-opus-5, claude-fable-5-1, claude-sonnet-5
swarm workers: claude-opus-5
architect runners: claude-opus-5, claude-fable-5-1, claude-sonnet-5
interrogate reviewers: claude-opus-5, claude-fable-5-1, claude-sonnet-5
```

### 6. Wire it in

Add or update one scoped instruction in the destination instructions file to read the target sheet before pstack dispatch. On Claude Code, use `@.pstack/models.md` in project `CLAUDE.md` or the user sheet include in global `CLAUDE.md`. On Codex and OpenCode, add a plain instruction in project or user `AGENTS.md` naming the absolute sheet path, or the project-relative `.pstack/models.md`. Do not copy role rows into instructions files. Update existing pstack mapping blocks or pointers to avoid stale competing values; preserve unrelated instructions. State that a project sheet takes precedence over the user sheet.

### 7. Confirm

Report the config scope, target path, selected preset scope/name if any, and how it loads. Mention `pstack-preset` for saving the resulting configuration for reuse. Re-running setup updates the chosen sheet, not its source preset.

## Models

Stamped from `plugins/pstack/models.json` (edit there, rerun `tools/generate.mjs`).

- Available Claude models: Opus 5 (`claude-opus-5`), Opus 4.8 (`claude-opus-4-8`), Opus 4.6 (`claude-opus-4-6`), Fable 5.1 (`claude-fable-5-1`), Sonnet 5 (`claude-sonnet-5`), Sonnet 4.6 (`claude-sonnet-4-6`), Haiku 4.5 (`claude-haiku-4-5`)
- Default panel: `claude-opus-5`, `claude-fable-5-1`, `claude-sonnet-5`
- Single-role default: `claude-opus-5`
