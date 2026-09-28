# pi-do-always

A [Pi](https://github.com/earendil-works/pi) extension that gives you a `/do-always` command for your
repeated "do the usual" prompts.

Type `/do-always` → a numbered list of tasks appears → press a number (or arrows + Enter) →
the task's prompt is **filled into the input editor**. Review it, tweak it, press Enter to run.

```text
┌ do-always — pick a task                                           ┐
│ 1. review   — Review code and double-check changes                │
│ 2. readme   — Update the README                                   │
│ 3. tests    — Run tests and fix failures                          │
│ 4. commit   — Prepare a clean commit                              │
│ 5. cleanup  — Propose a plan to clean up dead code and duplicates │
│ 6. release  — Prepare a release (version, changelog, tag)         │
│ 7. security — Security audit — plan proposal                      │
│ 8. perf     — Performance review — plan proposal                  │
└───────────────────────────────────────────────────────────────────┘
```

![do-always — the numbered task selector](pi.image.png)

## Usage

|Command|What it does|
|---|---|
|`/do-always` or the shortcut key (default `F4`)|Show the numbered task selector|
|`/do-always 2`|Fill the prompt for task #2 directly|
|`/do-always review`|Fill the prompt for the task named `review` (task names autocomplete after `/do-always`)|
|`/do-always list`|Print the task list|
|`/do-always list-details`|Show the full prompt text each task will inject|

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

For development you can also load it explicitly: `npm run dev` (runs `pi --extension ./index.ts`).

## Tasks configuration

Tasks are read from JSON files (an array of tasks, or the object form `{"tasks": [...], "shortcut": "f4"}`):

|File|Scope|
|---|---|
|`~/.pi/agent/do-always.json`|Global (all projects)|
|`<project>/.pi/do-always.json`|Project-local; overrides global tasks with the same `name`|

If neither file exists, the built-in defaults (review, readme, tests, commit, cleanup, release, security, perf) are used.
This repo ships a sample in [`do-always.json`](./do-always.json) — copy it to one of the
locations above to make it your own:

```json
[
  {
    "name": "review",
    "description": "Review code and double-check changes",
    "prompt": "Review the recent code changes in this project. Check `git status` and `git diff` ..."
  }
]
```

Fields:

- `name` (required) — short unique id, used for `/do-always <name>`
- `description` (optional) — one-line label shown in the selector
- `prompt` (required) — the text filled into the editor

In the object form you can also configure the selector shortcut:

- `shortcut` (optional) — key that opens the selector, e.g. `"f4"` or `"ctrl+shift+p"`. Set to `null` to disable the shortcut. Defaults to `F4`. The project file's value wins over the global one.

Reload Pi (or start a new session) after editing a config file.

## Development

```bash
npm install        # dev dependencies (pi packages + typescript)
npm run typecheck  # tsc --noEmit
npm test           # run the unit tests (node:test + tsx, in test/)
```

The pure task logic (`parseConfig`, `mergeTasks`, `resolveTask`, `formatList`) lives in
[`tasks.ts`](./tasks.ts) with no Pi dependencies, so it is unit-tested independently of the
Pi runtime. The extension (`index.ts`) imports that logic and adds only the Pi UI.

No build step is needed — Pi loads the TypeScript directly via jiti.

## Publishing

To publish on npm:

```bash
npm login
npm publish
```

`@earendil-works/pi-coding-agent` and `@earendil-works/pi-tui` are declared as `peerDependencies`
with a `"*"` range and are **not** bundled — Pi supplies them to extensions. The `pi-package`
keyword makes this package eligible for the [Pi package gallery](https://pi.dev/packages).

The gallery page is built from `package.json` (name, description, author, version, license,
repository, `pi` manifest) plus the README. Optional `pi.image` / `pi.video` fields in
`package.json` add a gallery preview if you want one.
