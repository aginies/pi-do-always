# pi-do-always

A [Pi](https://github.com/earendil-works/pi) extension that gives you a `/do-always` command for your
repeated "do the usual" prompts.

Type `/do-always` → a numbered list of tasks appears, grouped by category → press a number,
type to filter, scroll or click, or navigate with arrows + Enter → the task's prompt is
**filled into the input editor**. Review it, tweak it, press Enter to run. Tasks marked `⚡`
(the `Plan` category by default) auto-run on selection instead — see `autoRun` below.


![do-always — the numbered task selector](pi.image.png)

## Install

Install it from npm as a Pi package, which loads the bundled `index.ts` (and its `tasks.ts`) without
managing symlinks:

```bash
pi install npm:pi-do-always
```

Manage it with `pi list` (to see installed sources) and `pi remove <source>` using the same
source you installed with (e.g. `pi remove npm:pi-do-always`).

Alternatively, you can install from the git repo or symlink a local checkout for development:

```bash
ln -s "$PWD" ~/.pi/agent/extensions/do-always   # uninstall with: rm that symlink
```

For development you can also load it explicitly: `npm run dev` (runs `pi --extension ./extensions/pi-do-always/index.ts`).

## Usage

|Command|What it does|
|---|---|
|`/do-always` or the shortcut key (default `F4`)|Show the numbered task selector|
|`/do-always 2`|Fill the prompt for task #2 directly|
|`/do-always review changes`|Fill the prompt for the task named `review changes` (task names autocomplete after `/do-always`)|
|`/do-always list`|Print the task list|
|`/do-always list-details`|Show the full rendered prompt text each task will inject|
|`/do-always replan`|Re-open the plan questionnaire for the last offered proposal (e.g. after an accidental Esc)|

The selector supports direct number-pick (1-9), live type-to-filter, arrow/Enter navigation,
mouse-wheel scrolling, and click-to-select. While a filter is active, typed digits refine the
filter instead of picking by number; clear the filter (backspace) to use number-pick again.
Pause on a task for two seconds and its full prompt is previewed below the list, so you can
see exactly what will be injected before running it; moving the selection or typing hides it
and restarts the delay. A task marked `⚡` runs immediately on selection (its prompt is sent,
not filled): the `Plan` category does this by default, and any task can opt in or out via the
`autoRun` field.

In non-interactive modes (no TUI) there is no editor to fill, so the selected prompt is sent
as a user message instead.

## Chains

Run several tasks in a row as a **chain**. The selector shows an `ORDER` column; tasks in
the chain get a `[n]` marker in execution order, and a pinned row at the bottom of the
list runs the chain.

Building a chain in the selector:

- **Enter on a task row** runs just that task (the classic pick — the cursor starts in
  the task column).
- **→** moves the cursor to the ORDER column on the same row, where **Enter** toggles
  that task's chain membership (`·` → `[n]` → `·`). **←** goes back to the task column.
- **↑ / ↓** move the cursor in either column. The cursor is a **►** marker in the
  theme's accent color: in the left gutter in the task column, in the ORDER cell in
  the order column (plus a row highlight where your theme makes it visible). From the
  last task row, **↓** lands on the pinned Run row (and **↑** back).
- **Enter on the `Run the chain (n)` row** — or a mouse click on it — runs the chain.
  The row is dimmed while the chain is empty. The ► marker appears on it only
  while the cursor is on the row (as on task rows).
- **Backspace** (with no filter typed) undoes the last add; **ctrl+u** clears the whole
  chain; **Esc** cancels and discards it.
- Clicking an ORDER cell toggles the task's chain membership.
- The classic fast paths are unchanged: **1-9** runs a task immediately, and clicking a
  task row runs it — both close the selector and discard the chain.

Chains are capped at 8 tasks. Reordering is done by removing a task and re-adding it. On narrow terminals the ORDER
column is dropped and the chain is shown on its own line below the list (keyboard
chaining still works).

Running a chain sends each step as its own turn, strictly one after another — the next
step starts only after the previous run has fully finished. Before anything is sent,
every step's guards are checked against the current state (fail fast: the first blocked
step is reported and the chain doesn't start). All steps share the prompt context
captured when the chain started, so each step's placeholders and guards see the tree as
it was at that point. An aborted step (Esc), a step that errors, or a step whose send
fails to start stops the chain; steps already run are kept.

If the first task of a chain is a fill task (no `⚡`) in the TUI, step 1 is put in the
editor and the rest of the chain starts automatically once you press Enter and that run
finishes.

While a chain is running, a **status widget** is shown below the prompt: the chain's
tasks with a marker per step and a `(n/N)` progress count — the step the chain is
currently at.

```
  ⛓ do-always (2/4)
  ✓ Review changes
  ▶ Build
  ○ Test
  ○ Deploy
```

Markers: `✓` completed, `▶` running (or waiting for your Enter on a fill-first step 1),
`○` pending, `✗` errored / failed to start, `⊘` aborted, `–` skipped because its guards
no longer hold. The widget is removed when the chain completes; if the chain stops early
it stays below the prompt as a trace of where it stopped (until your next prompt or a new
session). Starting a second chain while
one is running is refused — wait for it to finish or abort the current step with Esc.

Every chain run also writes a **report file** in the project root —
`do-always-report-tasks-YYYY-MM-DD-HHMM.md` (e.g. `do-always-report-tasks-2025-01-15-1432.md`) —
so earlier steps' results are not lost when later steps' output scrolls them off screen.
Each step appends a section as it finishes (the step's final assistant message, with its
outcome and run time), so the file is complete even if the session dies mid-chain; a
footer with the overall summary is appended when the chain ends, and the completion
notification carries the file's path. A run that produces nothing worth keeping (no
completed step and no step result text — e.g. step 1 errors before any output) leaves no
file behind. Set `"report": false` in the config to disable
it (the project file's value wins over the global one). See [Report file](#report-file).

**Inline report.** When a chain completes fully (all steps done), the full Markdown
report opens in an editor view so you can read the results without opening the file —
press Esc to dismiss it. Nothing is persisted to the session: the report lives only in
that view and in the report file on disk. A run that stops early (aborted, errored, or
skipped steps) does not show the inline report — only the status trace widget below
the prompt.

## Commit browser

Two built-in tasks open the date-grouped commit browser (pages of 20, type to
filter, Space/Enter to select, ←/→ to page):

- **Browse commits** (category `Browse`, only shown inside a git repo) — the
  generic entry: select commits, then confirm on the `do on the commits
  (n commits)` row to pick which task runs on them — a picker lists your
  visible `Plan` tasks, except those marked `notForCommits: true` (the
  built-in Review changes, Review code, and Propose features — they operate
  on the working tree or the whole project, not on a set of commits). The
  chosen task's prompt is sent as a single turn (not a chain) with the
  selection injected.
- **Review commits** (category `Plan`, hidden from the selector) — offered in
  the picker after a selection; the review runs directly on the selected
  commits (its prompt consumes the selection). Still resolvable by name:
  `/do-always review commits` opens the browser as before.

The selection is injected into the chosen task's prompt: a prompt that
references `{{selected_commits}}` gets the numbered commit detail block
substituted in; any other prompt gets the block appended under
`Selected commits:`. In non-interactive modes (no TUI) the browser is skipped:
the latest commit is selected and the first eligible `Plan` task (not
`notForCommits`) whose guards pass runs on it.

## Plan questionnaire

Auto-run `Plan` tasks (⚡) are asked to end their reply with a
machine-readable `plan` block: a one-line summary plus the proposed action
items grouped into priority tiers (`P0`, `P1`, …). When the run settles, the
reply is parsed and — if a plan block is present — a **questionnaire** opens
in the TUI. The block is the data channel, but by default it is hidden: as
soon as the reply is finalized, the extension strips the block from the
transcript in the TUI (the prose around it is the human-facing summary), so
the conversation stays clean — the questionnaire still works, because the
raw text is captured before the strip. In non-TUI modes the block stays in
the transcript, so the model can resolve the item-number replies the
notification offers. Set `hidePlan` to `false` (per task or
globally) to keep the block visible. With the questionnaire disabled the
block is not requested at all:

```
  Plan proposal — Review changes
  2 critical bugs, 3 cleanups

  [·] P0 — Critical (0/2)
  ·  Fix null deref in parse()
  ·  Validate input length
  [◐] P1 — Important (1/3)
  ✓  Remove unused imports
  ·  Drop dead config flag
  ·  Tighten error message

  ─────────────────────────────
  Confirm (1/5)
  space/⏎ toggle  •  a all  •  ctrl+u clear  •  e note  •  ⏎ confirm  •  esc withdraw
```

- **↑/↓** (wrapping), **Home/End** move the cursor; **Space** or **Enter**
  toggles the row under the cursor — a tier row toggles the whole tier
  (`·` none → `◐` partial → `✓` all), an item row toggles just that item.
- **a** (or **Ctrl+A**) selects everything; **Ctrl+U** clears the selection.
- **e** on an item row opens a note editor for that item (Enter saves, Esc
  cancels). The note is shown on the row (`✎ …`) and appended to that item
  in the execution prompt — a way to steer an item without retyping it.
- Long plans scroll: the list shows 12 rows at a time and the window follows
  the cursor (**↑/↓**, **Home/End**, or the mouse wheel); a `(n/N)` marker
  shows the position. The `Confirm` row stays pinned.
- **Enter** (or a mouse click) on the pinned `Confirm (n/N)` row sends the
  selection as a single follow-up turn: the agent executes exactly the
  selected items, in tier order, and nothing else. **Esc** withdraws —
  nothing is sent and the proposal is kept in memory; re-open it with
  `/do-always replan` (an accidental Esc is cheap to undo).
- Mouse: clicking a tier/item row toggles it; clicking the Confirm row
  confirms.

Nothing is preselected. A Plan run that finds nothing to do replies with an
empty tier list, and you just get the usual one-line summary. If the reply
has no parseable `plan` block, the questionnaire is disabled, or the mode is
not the TUI, the extension falls back to the plain summary notification —
and when a questionnaire was expected, the notification says why (no plan
block in the reply, or the block is not valid JSON), so a fallback is never
a silent mystery. In non-TUI modes a parseable proposal is listed as a
notification instead, so you can reply with the item numbers to execute. The
questionnaire is offered only on the single auto-run path (selector pick,
`/do-always <n>`, commit picker) — chain steps never get it.

## Tasks configuration

Tasks are read from JSON files (an array of tasks, or the object form `{"tasks": [...], "shortcut": "f4"}`):

|File|Scope|
|---|---|
|`~/.pi/agent/do-always.json`|Global (all projects)|
|`<project>/.pi/do-always.json`|Project-local; overrides global tasks with the same `name`|

If neither file exists, the built-in defaults (Review changes, Review code, Cleanup, Security, Performance, Propose features, Review commits, Browse commits, Build, Tests, Readme, Release, Commit) are used.
This repo ships a sample in [`do-always.json`](./extensions/pi-do-always/do-always.json) — copy it to one of the
locations above to make it your own:

```json
[
  {
    "name": "review",
    "category": "Plan",
    "description": "Review code and double-check changes",
    "prompt": "Review the changes on branch {{branch}} ({{files_changed_count}} changed files: {{files_changed}}). Last commit: {{last_commit}}. Check `git status` and `git diff` ..."
  }
]
```

Fields:

- `name` (required) — short unique id, used for `/do-always <name>`
- `aliases` (optional) — an array of short names that also resolve to this task on the command line. Each alias is case-insensitive and is tried before the task's own name, so `/do-always r` can stand in for `/do-always review`. An invalid value (not an array of strings) is ignored with a warning.
- `category` (optional) — group header the task is shown under in the selector (e.g. `"Plan"`, `"Do"`). Matching is case-insensitive and the header is title-cased, so `"plan"` and `"Plan"` land in the same `Plan` group. Tasks without a category fall under `Other`. The built-in defaults are grouped into `Plan`, `Browse`, `Do`, `Docs`, and `Ops`.
- `description` (optional) — one-line label shown in the selector
- `prompt` (required) — the text filled into the editor (supports `{{placeholders}}` — see [Prompt placeholders](#prompt-placeholders))
- `autoRun` (optional) — when `true`, selecting the task sends its prompt immediately instead of filling the editor; when `false`, it always fills the editor. When omitted, the default is derived from the category: `Plan` tasks auto-run, everything else fills the editor. Auto-run tasks are marked `⚡` in the selector.
- `browser` (optional) — a browser to open on selection instead of injecting the prompt. Only `"commits"` is supported: it opens the date-grouped commit browser, and after the selection the task runs on the selected commits — directly when its prompt references `{{selected_commits}}`, otherwise via a picker of `Plan` tasks (see [Commit browser](#commit-browser)). An invalid value is ignored with a warning.
- `hidden` (optional) — when `true`, the task is not shown in the selector or in `/do-always list` / `list-details`. Unlike a `when` condition, a hidden task can still be run by name (`/do-always <name>`), and it is offered as a candidate by the commit picker. The built-in `Review commits` uses this: it is a pick-after-browse option, not a standalone entry.
- `notForCommits` (optional) — when `true`, the task is excluded from the commit picker (the “run on the selected commits” list) because it does not operate on a set of commits. The task is otherwise unaffected (selector, lists, CLI). The built-in `Review changes`, `Review code`, and `Propose features` use this.
- `questionnaire` (optional) — whether the plan questionnaire is offered after this task's completed run (see [Plan questionnaire](#plan-questionnaire)). Default `true`; set `false` to keep the plain summary notification.
- `hidePlan` (optional) — whether the raw `plan` block is hidden from the transcript after this task's completed run: the fenced block is stripped from the finalized reply (TUI only — in non-TUI modes the block is always kept so the model can resolve item-number replies). Default `true`; set `false` to keep the block visible in the conversation.
- `when` (optional) — a condition that hides the task from the selector and lists when it is not met (see [Conditionals](#conditionals)).
- `guards` (optional) — an array of selection-time guards that block the task (with a message, not a hide) when a condition is unmet (see [Guards](#guards)). The legacy `requireDirty` (boolean) still works and is combined with any `guards`.

In the object form you can also configure the selector shortcut:

- `shortcut` (optional) — key that opens the selector, e.g. `"f4"`. Set to `null` to disable the shortcut. Defaults to `F4`. The project file's value wins over the global one.
- `merge` (optional) — how project tasks combine with the global tasks: `"override"` (default) replaces a global task with the same `name`; `"append"` keeps the global tasks and only adds new project task names (a cascade, like CSS). The project file's value wins over the global one; when neither sets it, the default is `override` (the historical behavior).
- `report` (optional) — whether chain runs write a Markdown report file in the project root (one per run, appended as each step finishes). Default `true`; set `false` to disable. The project file's value wins over the global one. See [Chains](#chains).
- `questionnaire` (optional) — whether completed auto-run tasks whose reply carries a plan block offer the selection questionnaire. Default `true`; set `false` to keep the plain summary notification. The project file's value wins over the global one. See [Plan questionnaire](#plan-questionnaire).
- `hidePlan` (optional) — whether the raw `plan` block is stripped from the transcript after a completed auto-run task (TUI only — in non-TUI modes the block is always kept). Default `true`; set `false` to keep the block visible in the conversation. The project file's value wins over the global one.
- `aliases` (optional) — a global alias map: an object that maps short alias strings to task names, e.g. `{ "rc": "Review changes", "bl": "Build" }`. Each alias is case-insensitive and is tried before the task's own name, so `/do-always rc` resolves to the task named `Review changes`. Keys and values are trimmed; entries with empty keys or non-string values are silently dropped. The project file's value wins over the global one.

```json
{
  "tasks": [ { "name": "review", "prompt": "…" } ],
  "aliases": { "r": "review", "rc": "review changes" }
}
```

Example project file that only *adds* tasks without overriding the global set:

```json
{
  "merge": "append",
  "tasks": [
    { "name": "deploy", "category": "Ops", "prompt": "Deploy this project to staging." }
  ]
}
```

Reload Pi (or start a new session) after editing a config file.

## Prompt placeholders

Task prompts support `{{placeholders}}` that are filled in from the current
directory when a task is selected — so `/do-always review changes` on a hotfix branch
injects “Review the changes on branch `fix/login-null` (3 changed files:
`auth.ts`, `login.ts`, `test/auth.test.ts`) …” instead of a generic nudge.

|Placeholder|Value|
|---|---|
|`{{cwd}}`|Absolute path of the working directory|
|`{{date}}`|Local date (`YYYY-MM-DD`)|
|`{{branch}}`|Current git branch (`unknown` outside a git repo)|
|`{{last_commit}}`|Subject of the latest commit (`unknown` if unavailable, e.g. empty repo)|
|`{{files_changed}}`|Changed files from `git status` — comma-separated, capped at 20 entries (`none` when clean or not a git repo)|
|`{{files_changed_count}}`|Number of changed files (`0` when clean or not a git repo)|
|`{{user}}`|`git config user.name` (`unknown` when unset)|
|`{{diff_stat}}`|`git diff --shortstat` output, e.g. `3 files changed, 41 insertions(+), 7 deletions(-)` (`none` when unavailable)|
|`{{repo}}`|Basename of the git remote (or of the working directory when there is no remote) — disambiguates monorepo work|
|`{{staged_files}}`|Files staged for commit, one per line (`none` when empty)|
|`{{unstaged_files}}`|Modified-but-unstaged files, one per line (`none` when empty)|
|`{{selected_commits}}`|Commits selected in the commit browser, as a numbered detail block (`none` outside a browser run)|

Unknown placeholders are left as-is, and a prompt without placeholders is
injected unchanged, so existing configs keep working. The selector preview and
`/do-always list-details` show the rendered prompt — what you see is what gets
injected.

## Conditionals

A task's `when` field controls whether it is shown in the selector and in
`/do-always list` / `list-details`. When the condition is not met the task is
hidden everywhere (including when picked by number or name), so it can never
be selected into a no-op. Omitting `when` always shows the task.

The string form is a single condition:

- `"git"` — shown only inside a git working tree.
- `"!git"` — shown only outside a git working tree.

The object form is a set of conditions that must **all** hold (logical AND):

| Key | Meaning |
|---|---|
| `"git": boolean` | `true` inside a git repo, `false` outside |
| `"branch": string` | current branch equals the given name (exact match) |
| `"file": string` | path exists (file or directory) relative to the working tree |
| `"repo": string` | equals the git-remote basename context value |

```json
[
  { "name": "review", "category": "Plan", "prompt": "Review the changes…", "when": "git" },
  { "name": "deploy-staging", "category": "Ops", "prompt": "Deploy to staging.", "when": { "branch": "main" } },
  { "name": "lint-js", "category": "Do", "prompt": "Lint the JavaScript.", "when": { "file": "package.json" } }
]
```

An invalid `when` (wrong type, unknown key) is ignored with a warning and the
task is shown, so a typo never silently hides a task. Reload Pi (or start a new
session) after editing a config file.

## Guards

Guards keep low-value round-trips down: the task stays visible, but selecting it
notifies with the reason instead of injecting a no-op prompt. Guards are
evaluated against the current prompt context, so a task is only injected when
**every** guard is met. `requireDirty` (boolean, the historical guard) is
combined with any `guards` array.

The `guards` array accepts these guard objects (all must pass):

| `type` | `value` | Blocks when… |
|---|---|---|
| `requireDirty` | none | the working tree is clean (no changed files) |
| `requireBranch` | branch name | the current branch is not the given name |
| `requireRepo` | repo name | the git-remote basename context value is not the given name |
| `requireFilePattern` | glob | no changed file matches the glob |

For `requireFilePattern`, `*` matches within a path segment, `**` crosses
segments, `?` matches one non-separator character, and other regex
metacharacters are literal.

```json
[
  { "name": "deploy-staging", "category": "Ops", "prompt": "Deploy to staging.", "guards": [ { "type": "requireBranch", "value": "main" } ] },
  { "name": "lint-tests", "category": "Do", "prompt": "Run the test suite.", "guards": [ { "type": "requireFilePattern", "value": "**/*.test.ts" } ] }
]
```

An invalid guard (unknown `type`, missing `value`, or a non-array `guards`)
is ignored with a warning, so a typo never silently disables a guard. Reload Pi
(or start a new session) after editing a config file.

## Development

```bash
npm install        # dev dependencies (pi packages + typescript)
npm run typecheck  # tsc --noEmit
npm test           # run the unit tests (node:test + tsx, in test/)
```

The pure task logic (`parseConfig`, `mergeTasks`, `renderPrompt`, `resolveTask`, `formatList`) lives in
[`tasks.ts`](./extensions/pi-do-always/tasks.ts) with no Pi dependencies, so it is unit-tested independently of the
Pi runtime. The extension (`extensions/pi-do-always/index.ts`) imports that logic and adds only the Pi UI.
