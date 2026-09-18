# Model and effort dispatch

Before dispatching a configured role, run [the resolver](../scripts/resolve-models.mjs) with Node or Bun. Resolve the script path relative to this reference. Pass the active override sheet, exact role label, and the skill's default comma-separated model list:

```sh
node /absolute/path/to/resolve-models.mjs /absolute/path/to/pstack-models.md "arena runners" "model-a, model-b"
```

Use `-` for the file argument only when no override sheet exists. An unreadable or invalid sheet is an error. Apply the precedence in [configuration scope](#configuration-scope). Expand `~` before passing a path. Substitute available runtime model IDs for Claude defaults on another host.

The resolver returns an ordered JSON array of model/effort pairs. Each panel entry remains a separate worker, including duplicates. Arena selects one complete pair from its judge pool. Single-model roles must resolve to one entry.

## Configuration

Existing bare model entries keep working. Append `@effort` for a per-role, per-model override:

```text
feature, refactoring: model-a@high
arena runners: model-a@high, model-b@medium, model-a@low
arena cross-judge pool: model-a@high, model-b@high
effort: model-b = medium
```

An inline effort wins over `effort: model = value`, which supplies a model-wide default across roles, including roles using their default model lists. Without either, use the runtime's default effort. `model@default` explicitly clears a model-wide override. Preserve model-wide defaults when editing a role. Legacy OpenCode reasoning-variant table rows supply effort defaults when no `effort:` line exists for that model; preset snapshots convert these rows to portable `effort:` settings.

`inherit-parent` and `auto` return a null model, meaning omit the model override. They can carry explicit effort. A null effort means omit the effort override. Model-wide defaults for a concrete parent ID cannot be resolved from an alias; use inline effort or an effort default for the alias itself.

## Apply the result

Pass resolved model and effort through actual runtime controls. A sentence in a worker brief does not configure reasoning effort.

- Inspect the current dispatch tool schema and model capabilities. Validate effort for that model; do not infer support from its slug.
- If the tool exposes `reasoning_effort` or `effort`, pass the resolved value there. Omit the field for null effort. On Codex, obey fork restrictions on model and effort overrides and select a supported context mode when either is explicit.
- If the host configures effort through agent definitions or model variants, select or configure a worker definition with that model and effort through the host's documented mechanism. On OpenCode, verify that the worker dispatch selects the configured agent or variant. The parent's variant alone does not prove a child uses it.
- If explicit effort cannot be applied, report the unsupported model/effort pair before launching that worker and obtain a supported choice. Do not silently drop it, substitute another level, or claim it was applied through prompt text.
- If a rejected model is replaced, resolve and validate effort again. Do not carry a model-specific default to a different model.

When reporting role mappings, show model and resolved effort for every entry. Distinguish resolved configuration from verified dispatch. Resolver output alone does not prove the host applied it.

## Configuration scope

Check `<project-root>/.pstack/models.md` first, regardless of runtime. An existing project sheet replaces the user sheet as a whole. Missing roles use the skill's runtime-appropriate defaults; do not merge user effort defaults into a project sheet. An unreadable or invalid project sheet must not silently fall back to user config.

Without a project sheet, use the user sheet already explicitly configured in the session. Otherwise use `~/.claude/pstack-models.md` on Claude Code, `~/.codex/pstack-models.md` on Codex, or `~/.agents/pstack/models.md` on other runtimes. Existing explicitly configured legacy paths remain valid. Presets are inactive snapshots and never participate in this lookup until setup copies one into an active sheet.

[Setup](../../setup-pstack/SKILL.md) can configure either scope and select a user or project preset. [Pstack preset](../../pstack-preset/SKILL.md) saves the effective mapping at either scope.
