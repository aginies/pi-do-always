# Changelog

All notable changes to this project will be documented in this file.

## [0.10.0] - 2026-09-29

### Added

- **Task chains**: the selector is now a task table with an `ORDER` column and a
  pinned `▶ Run the chain (n)` row. → moves the cursor to the ORDER column, where
  Enter toggles the task's chain membership; Enter (or a click) on the Run row runs
  the chain. ↑/↓ move the cursor in either column, Backspace (no filter) undoes the
  last add, ctrl+u clears, and clicking an ORDER cell toggles membership. The cursor
  is a full-row highlight. Chains are capped at 8 tasks; on narrow terminals the
  ORDER column is dropped in favor of a chain line below the list.
- **Chain execution**: steps run strictly sequentially — each step is its own turn
  and the next starts only after the previous run has fully settled. Each step's
  guards are re-evaluated at its turn; a blocked, aborted, or errored step stops
  the chain (steps already run are kept). Fill-first chains (non-⚡ step 1 in the
  TUI) put step 1 in the editor and continue automatically once that run finishes.

### Changed

- The selector's Enter key is now context-dependent: on a task row it runs just
  that task (the 0.9.0 behavior, unchanged), on an ORDER cell it toggles chain
  membership, and on the Run row it runs the chain. All existing config fields,
  commands, and the shortcut are unchanged.

### Changed

- The prompt context is now a structured object (`TaskContext`) instead of a
  flat string record: `when` conditions and guards are evaluated against the
  structured data, and the string view for prompt rendering is derived from it
  (`toPromptContext`). The rendered `files_changed` string is still capped at
  20 paths for display, but `files_changed_count` and the guards always see
  the complete file list.
- `requireFilePattern` no longer re-parses the capped, comma-joined
  `files_changed` string: it matches against the full changed-file list, so
  files beyond the display cap are considered and filenames containing commas
  are no longer split into false paths.
- `requireDirty` is evaluated from the structured file list instead of the
  stringly-typed `files_changed_count`.
- `when: git` (and `{ "git": true|false }`) now uses an authoritative
  `git rev-parse --is-inside-work-tree` check instead of inferring git status
  from the branch name, so a branch literally named "unknown" (or a detached
  HEAD) no longer makes a git repo look non-git.
- Argument completions for `/do-always` now number tasks by position in the
  visible (`when`-filtered) list — the same list the selector and
  `/do-always <n>` use — instead of the unfiltered task list.
- The selector shortcut is now registered from the `session_start` handler
  using the session's cwd instead of `process.cwd()` at extension load, so a
  project-local `shortcut` setting applies to the active project and a changed
  shortcut takes effect on a new session.
- The selector preview and the injected prompt are rendered from the same
  context object, so the preview shows exactly what gets injected.
- The shipped sample config `extensions/pi-do-always/do-always.json` now
  matches the built-in `DEFAULT_TASKS` exactly (it had drifted: missing
  `{{diff_stat}}` summary in `Review changes`, missing `when: git` on
  `Release`/`Commit`, missing `requireDirty` on `Commit`, and a stray
  `autoRun: false` on `Cleanup`). A unit test fails the build if the sample
  drifts again.
- The README placeholder table now documents every supported placeholder
  (`{{diff_stat}}`, `{{repo}}`, `{{staged_files}}`, `{{unstaged_files}}`).

### Fixed

- Config validation warnings (malformed JSON, invalid tasks/shortcut/merge/
  when/guards) are no longer silently swallowed: `loadConfig` threads an
  `onError` callback and the extension reports problems via `ui.notify`
  (warning) in TUI mode and `console.warn` otherwise, as the README promises.
- The CI and publish workflows now run on Node 22, matching `engines.node`
  (`>=22.19.0`) instead of Node 20.
- The test suite is now typechecked: `tsconfig.json` includes the test
  directory.

## [0.8.0] - 2026-09-29

### Added

- Split the built-in `Review` task into two distinct tasks, since reviewing the
  working-tree diff and reviewing the codebase as a whole are different jobs:
  - `Review changes` (renamed from `Review`, keeping `requireDirty`) reviews the
    current working-tree changes.
  - `Review code` (new) reviews the whole project's code quality holistically
    (smells, dead code, duplication, architecture/patterns, maintainability,
    docs) without requiring a dirty tree.

### Changed

- The built-in default task list now starts with `Review changes` then
  `Review code` (previously a single `Review`), so the selector shows both
  review modes. The README and sample config reflect the new names.

## [0.7.0] - 2026-09-29

### Added

- Extended task guards: a new `guards` array on tasks generalizes the
  `requireDirty` guard into a small table of selection-time guards. Each guard
  blocks the task (with a message, not a hide) when its condition is unmet, and
  all guards must pass for the task to be injected. New guards: `requireBranch`
  (only on a given branch), `requireRepo` (only in a specific repo), and
  `requireFilePattern` (only when a glob matches a changed file — `*` stays in a
  segment, `**` crosses segments, `?` matches one non-separator character).
  `requireDirty` (boolean) still works and is combined with any `guards`. An
  invalid guard is ignored with a warning. Covered by unit tests.

## [0.6.0] - 2026-09-29

### Added

- Task `when` condition: a task is shown in the selector and in `list` /
  `list-details` only when its `when` condition is met, and hidden everywhere
  (including when picked by number or name) otherwise, so context-irrelevant
  tasks never become no-ops. The string form is a single condition (`"git"` /
  `"!git"`); the object form is a set of conditions that must all hold (logical
  AND) — `"git"` (boolean), `"branch"` (exact match), `"file"` (path exists),
  or `"repo"` (git-remote basename). An invalid `when` is ignored with a
  warning (the task is shown), so a typo never silently hides a task. The pure
  `evaluateWhen` / `isValidWhen` helpers cover it with unit tests.

### Changed

- The built-in `Release` and `Commit` tasks now require a git repo (`when: "git"`),
  matching the git-only nature of those commands.

## [0.5.0] - 2026-09-29

### Added

- Merge mode for config files: the object form now accepts `"merge": "append"`,
  which keeps the global tasks and only adds new project task names (a cascade),
  instead of overriding global tasks by name. `"override"` (the default) keeps the
  historical behavior where a project task replaces the global task with the same
  `name`. The project file's value wins over the global one; when neither sets it,
  the default is `override`, so existing configs are unaffected. The pure
  `mergeTasks` helper gains a `mode` parameter and is covered by new unit tests.

## [0.4.5] - 2026-09-29

### Added

- New prompt placeholders filled from the git state of the current directory:
  `{{diff_stat}}` (e.g. "3 files changed, 41 insertions(+), 7 deletions(-)"),
  `{{repo}}` (basename of the git remote or the working directory, to
  disambiguate monorepo work), and `{{staged_files}}` / `{{unstaged_files}}`
  (file lists for staged vs. unstaged changes). Unknown placeholders are left
  as-is, so existing prompts are unaffected. The built-in Review task now
  includes `{{diff_stat}}` so prompts are concrete.
- Task guards: a new optional `requireDirty` field (parsed from config) blocks a
  task when the working tree is clean (`files_changed_count === 0`). Selecting a
  guarded task on a clean tree now notifies "working tree is clean — nothing to
  review" instead of injecting a no-op prompt. The built-in Review and Commit
  tasks are guarded by default; guards are evaluated by the new pure
  `evaluateGuards` helper and can be extended with more conditions later.

## [0.4.4] - 2026-09-29

### Changed

- No functional changes. Version bump to re-trigger publication (0.4.3
  was already published to npm with identical contents).

## [0.4.3] - 2026-09-29

### Changed

- Removed the version-pinned pi packages from `devDependencies`; they are
  declared in `peerDependencies` with a `*` range (Pi supplies them at
  runtime) and npm installs them automatically.
- Added `repository.directory` so the npm page links to the extension
  source under `extensions/pi-do-always/`.
- Dropped the redundant `pi` and `pi-coding-agent` npm keywords.

## [0.4.2] - 2026-09-29

### Changed

- Moved the extension source under `extensions/pi-do-always/`; the package
  manifest now declares `pi.extensions` pointing at
  `./extensions/pi-do-always/index.ts` (install behavior is unchanged: `pi
  install npm:pi-do-always` still works).

### Fixed

- Removed the duplicate `pi-extensions` npm keyword.

## [0.4.1] - 2026-09-29

### Changed

- Declared `engines.node >=22.19.0` (matching pi's own requirement) and added
  the `pi-extension` keyword for npm discoverability.
- Tightened the built-in Commit task prompt wording.

## [0.4.0] - 2026-09-29

### Added

- Context-aware prompt templating: task prompts support `{{placeholders}}`
  (`{{cwd}}`, `{{date}}`, `{{branch}}`, `{{last_commit}}`, `{{files_changed}}`,
  `{{files_changed_count}}`, `{{user}}`) that are filled in from the current
  directory at selection time. Unknown placeholders are left as-is and prompts
  without placeholders are unchanged. The selector preview and `list-details`
  show the rendered prompt (what you see is what gets injected). The built-in
  Review, Commit, and Release tasks now use the git placeholders.
- Prompt preview in the selector: pause on a task for two seconds and its full
  prompt is shown below the list, so you can see exactly what will be injected
  before running it. Moving the selection or typing hides it and restarts the
  delay.
- Opt-in auto-run for tasks: a task marked `⚡` sends its prompt immediately on
  selection instead of filling the editor. The `Plan` category auto-runs by
  default; any task can opt in or out with the new `autoRun` field (`true`/
  `false`).

## [0.3.0] - 2026-09-29

### Added

- New built-in **Propose features** task: reviews the project and proposes new
  features (problem solved, user benefit, rough approach), prioritized by
  impact and effort.
- Optional `category` field on tasks. Tasks are shown in the selector grouped
  under category headers (`Plan`, `Do`, `Docs`, `Ops`, `Other`).
- Mouse support in the selector: wheel to scroll and left-click to select a
  task.

### Changed

- The `/do-always` selector now groups tasks by category instead of a flat
  numbered list. It also supports typing to filter the list live, in addition
  to picking by number (1-9) or navigating with arrows + Enter.
- Category grouping is now case-insensitive with title-cased headers, so
  `"plan"` and `"Plan"` land in the same `Plan` group.
- The task list is ordered by category, so the selector numbers tasks
  sequentially across groups and number-pick, `/do-always <n>`, `list`, and
  autocompletion all agree on the same numbering.
- The non-TUI `/do-always list` now prints a header per category when tasks
  span more than one group (matching the selector).
- The selector renders a width-aware two-column layout and falls back to a
  label-only line on narrow terminals instead of overflowing.

### Fixed

- Number-pick (1-9) is disabled while a filter is active, so typed digits
  refine the filter instead of selecting a task.

## [0.2.2] - 2026-09-29

### Changed

- Bumped the version to `0.2.2` in `package.json` and `package-lock.json` for
  npm publication.

### Added

- New **Build** task: runs the project build script (e.g. `npm run build`) and
  type check, diagnoses and fixes failures, and re-builds until green.

### Fixed

- Use a POSIX-compatible glob pattern in the test script so `npm test` runs
  correctly across shells.
- CI: fixed release prerelease validation and branch triggers.

### Other

- Reorganized the built-in default tasks in `tasks.ts`: task names are now
  capitalized (e.g. `review` → `Review`) and reordered, with the new Build task
  placed alongside the other actionable tasks.
- Updated the README.

## [0.2.0] - 2026-09-28

### Added

- Gallery publication metadata in `package.json`: `author` (aginies
  <antoine@ginies.org>), an MIT `LICENSE` file, and gallery-discovery
  keywords (`pi`, `pi-coding-agent`).
- `pi.image.png` gallery preview image, wired up via the `pi.image` field
  and referenced in the README.

### Changed

- Documented in the README which `package.json` fields the Pi package
  gallery page is built from, and the optional `pi.image` / `pi.video`
  preview fields.

## [0.1.0] - 2026-09-28

### Added

- `/do-always` command: numbered selector of common tasks (review, readme,
  tests, commit, cleanup, release, security, perf). Pick by number (1-9) or
  arrows + Enter; the selected task's prompt is filled into the input editor
  (sent as a user message in non-TUI modes).
- Keyboard shortcut to open the selector (default `F4`, configurable via the
  `shortcut` field in `do-always.json`; `null` disables it).
- Task configuration from JSON files: `~/.pi/agent/do-always.json` (global)
  and `<project>/.pi/do-always.json` (project-local, overrides global tasks
  by name). Falls back to built-in default tasks when no config exists.
- `/do-always <number|name>` to fill a task's prompt directly, with task-name
  argument autocompletion; `/do-always list` and `/do-always list-details`
  to inspect tasks and their injected prompts.
- `tasks.ts`: pure task logic (config parsing/validation, merging, shortcut
  resolution, task lookup, list formatting) with no Pi dependencies.
- Unit tests (26, `node:test` + tsx) covering config parsing, shortcut
  resolution/merging, task lookup, and list formatting.
- Sample config (`do-always.json`), README with usage/install/development
  docs, and npm packaging metadata (`pi-package` keyword, Pi packages as
  peerDependencies).
