---
name: pstack-effort
description: On Claude Code, show the active pstack role-to-model map as an editable HTML page with a provider, model and effort choice per slot, and apply the message the page produces. Use when the user asks for their pstack model mapping, role routing, effort levels or model sheet as a page or to edit, invokes /pstack-effort, or pastes a message that starts with "/pstack-effort apply".
---

# pstack-effort

Two modes. A pasted message that starts with `/pstack-effort apply` runs **Apply**. Anything else runs **Show**. This skill edits the Claude Code sheet. On Codex, use `setup-pstack` to edit `~/.codex/pstack-models.md`.

The scripts live beside this file. `scripts/render.mjs` builds the page, `scripts/apply.mjs` writes the result, and `scripts/sheet.mjs` is the parser both share. Run them with `node` and absolute paths. `providers.json` is the catalog the page offers.

## Find the active sheet

Resolve the sheet the same way pstack dispatch does.

1. If `<project-root>/.pstack/models.md` exists, use it. Its scope is `project`. See [project scope](../setup-pstack/SKILL.md#project-scope).
2. Otherwise use `<config>/pstack-models.md`, where `<config>` is `$CLAUDE_CONFIG_DIR` when set and `~/.claude` otherwise. Its scope is `user`.

Say which one is active and why in your reply.

## Show

1. Render the page into the scratchpad. Keep one stable path per sheet, so a republish from this session keeps the same URL.
   `node <skill>/scripts/render.mjs --sheet <sheet> --out <scratchpad>/pstack-effort/index.html --scope <scope> --project-root <project root>`
   The page embeds every saved preset, user ones from `~/.agents/pstack/presets/` and project ones from `<project root>/.pstack/presets/`. `--project-root` defaults to the working directory.
2. Publish it with the Artifact tool (`icon: "sliders"`). On a first publish in a new session, first `list` the user's artifacts. If one titled "Pstack Effort Map" exists, `read` it and publish to its `url`, so the user keeps one link.
3. Reply with the link and the current map as a short table of role and entries. Tell the user to pick providers, models and effort boxes, copy the message at the bottom, and paste it back.

Each slot has a provider select, a model select, and effort checkboxes.

- **Presets.** A select at the top lists the presets as `user/NAME` and `project/NAME`. Choosing one fills every role the preset names with its entries and keeps the rest of the sheet's roles as they are. A preset role the sheet lacks is skipped, since the page edits only existing role lines, and the page names both lists. A preset entry with no effort takes the preset's `default effort` line, written as an explicit `@level` when it differs from the sheet's. A preset whose default is `session` cannot override a sheet default level, so those entries take the sheet's default. The result is an ordinary edit: change slots after it, or reset.

- **Provider.** Each provider runs on one harness. Anthropic runs on Claude Code, OpenAI on Codex, xAI on Grok, Google on Antigravity (`agy`), and Meta on Muse. A slot on the session's own harness is written as a bare model. A slot on any other harness is written as `harness:model`, so the sheet routes it through [foreign-harness](../poteto-mode/references/foreign-harness.md), as a T3 Code subagent inside T3 Code and in a herdr tab, tuios window, or tmux window elsewhere.
- **Models.** The Anthropic list holds the family names the `Agent` tool accepts, from `providers.json` plus the plugin's `models.json` `available` list. The OpenAI list is what Codex itself reports in `~/.codex/models_cache.json`, and `providers.json` is the fallback when that cache is missing.
- **Efforts.** The checkboxes come from the selected model's own levels, so a model that offers `ultra` shows it and a model that does not, hides it. Ticking one clears the others in that slot. A ticked box is written after the model with a space, as in `opus @xhigh`. No tick means the slot runs at the sheet's `default effort` line, or at the session's effort when that line is missing or `session`, and the slot's note says which. Changing the provider keeps the model's effort when the new model supports it. Antigravity names the effort in the model id, with one model per level, so its models show no effort boxes and the slot is written without an effort.
- **Panels.** Roles named `runners`, `pool`, or `reviewers`, and any role with more than one entry, can repeat or remove slots.
- **Aliases.** `inherit-parent` and `auto` hide the provider and effort controls, since they run on the parent session's model and effort.
- **Unknown entries.** A model outside the catalog appears as a disabled current-entry placeholder, and an effort the model does not list stays with a note. Both are written back unchanged. Apply still refuses a sheet with an entry a dispatch would reject, and it names the role.

To add a provider, add an entry to `providers.json` and a matching harness to `../poteto-mode/scripts/harnesses.json`.

## Apply

The pasted message carries `sheet:`, `scope:`, a change list, the role lines as the page read them in a fenced `pstack-base` block, and the whole new sheet in a fenced `pstack-sheet` block.

1. Write the pasted message verbatim to `<scratchpad>/pstack-effort/message.txt`.
2. Dry run first and show the user the diff it prints.
   `node <skill>/scripts/apply.mjs --message <message.txt> --dry-run`
   It refuses a sheet whose roles differ from the roles the page rendered, since the page only edits entries. It refuses a role the page changed when the file's line for that role has moved since the page was rendered, and it names the role, so render the page again and redo that edit. It also refuses a sheet with any entry a dispatch would reject: an effort the harness does not accept, a full `claude-` model ID that the `Agent` tool rejects, or the old `model@level` form without a space. Hand-edit the sheet for structural changes. The diff is complete because apply rewrites only the roles the page changed, in the file on disk. Everything else in the file, including roles and lines edited after the page was rendered, stays as it is.
3. Apply.
   `node <skill>/scripts/apply.mjs --message <message.txt>`
   The script backs up the sheet to `<sheet>.bak`, which the next apply replaces, and writes the changed role lines.
4. Check the result. Run `node <poteto-mode>/scripts/resolve-models.mjs <sheet> "<changed role>"` for each changed role. Each entry returns its model and effort, and an entry on another harness also returns its `harness`.
5. Re-render and republish the page to the same URL, so it shows the applied map.
6. Reply with each changed role (old to new) and the backup path. When the sheet routes any role to another harness and this session is in none of T3 Code, herdr, tuios, or tmux, say so, because those roles have nowhere to run.

## Rules

- Never apply without the dry-run diff first. If the pasted `sheet:` path is not the active sheet, say so and ask before writing.
- The page and the scripts edit only role lines. Prose, headings, the `default effort` and `session hook` lines, and comments in the sheet stay verbatim.
- To save the result as a named preset, use the `pstack:pstack-preset` skill after applying.
