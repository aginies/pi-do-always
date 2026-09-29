# Changelog

All notable changes to this project will be documented in this file.

## [Unreleased]

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
