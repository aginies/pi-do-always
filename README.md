# pi-do-always

A [Pi](https://github.com/earendil-works/pi) extension that gives you a `/do-always` command for your
repeated "do the usual" prompts.

Type `/do-always` → a numbered list of tasks appears, grouped by category → press a number,
type to filter, scroll or click, or navigate with arrows + Enter → the task's prompt is
**filled into the input editor**. Review it, tweak it, press Enter to run. Tasks marked `⚡`
(the `Plan` category by default) auto-run on selection instead — see `autoRun` below.

```text
  do-always — pick a task

  PLAN
▸ 1. ⚡ Review             Review code and double-check changes (Plan)
  2. ⚡ Cleanup            Clean up dead code and duplicates (Plan)
  3. ⚡ Security           Security audit (Plan)
  4. ⚡ Performance        Performance review (Plan)
  5. ⚡ Propose features   Propose new features (Plan)
  DO
  6. Build                Test build is ok and fix issues
  7. Tests                Run tests and fix failures
  DOCS
  8. Readme               Update the README.md
  OPS
  9. Release              Prepare a release (version, changelog, tag)
 10. Commit               Prepare a clean commit

  Review — prompt:
  Review the changes on branch fix/login-null (3 changed files: auth.ts, login.ts,
  test/auth.test.ts). Last commit: Fix null check in login. Check `git status` and
  `git diff` to see what changed, then double-check the changes for bugs, edge …

  1-9 pick by number  •  type to filter  •  ↑↓ navigate  •  enter select  •  esc cancel  •  ⚡ auto-runs
```

![do-always — the numbered task selector](pi.image.png)

## Usage

|Command|What it does|
|---|---|
|`/do-always` or the shortcut key (default `F4`)|Show the numbered task selector|
|`/do-always 2`|Fill the prompt for task #2 directly|
|`/do-always review`|Fill the prompt for the task named `review` (task names autocomplete after `/do-always`)|
|`/do-always list`|Print the task list|
|`/do-always list-details`|Show the full rendered prompt text each task will inject|

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

## Tasks configuration

Tasks are read from JSON files (an array of tasks, or the object form `{"tasks": [...], "shortcut": "f4"}`):

|File|Scope|
|---|---|
|`~/.pi/agent/do-always.json`|Global (all projects)|
|`<project>/.pi/do-always.json`|Project-local; overrides global tasks with the same `name`|

If neither file exists, the built-in defaults (Review, Cleanup, Security, Performance, Propose features, Build, Tests, Readme, Release, Commit) are used.
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
- `category` (optional) — group header the task is shown under in the selector (e.g. `"Plan"`, `"Do"`). Matching is case-insensitive and the header is title-cased, so `"plan"` and `"Plan"` land in the same `Plan` group. Tasks without a category fall under `Other`. The built-in defaults are grouped into `Plan`, `Do`, `Docs`, and `Ops`.
- `description` (optional) — one-line label shown in the selector
- `prompt` (required) — the text filled into the editor (supports `{{placeholders}}` — see [Prompt placeholders](#prompt-placeholders))
- `autoRun` (optional) — when `true`, selecting the task sends its prompt immediately instead of filling the editor; when `false`, it always fills the editor. When omitted, the default is derived from the category: `Plan` tasks auto-run, everything else fills the editor. Auto-run tasks are marked `⚡` in the selector.

In the object form you can also configure the selector shortcut:

- `shortcut` (optional) — key that opens the selector, e.g. `"f4"`. Set to `null` to disable the shortcut. Defaults to `F4`. The project file's value wins over the global one.
- `merge` (optional) — how project tasks combine with the global tasks: `"override"` (default) replaces a global task with the same `name`; `"append"` keeps the global tasks and only adds new project task names (a cascade, like CSS). The project file's value wins over the global one; when neither sets it, the default is `override` (the historical behavior).

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
directory when a task is selected — so `/do-always review` on a hotfix branch
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

Unknown placeholders are left as-is, and a prompt without placeholders is
injected unchanged, so existing configs keep working. The selector preview and
`/do-always list-details` show the rendered prompt — what you see is what gets
injected.

## Development

```bash
npm install        # dev dependencies (pi packages + typescript)
npm run typecheck  # tsc --noEmit
npm test           # run the unit tests (node:test + tsx, in test/)
```

The pure task logic (`parseConfig`, `mergeTasks`, `renderPrompt`, `resolveTask`, `formatList`) lives in
[`tasks.ts`](./extensions/pi-do-always/tasks.ts) with no Pi dependencies, so it is unit-tested independently of the
Pi runtime. The extension (`extensions/pi-do-always/index.ts`) imports that logic and adds only the Pi UI.
