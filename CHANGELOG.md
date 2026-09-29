# Changelog

All notable changes to this project will be documented in this file.

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
