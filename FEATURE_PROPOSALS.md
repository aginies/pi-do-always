# do-always — Feature Proposals

A review of the project and proposed features that would add value. For each idea:
the problem it solves, the user benefit, and a rough implementation approach. Prioritized
by impact and effort.

> Status: #2, #3, and #6 shipped in v0.4.0; the rest remain proposals.

## Where the project stands

`pi-do-always` is a deliberately small tool with one clear loop: **pick a task → its
prompt fills the editor → you review/tweak → Enter to run.** The architecture is clean:
`tasks.ts` is pure and unit-tested (parse/merge/resolve/group/format), `index.ts` owns
all Pi UI and I/O. Config is read-only (global + project JSON, project overrides by
name, falls back to `DEFAULT_TASKS`).

The strongest features to add are the ones that **strengthen that loop** and **make the
task set self-maintaining** — because today the biggest friction is that the task list
is static and only editable by hand-editing JSON outside the TUI.

## Priority matrix

| # | Feature | Impact | Effort | Tier |
| --- | --------- | -------- | -------- | ------ |
| 1 | Capture & manage tasks from the TUI (`new`/`edit`/`remove`) | High | Med-High | 1 |
| 2 | ✅ Context-aware prompt templating (`{{branch}}`, `{{files_changed}}`, …) | High | Med | 1 |
| 3 | ✅ Live prompt preview in the selector | High | Med | 1 |
| 4 | `/do-always reload` | Med-High | Low | 2 (quick win) |
| 5 | `/do-always doctor` (config diagnostics) | Med | Low | 2 (quick win) |
| 6 | ✅ Opt-in auto-run for safe tasks | Med | Low-Med | 3 |
| 7 | Usage-based "Recent" ordering | Med | Med | 3 |
| 8 | Category filter (`@plan`) | Low-Med | Low | 3 |
| 9 | Shareable presets/templates | Med | Med-High | 4 |
| 10 | Per-task metadata (icon, tags, confirm-flag) | Low | Low-Med | 4 |

---

## Tier 1 — high impact

### 1. Capture & manage tasks from the TUI

**Problem.** The whole point of "do-always" is to capture your repeated prompts — but
adding one means leaving the TUI, hand-editing `do-always.json`, and reloading Pi. The
tool doesn't reinforce itself; the task list is frozen until you do manual file surgery.
There's also no way to fix a typo in a task name or retire an obsolete one.

**Benefit.** Turns a static list into a living one. You're in the middle of a session,
you just typed a great multi-line prompt you'll reuse → `/do-always new` captures it in
two keystrokes. This is the single biggest gap and the feature that makes the extension
worth keeping long-term.

**Approach.**

- Add subcommands in `runDoAlways`: `new`, `edit <name>`, `remove <name>` (plus
  `list`/`list-details` already exist).
- `new`: open `ctx.ui.editor` pre-filled with a small scaffold (name / description /
  category / prompt), parse the result, append to the target file.
- Decide the **target file**: default to the project `.pi/do-always.json`; offer a
  `--global` flag (or a prompt) to write to `~/.pi/agent/do-always.json`. If no file
  exists yet, create it (seed from the current effective list or empty).
- A small pure helper in `tasks.ts` — e.g. `upsertTask(tasks, task)` /
  `removeTask(tasks, name)` — keeps the list mutation testable; `index.ts` does the
  `readFileSync`/`writeFileSync` and then re-runs `loadConfig` (pairs naturally with #4).
- Edge cases to handle: duplicate names (warn/confirm), empty fields, and "which file
  did this come from" when a name exists in both global and project.

### 2. Context-aware prompt templating

**Problem.** Prompts are static strings. A "Review" task says "check `git status` and
`git diff`" but the agent still has to go find that context. Tasks can't adapt to *this*
branch, *these* changed files, or *this* commit — so the same generic prompt is injected
regardless of situation.

**Benefit.** Tasks become dramatically more useful and specific with zero extra typing.
`/do-always review` on a hotfix branch injects "Review the changes on branch
`fix/login-null` (3 files: `auth.ts`, `login.ts`, `test/auth.test.ts`) …" instead of a
generic nudge. This is the highest-leverage way to improve the *existing* default tasks.

**Approach.**

- Pure, testable engine in `tasks.ts`: `renderPrompt(template, ctx: Record<string,string>)`
  that substitutes `{{key}}` placeholders (unknown keys left as-is or blanked — decide +
  test).
- `index.ts` builds the context (the only place with I/O): `cwd`, `date`, and git facts
  via `child_process` (`branch`, `last_commit` subject, `files_changed` from
  `git status --porcelain`, `user`). Guard for non-git dirs.
- Apply `renderPrompt` in `fillPrompt` (and in `list-details`/preview so what you see is
  what gets injected).
- Backwards compatible: a prompt with no `{{}}` is unchanged. Document the placeholder
  set in the README.

### 3. Live prompt preview in the selector

**Problem.** The selector shows only `name — description`. The actual prompt — the thing
that gets injected — is hidden until you commit to a task (or dump everything via
`list-details`). You're choosing somewhat blind.

**Benefit.** You see exactly what a task will do before you pick it, which builds trust
and makes the review step meaningful. It also makes long prompts discoverable without a
separate command.

**Approach.**

- In `buildRender`, reserve a preview block below the list (above the footer) showing the
  selected task's prompt, wrapped/truncated to a few lines with a `…` indicator. Reuse
  `truncateToWidth`/`visibleWidth`.
- Keep it width-aware (hide the preview on narrow terminals, consistent with the existing
  description-column fallback).
- This composes with #2: preview the *rendered* prompt so placeholders are shown resolved.

---

## Tier 2 — quick wins (ship first, low effort)

### 4. `/do-always reload`

**Problem.** Config is loaded at `session_start` and on `cwd` change. Edit
`do-always.json` mid-session and you must reload Pi (or switch dirs) to see it. This
friction is exactly what #1 makes more frequent.

**Benefit.** Instant config pickup; makes hand-editing and #1's write-back seamless.

**Approach.** Trivial: a `reload` subcommand that re-runs `loadConfig(ctx.cwd)` into the
cached `tasks` and notifies "reloaded N tasks from `<file>"`. ~10 lines.

### 5. `/do-always doctor`

**Problem.** `parseConfig` already collects errors (invalid tasks, bad shortcut,
malformed JSON) but they only surface as `console` warnings at load. There's no way to
ask "which config file is active, how many tasks, are there problems?"

**Benefit.** Fast debugging of "why isn't my task showing up?" — reports active file(s),
effective task count, per-file warnings, and the resolved shortcut.

**Approach.** A `doctor` subcommand that re-parses both files with an error collector and
prints a summary via `ctx.ui.notify`/editor. Reuses existing `parseConfig`/
`resolveShortcut`; no new logic needed.

---

## Tier 3 — medium impact

### 6. Opt-in auto-run for safe tasks

**Problem.** Every selection fills the editor and waits for Enter. For idempotent,
low-risk tasks (`Tests`, `Build`) the review step is pure overhead.

**Benefit.** One keystroke to *run* (not just fill) the safe ones, while keeping
fill-review-run for the rest.

**Approach.** Add optional `autoRun: true` to a task (parse in `parseConfig`). On select,
if `autoRun`, call `pi.sendUserMessage(prompt)` directly instead of `setEditorText`. Keep
it strictly opt-in so the default philosophy is unchanged. (A "run now" modifier key is
an alternative that avoids a config field.)

### 7. Usage-based "Recent" ordering

**Problem.** "Do-always" implies doing the *usual* things, but there's no memory of what
you actually use. A task you run daily sits at the same position as one you never touch.

**Benefit.** Your most-used tasks float to the top (or into a `Recent` group), so the
common case is fewer keystrokes.

**Approach.** Persist a small usage log (name → last-used / count) to a state file under
the agent dir. On select, record usage. Add an optional `Recent` group (or a sort mode)
in `groupTasksByCategory`/`orderTasksByCategory`. Keep it opt-in so it doesn't surprise
people who rely on stable numbering.

### 8. Category filter

**Problem.** Filtering is free-text substring only. You can't quickly say "show me only
Plan tasks."

**Benefit.** Fast narrowing in large task sets.

**Approach.** In `matchesFilter`, treat a leading `@word` as a category match (e.g.
`@plan`). ~5 lines + a test.

---

## Tier 4 — nice to have

### 9. Shareable presets/templates

**Problem.** Good task sets are trapped in one machine's JSON. There's no way to share a
curated set (e.g. "TypeScript monorepo tasks") or start from a community preset.

**Benefit.** Discoverability and reuse; lowers the barrier for new users.

**Approach.** A `presets` concept: named task bundles (shipped in-repo or fetched), a
`/do-always preset <name>` that merges a preset into your config. Larger design effort;
defer.

### 10. Per-task metadata

**Problem.** Tasks have only `name`/`category`/`description`/`prompt`. No way to mark a
task as destructive (needs confirm), attach an icon, or tag it for filtering.

**Benefit.** Better signaling (e.g. a ⚠ on `Release`/`Commit`-style tasks) and richer
filtering.

**Approach.** Optional `icon`, `tags[]`, `confirm: true` fields parsed in `parseConfig`,
rendered in `renderLabel`, and honored in `fillPrompt` (confirm gate). Low risk,
incremental.

---

## Suggested sequencing

1. **Ship #4 (`reload`) and #5 (`doctor`) now** — both are ~10–30 lines, zero risk, and
   immediately improve the daily workflow.
2. **Then #2 (templating)** — pure, well-testable engine first (`tasks.ts`), then wire
   git context in `index.ts`. Highest leverage on the *existing* tasks.
3. **Then #3 (preview)** — small UI change that pays off more once #2 lands (preview
   shows rendered prompts).
4. **Then #1 (capture/manage)** — the biggest win but the most surface area (file
   write-back, global-vs-project, duplicate handling). Do it last so it can build on
   `reload` and the pure list-mutation helpers.
