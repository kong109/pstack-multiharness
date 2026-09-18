---
name: pstack-preset
description: Save a configured pstack role and effort mapping as a named user or project preset. Use for saving, listing, inspecting, or replacing pstack config presets. To select a preset and configure roles, use setup-pstack.
---

# Pstack presets

Save the current mapping for reuse. Presets are snapshots, not live references. User presets are shared across projects and runtimes at `~/.agents/pstack/presets/`. Project presets live at `<project-root>/.pstack/presets/` and can be committed for teammates. Saving a preset does not activate it or alter the current mapping.

Use [the preset helper](scripts/presets.mjs) with Node or Bun. Run it from the project root, never from the skill directory. Expand paths to absolute paths when invoking it.

1. Find the active sheet using [configuration scope](../poteto-mode/references/model-dispatch.md#configuration-scope). A preset of the current project should capture its effective mapping. If its sheet is partial, materialize missing role defaults for the current runtime into a temporary sheet first, preserving effort. Use the defaults in [setup-pstack](../setup-pstack/SKILL.md#models) and its role template. Do not save instructions files, credentials, or unrelated project prose.
2. Use the name and scope the user specified. If missing, ask for a short name and whether to save at user scope, for reuse in other projects, or project scope, for this project and its teammates. Names are lowercase hyphenated slugs. Do not assume scope from a matching preset name.
3. List that scope and inspect an existing same-name preset before replacing it. If the user asked to update or replace it, proceed; otherwise ask whether to replace it or use another name.
4. Run `node /path/to/presets.mjs save user NAME /path/to/source.md`, substituting `project` for project scope. Add `--replace` only for an authorized replacement. The helper validates mapping syntax and preserves role order, repeated panel entries, inline effort, and model-wide effort defaults. It saves configuration rows only.
5. Read it back with `node /path/to/presets.mjs show user NAME`. Report the scope, saved path, and how to select it with `setup-pstack`.

For listing, run `node /path/to/presets.mjs list user` and `node /path/to/presets.mjs list project`. Label results `user/NAME` and `project/NAME`; both remain selectable when names collide. To apply a preset, follow [setup-pstack](../setup-pstack/SKILL.md) so models and effort are validated for the destination runtime before any active config is replaced.
