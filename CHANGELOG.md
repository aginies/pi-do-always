# Changelog

All notable changes to this project will be documented in this file.

## [Unreleased]

### Added

- **A JSON Schema for `do-always.json`**, shipped in the package
  (`extensions/pi-do-always/do-always.schema.json`) and documented in the
  README: reference it with a `$schema` key — accepted and ignored at runtime —
  and an editor completes and validates the config as you write it. It covers
  both config forms, every task field (`name`, `prompt`, `description`,
  `category`, `aliases`, `mode`, `autoRun`, `questionnaire`, `hidePlan`,
  `browser`, `hidden`, `notForCommits`, `requireDirty`, `guards`, `when`), the
  object-form keys (`shortcut`, `merge`, `report`, `questionnaire`, `hidePlan`,
  `planNudge`, `anyPlan`, `aliases`, `chains`) and the value enums, including
  the conditional `value` requirement on guards. It is deliberately stricter
  than the loader: an unknown key is ignored silently at runtime but rejected by
  the schema, so a typo surfaces in the editor instead of quietly doing nothing.
  A new `test/schema.test.ts` fails the build on drift in either direction — the
  schema's property sets must match what `parseConfig` reads, the shipped sample
  config must be schema-clean, and a config exercising every documented field
  must parse without a single warning.
- **Saved chains**: the config's object form accepts a `chains` object mapping a
  name to its task names in execution order (`{"ship": ["Build", "Tests",
  "Commit"]}`), so a pipeline no longer has to be rebuilt by hand in the
  selector's ORDER column every time — and can now be run at all in non-TUI
  modes, where there is no selector. `/do-always chain` lists them with their
  steps and run-mode glyphs, `/do-always chain <name>` runs one through the
  *same* runner as the selector's chain row (guards and fail-fast, one chain at
  a time, the status widget, the report file, a `fill`-mode step 1 waiting in
  the editor), and both the subcommand and each chain name autocomplete. Names
  match case-insensitively, steps resolve by task name or alias, and the project
  file's chain replaces the global one with the same name. Malformed config is
  refused with a warning rather than half-run: steps are deduplicated (a repeat
  is a mistake, not a loop), a chain over the 8-task cap is dropped, and a chain
  naming a task that does not exist is refused outright, naming the step — the
  runner would otherwise skip it silently and run a shorter chain.
- **A `mode` field on tasks**: the run mode the selector's `ctrl+p` cycles can
  now be stated permanently in the config — `"mode": "plan" | "run" | "fill"` —
  instead of being expressed indirectly through `autoRun` and `questionnaire`.
  When set it wins over both (and over the global `questionnaire` switch); when
  omitted, the mode is derived from them exactly as before, so existing configs
  are untouched. An invalid value is ignored with a warning naming the task.
  `/do-always mode` now reports where each task's mode comes from —
  `(config `mode`)`, `(set in this session)`, or nothing for the derived
  default — and `/do-always mode <task> default` says whether it fell back to
  the config field or to the derivation.

### Fixed

- **`planBlockDiagnostics` called mine-recoverable plan blocks malformed**: the
  0.23.0 tier miner lets `parsePlanProposal` read a block whose containers were
  closed out of order (a stray `]` closing `tiers` early, a root object that
  never closes), but the diagnostics still reported `malformed` as soon as the
  lenient JSON parse failed — so the two disagreed on exactly the blocks mining
  exists for. That was user-visible twice over: `anyPlan`'s capture gate
  requires `kind === "ok"`, so a mine-recoverable block trailing an ordinary
  turn stayed in the transcript as raw JSON with no questionnaire, and
  `/do-always testplan` — the tool that explains parser behavior — misreported
  the same block as unusable. Both now share one normalization path: when the
  JSON does not parse, the miner is consulted before the block is called
  malformed. Genuinely broken JSON still reports `malformed`. The ad-hoc
  capture is thereby widened (a trailing block that was ignored can now open
  the questionnaire); `anyPlan: false` still turns the whole path off.

## [0.25.0] - 2026-11-07

### Added

- **Per-task run modes — switch plan mode off from the selector**: every task
  now runs in one of three modes — `plan` (prompt sent with the plan-block
  instruction, the reply opens the questionnaire), `run` (prompt sent as-is,
  plain summary notification) or `fill` (prompt goes into the editor for review)
  — with the default derived from the config exactly as before (`Plan` category
  with the questionnaire enabled and `autoRun` on → `plan`, any other auto-run
  task → `run`, everything else → `fill`). Press **ctrl+p** with the cursor on a
  task row to cycle `fill → run → plan` for the rest of the session: one press
  on a Plan task disables its plan mode without editing any file. The row marker
  (`⚡` / `▶` / none) and the footer (`ctrl+p ⚡ plan`) show the current mode,
  which the prompt preview and `/do-always list-details` follow. From the
  command line: `/do-always mode` lists the effective modes, `/do-always mode
  <task>` cycles one, and `/do-always mode <task> plan|run|fill|default` sets it
  (`default` drops the override; `on`/`off`/`editor` are accepted aliases). The
  override applies everywhere a task can start — number-pick, Enter, click,
  `/do-always <n|name>`, a chain's first step (`fill` → step 1 waits in the
  editor) and the commit-picker run — and it can switch plan mode *on* for a
  task outside the `Plan` category.

### Changed

- **The plan-block instruction follows the run mode**: it is prepended only for
  a task in `plan` mode. A Plan task with `autoRun: false` used to carry the
  instruction even though nothing consumed the block (the questionnaire is only
  offered on the auto-run path) — it now runs as a plain prompt, and its reply
  keeps whatever the model wrote instead of a JSON block nobody reads.
- **The selector footer survives narrow terminals**: its hints are assembled
  from priority-ordered segments, each one dropped only when it does not fit,
  instead of a single string truncated at the right edge. The run-mode hint
  degrades `ctrl+p ⚡ plan` → `ctrl+p mode` → `ctrl+p`, and the ORDER column
  shows it too.
- **The npm package now ships its test suite**
  (`extensions/pi-do-always/test/*.test.ts`, +156 kB unpacked). 0.23.0 and
  0.24.0 were published from a working copy that was never committed, and
  because the tests were not part of the tarball, the only surviving record of
  what those two releases were supposed to do was their source — the expected
  behavior had to be reconstructed from the published code. A release can now
  be verified, or its tests read, from the registry alone.

### Fixed

- **A tracked auto-run's reply lost a plan block nobody offered**: the ad-hoc
  capture (`anyPlan`, 0.24.0) fired for *any* reply ending with a plan block,
  including the reply of an auto-run that was already being tracked — a
  non-Plan auto-run (e.g. `Build` with `autoRun: true`) or a Plan task switched
  out of plan mode. `agent_end` serves such a run's own summary first and never
  reaches the ad-hoc branch, so the fence was stripped from the transcript and
  the proposal dropped without ever being offered. The ad-hoc capture now skips
  a reply that belongs to an armed auto-run: the block stays visible and the
  run's summary is all you get — which is also what `run` mode promises.

## [0.24.0] - 2026-10-26

### Added

- **Ad-hoc plan proposals** (config `anyPlan`, default on): a plan block no
  longer has to come from a Plan task to be actionable. The plan-block
  instruction stays visible in the conversation context, so models imitate it
  and end an *ordinary* reply with a real proposal — raw JSON in the transcript
  that nobody could act on. Such a reply is now captured exactly like an
  auto-run's block (the raw text is kept for the parser, the fence is stripped
  from the TUI transcript per `hidePlan`) and opens the questionnaire under the
  name `Ad-hoc plan`; confirming sends the selection as the usual execution
  follow-up. The gate is deliberately narrow — the block must be the very last
  thing in the reply and must parse to at least one action item — so a plan
  fence quoted mid-reply (documentation, an example, a discussion of the
  format) is left alone and a reply that goes on after the block is never
  hijacked. Chain steps are excluded, as they are for Plan tasks. Set `anyPlan`
  to `false` (per file, global or project) to restrict proposals to Plan tasks.

## [0.23.0] - 2026-10-22

### Fixed

- **Tiers after a misplaced `]` were silently dropped**: a plan block that
  closed its `tiers` array early — `…"items":[…]}],{"id":"P1",…` instead of
  `…"items":[…]},{"id":"P1",…` — was read only up to the first balanced point,
  so the questionnaire offered the tiers before the stray closer and everything
  after it vanished, with no warning (the block counted as parsed). Plan blocks
  are now also read by *mining* the raw body: every balanced `{ … }` object
  carrying a non-empty `items` array — the plan root and the leaf items
  excluded — is a tier, outermost first, in document order, and the mined
  reading wins whenever it finds more tiers than the structured one. The
  one-line `summary` is recovered from the raw body as well, so a block whose
  root object never closes still opens a complete questionnaire.

## [0.22.0] - 2026-10-12

### Fixed

- **One stray brace in a plan block cost the whole questionnaire**: an agent
  that closed a tier with `}]}},` instead of `}]},` (an extra `}` where a
  comma belongs) produced a block no repair could read — `extractJsonObject`
  scans *past* a closer that does not match what is open, so the stray brace
  survived into every candidate and each `JSON.parse` died on it. The result
  was `plan block was not valid JSON`, no questionnaire, and the raw JSON left
  in the transcript. The lenient parser now repairs mismatched closing tokens,
  preferring the reading that drops the stray closer (which keeps every later
  tier) over the one that closes the open containers at the mismatch (which
  would truncate the block there). Braces inside string literals are never
  treated as structure, and genuinely broken JSON — a missing comma, `{not
  json}` — is still reported as malformed rather than guessed at. Dry-run it
  with `/do-always testplan stray`.
- **Plan questionnaire skipped when the auto-run was interrupted**: an aborted
  or errored Plan run consumed the "pending auto-run" arming, so when the same
  work was finished in a later turn (a plain "continue" after **Esc** or a
  provider error) that reply's `plan` block was neither captured nor stripped —
  no questionnaire, and the raw JSON stayed in the transcript. The Plan task is
  now *owed* a block until a reply carries one (the questionnaire then opens
  exactly as after a clean auto-run) or a completed turn proves the user moved
  on; a run interrupted before the settle that had already emitted the block
  offers it instead of dropping the capture with the run. Non-Plan auto-runs,
  chain steps and new sessions never inherit the debt.
- **Plan block leaked into the transcript when the reply's fence was never
  closed**: the transcript strip only removed closed `plan` fences, so the
  failure mode the lenient parser already recovers (truncated block, leaked
  tool-call XML tags, no closing fence) stayed visible at the end of the
  reply. `stripPlanBlocks` now removes an unclosed plan fence through the
  end of the text as well — guarded so a prose mention of "```plan" without
  a parseable JSON object in its region cannot delete the rest of the reply.
- **Selector preview showed the plan-block instruction instead of the task
  prompt**: for Plan tasks the ten-line plan-block instruction is prepended
  to the injected prompt, and the three-line preview window showed only it.
  The preview now shows the task's own prompt and names the prepended plan
  instruction in a one-line note; the injected prompt is unchanged.

## [0.21.0] - 2026-10-10

### Added

- **Plan-block nudge**: when a completed auto-run Plan task's reply has no
  usable plan block — none at all (the model wrote the plan as plain prose
  and never emitted the required ` ```plan ` fence) or malformed JSON the
  lenient parser could not recover — the extension now sends one follow-up
  asking the agent to emit the block, and the nudge run's reply goes through
  the same capture → parse → questionnaire flow. At most one nudge per run
  (a second miss falls back to the plain summary with the usual "why" note),
  and it only happens where the session stays interactive (TUI/RPC) — print
  mode is one-shot. New `planNudge` config (per file, global or project)
  disables the nudge and restores the old warn-and-fallback behavior.

## [0.20.0] - 2026-10-09

### Added

- **`/do-always testplan [ok|malformed|last]`**: test mode that dry-runs the
  post-plan questionnaire flow (parse → diagnostics → questionnaire →
  execution prompt) without a real Plan run. `ok` (default) uses a
  well-formed sample reply with a closed `plan` block; `malformed` uses the
  failure mode observed in the wild (unclosed fence, JSON cut off before the
  root brace, trailing tool-call XML tags); `last` uses the last assistant
  reply of the session — the way to check why the questionnaire was or
  wasn't offered after a real Plan run. The parser's verdict is always
  reported, and confirming in test mode prints the execution prompt instead
  of sending it (nothing is executed, and the real `/do-always replan`
  state is left untouched).

### Fixed

- **Plan questionnaire silently skipped for malformed plan blocks**: plan
  block parsing is now lenient — an unclosed `plan` fence at the end of a
  reply is still captured, reply text is accumulated across messages when
  the fence is split by trailing tool-call tags, and the JSON is recovered
  even when it is cut off before the root closing brace, contains
  unescaped newlines in strings, or is followed by leaked tool-call XML
  tags (the failure mode observed in the wild). When a plan block still
  cannot be parsed, the completion summary now reports why (malformed JSON
  with the parse error) instead of silently skipping the questionnaire.
  The plan-block instruction is also appended to Plan task prompts that
  don't already mention a plan fence.

## [0.19.0] - 2026-10-09

### Added

- **Task aliases**: tasks can declare an `aliases` array of short names that
  resolve to the task on the command line (e.g. `"aliases": ["r", "rev"]`
  lets `/do-always r` stand in for `/do-always review`). The object-form
  config also accepts a global `aliases` map (e.g.
  `{ "aliases": { "rc": "Review changes" } }`); keys and values are trimmed
  and invalid entries are dropped. Aliases are case-insensitive, are tried
  before the task's own name, and the project file's map wins over the
  global one. Invalid per-task values (not an array of strings) are ignored
  with a warning.

### Changed

- README: the Install section moved to the top (right after the intro),
  and the new `aliases` fields are documented in Tasks configuration.
- Docs: added a `plan_proposal.png` screenshot of the plan questionnaire;
  removed the `PROPOSAL-hide-plan-block.md` proposal document (the feature
  shipped in v0.17.0).

### Fixed

- The built-in `Release` task prompt no longer refers to `package.json`
  specifically: it now says "the project's version manifest" (with examples:
  package.json, Cargo.toml, pyproject.toml, go.mod, pom.xml) and "the
  project's changelog file" (e.g. CHANGELOG.md), so it works for projects
  in any ecosystem.
- The built-in `Build` task prompt no longer assumes npm: it now says
  "the project's build command" (with examples: npm, cargo, go, make, mvn).
  The `Readme` task prompt now says "the project's README (e.g.
  README.md)" instead of assuming `README.md`.

## [0.18.0] - 2026-10-09

### Changed

- The plan-block instruction is now **prepended** to the task prompt instead of
  appended, making it more prominent and reliable — especially in long sessions
  where tail-end instructions are easily ignored.
- The instruction text was restructured: added a clear "Plan block (required):"
  header, the JSON shape is shown on its own line, rules use bullet points,
  and an explicit rule states the fenced block must contain ONLY the JSON with
  no explanation or comments after the closing `}`.

## [0.17.0] - 2026-10-08

### Changed

- The raw `plan` block is now hidden from the transcript after a completed
  auto-run `Plan` task: as soon as the reply is finalized, the fenced block
  is stripped from the message (the questionnaire still parses the captured
  raw text, so the flow is unchanged). The stripped text is what the model
  sees in later turns and what the session file persists. The strip is
  TUI-only — in non-TUI modes the block stays in the transcript so the
  model can resolve the item-number replies the notification offers. Scoped
  to the auto-run `Plan` tasks whose prompt carries the plan-block
  instruction — a `plan` block in a normal conversation, in a non-Plan
  auto-run task's reply, or in a chain step is never touched.
- New task field `hidePlan` (default `true`) and global config `hidePlan`
  (project file wins) to keep the block visible per task or globally.
- The plan execution prompt no longer refers to the proposal "above" — the
  block is no longer in the transcript, so the prompt is self-contained.

### Added

- **`/do-always questionnaire`**: toggle the plan questionnaire on/off for
  the rest of this session, without editing a config file or reloading Pi.
  First call disables, second call re-enables. Per-task `questionnaire`
  config still takes precedence over the global toggle.

## [0.16.0] - 2026-10-08

### Added

- **Plan questionnaire**: auto-run `Plan` tasks now end their reply with a
  machine-readable `plan` block (a summary plus the proposed action items
  grouped into priority tiers). When the run settles, the reply is parsed
  and — in the TUI — a questionnaire opens: select whole tiers or individual
  items (Space/Enter toggles the row under the cursor, a/Ctrl+A selects all,
  Ctrl+U clears), then confirm on the pinned `Confirm (n/N)` row to send the
  selection as a single follow-up turn that executes exactly the selected
  items, in tier order — or Esc to withdraw with no action. Mouse clicks
  toggle rows and confirm. If the reply has no parseable plan block, the
  questionnaire is disabled, or the mode is not the TUI, the plain summary
  notification is kept (non-TUI modes list the proposed items instead, so
  you can reply with the item numbers to execute). Offered only on the
  single auto-run path — chain steps never get it.
- New task field `questionnaire` (default `true`) and global config
  `questionnaire` (project file wins) to disable the questionnaire per task
  or globally.
- **Questionnaire improvements** (same release, additive):
  - The tier/item list now scrolls for long plans: a 12-row window follows
    the cursor (↑/↓, Home/End, or the mouse wheel) with a `(n/N)` position
    marker; the `Confirm` row stays pinned.
  - **e** on an item row opens a note editor (Enter saves, Esc cancels);
    the note is shown on the row (`✎ …`) and appended to that item in the
    execution prompt, so you can steer an item without retyping it.
  - `/do-always replan` re-opens the questionnaire for the last offered
    proposal (e.g. after an accidental Esc); the Esc notification hints at
    it. The proposal is cleared on confirm and on session start.
  - When the questionnaire was expected but no proposal was offered, the
    fallback notification now says why: no `plan` block in the reply, or
    the block is not valid JSON (with the parse error). The parser itself
    is unchanged — the diagnostics mirror its block precedence.

## [0.15.0] - 2026-10-02

### Fixed

- `pi.sendUserMessage` calls now include `{ deliverAs: 'followUp' }` so
  messages are queued when the agent is already processing, instead of
  throwing "Agent is already processing" errors. Affected paths: chain
  step execution, commit browser runs, auto-run Plan tasks, and non-TUI
  fallback sends.

## [0.14.0] - 2026-10-02

### Added

- **Commit browser**: tasks can now declare `browser: "commits"` to open a
  date-grouped browser of recent commits on selection instead of injecting
  the prompt directly. After a selection, a task whose prompt references
  `{{selected_commits}}` runs on that selection directly; the new built-in
  "Browse commits" entry (Browse category, git only) offers a picker of
  eligible Plan tasks (hidden ones included) to run on the selection.
- New task fields: `browser` (validated against `BROWSER_TYPES`, invalid
  values ignored with a warning), `hidden` (hidden from the selector and
  lists, still runnable by name and offered by the commit picker), and
  `notForCommits` (excluded from the commit picker).
- New `{{selected_commits}}` prompt placeholder; `formatSelectedCommits`
  builds the numbered detail block, which a task prompt interpolates (the
  built-in "Review commits" task does) into the review prompt.

### Changed

- Non-TUI modes skip the browser: the latest commit is selected and the
  first Plan task whose guards pass runs on it.
- "Review commits" is now a hidden pick-after-browse option whose prompt
  consumes the commit selection; Review changes, Review code, and Propose
  features are marked `notForCommits`.
- Chains share fresh context builds across steps, and the last step's
  summary uses a single-spawn file count instead of a full build.

### Fixed

- A shared `isTaskVisible` predicate keeps the TUI selector and
  `/do-always <n>` numbering in sync (hidden tasks no longer appear in the
  selector).
- Browser tasks can no longer be added to a chain (keyboard or mouse).
- Guards are now enforced for the task run from the commit picker.

## [0.13.0] - 2026-10-01

### Added

- **Review commits**: new built-in task allowing users to browse recent git commits in pages of 20, select one or more commits to review, and trigger an automated code review with the agent.

### Fixed

- Commit selector: fixed key handling so Space and Enter toggle commit selection properly instead of being intercepted by search filtering.
- Commit selector: fixed pagination and cursor tracking, loading 20 commits per page on demand.
- Commit selector: fixed bug where `rows[cursorRow]` used the wrong array index (line vs. row) and `runLine` was misaligned with the run label.
- Commit selector: fixed bug where `cursorRow` was not clamped after filter changes, potentially causing out-of-bounds errors.
- Commit selector: removed dead code (`commitLine` Map and `clearPreviewTimer` no-op).

## [0.12.0] - 2026-10-01

### Fixed

- `{{last_commit}}` now renders the full commit subject (previously truncated
  to the first word, e.g. `chore:` instead of `chore: release 0.11.0`).
- `{{user}}` no longer includes the `user.name ` key prefix printed by
  `git config --get-regexp` (it rendered as `user.name aginies`).
- `{{staged_files}}` / `{{unstaged_files}}` paths no longer carry a leading
  space: the inline porcelain parse in `buildContext` now shares the
  `slice(3)`-based parsing of `parseStatusPorcelain` via the new
  `parseStatusStagedUnstaged` helper (the two parsers no longer disagree).
- The inline chain report is now an ephemeral editor view (Esc to dismiss)
  instead of a `pi.sendMessage` chat message, which was persisted to the
  session file and context projection with no removal path. Nothing is
  persisted to the session anymore; the report file on disk is the permanent
  artifact. README updated to match.
- The report file's header is deferred until the first step section is
  written, so a session that dies before its first step finishes no longer
  leaves a header-only report file behind.

### Removed

- `chainMove` (exported, tested, but never wired into the selector — the
  README's remove-and-re-add remains the reordering method; wiring
  ↑/↓ reordering into the ORDER column is planned as a separate feature).
- `splitFileLines` (leftover from an earlier implementation, never called).
- `chainSummary`'s unreachable partial branch and `failedStep` parameter
  (the chain-end summary is only reached when every step completed; stop
  paths notify with their own per-step strings).

### Changed

- A single auto-run task whose send fails to start (no agent events at all)
  no longer leaves a stale summary flag: a 10 s grace timer (mirroring the
  chain's failed-to-start handling) clears it and notifies
  `"<task>" failed to start (check model/API key)`, so the next unrelated
  turn can no longer receive a spurious `✓ <task>` summary. The flag is
  also reset on session start.
- Test-only exports (`MAX_FILES_LISTED`, `DEFAULT_CATEGORY_ORDER`,
  `reportFileName`, `formatDuration`) now carry the same "exported for
  tests" doc note `PROMPT_CONTEXT_KEYS` already had, making the convention
  consistent.

### Performance

- The two `git config --get-regexp` calls in context building are merged
  into one (combined regex `^(user.name|remote.origin.url)$`), so a context
  build makes five git calls instead of six. `parseConfigRegexpValue` is
  replaced by `parseConfigRegexpValueForKey(raw, key)`, which extracts one
  key's value from the multi-line output.
- Context building is now async: inside a work tree the four remaining git
  calls run in parallel (`Promise.all` over promisified `execFile`), so
  wall time drops from ~5 sequential spawns to ~1. Outside a work tree only
  the single `rev-parse` call runs, as before. The `session_start`
  precompute is async as a result.
- A new extension-level context cache (keyed by cwd, 5 s TTL) sits under
  the per-action cache: the `session_start` precompute now feeds the first
  `/do-always` invocation, and repeated invocations within the window reuse
  the same context instead of rebuilding it. The cache is invalidated on
  `agent_end` (the agent may have changed the repo); a running chain keeps
  its per-action snapshot, so all of its steps still share one context.
- The selector computes the visible table state once per input event /
  render pass and reuses it (`clampCursor` and `buildTable` now take the
  precomputed state), cutting the per-keystroke recomputation from 2–3
  passes to 1.
- The two `[...event.messages].reverse().find(...)` scans in the
  `agent_end` handler are replaced by a single backward-scan helper
  (`lastAssistantMessage`) plus a shared `outcomeFromStopReason` mapping —
  no per-turn array copy, and the duplicated outcome logic is deduped.

## [0.11.0] - 2026-09-30

### Changed

- The inline chain report is now bounded: only the last 3 step sections
  are kept in memory (the report file on disk still holds every step), so
  long chains no longer hold megabytes of assistant text per run.
- Changed files are listed in locale-aware order (`localeCompare`)
  instead of code-unit order.

### Fixed

- The inline chain report now numbers sections by their step index
  (previously every section was headed `## 1.`), uses the same `(retry)`
  names as the report file, and flags omitted steps with a pointer to the
  file when the chain had more steps than the in-memory window.
- `parseStatusPorcelain` dedupes with a `Set` (O(n) instead of the
  O(n²) `files.includes`).
- Dropped the identity-keyed memoization around `groupTasksByCategory`:
  every caller passes a fresh array, so it never hit, and it would have
  served stale groups if a caller ever mutated its array in place.

## [0.10.0] - 2026-09-29

### Added

- **Task chains**: the selector is now a task table with an `ORDER` column and a
  pinned `Run the chain (n)` row. → moves the cursor to the ORDER column, where
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
- **Chain status widget**: while a chain is running, a widget below the prompt
  lists the chain's tasks with per-step markers (✓ completed, ▶ running/waiting,
  ○ pending, ✗ errored, ⊘ aborted, – skipped) and a `(n/N)` progress count. It is
  removed when the chain completes and kept as a trace when it stops early; a
  second chain is refused while one is running.
- **Chain report file**: every chain run writes `do-always-report-tasks-YYYY-MM-DD-HHMM.md`
  in the project root (e.g. `do-always-report-tasks-2025-01-15-1432.md`), so earlier
  steps' results survive later steps' output scrolling them off screen. Each step
  appends a section as it finishes — its outcome, run time, and final assistant
  message — so the file is complete even if the session dies mid-chain; a footer
  with the overall summary is appended when the chain ends. When a report was
  written, the completion widget stays below the prompt pointing at the file and
  the completion notification carries its path. Same-minute runs get `-2`, `-3`, …
  suffixes. New config field `report` (boolean, default `true`) disables it.
- **Inline report display**: when a chain completes fully, the full
  Markdown report is also sent as a chat message, so results are visible
  without opening the file. It is removed on the next prompt or session;
  chains that stop early keep the trace widget pointing at the file.

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
- Context building is batched: 9 synchronous git spawns per use became 5
  (combined `rev-parse`, `log -1`, `config --get-regexp`,
  `status --porcelain`, `diff --shortstat`), and the result is cached for
  the duration of one command run.
- Selector and chain rendering use O(1) Map lookups instead of O(n²)
  `indexOf`/`findIndex`/`find`, and the selector's table is built once per
  render and reused for mouse hit-testing.
- Removed dead code (`landOnOrderColumn`, the never-rendered
  `chainReport.content` field) and unnecessary exports from `tasks.ts`.

### Fixed

- Config validation warnings (malformed JSON, invalid tasks/shortcut/merge/
  when/guards) are no longer silently swallowed: `loadConfig` threads an
  `onError` callback and the extension reports problems via `ui.notify`
  (warning) in TUI mode and `console.warn` otherwise, as the README promises.
- The CI and publish workflows now run on Node 22, matching `engines.node`
  (`>=22.19.0`) instead of Node 20.
- The test suite is now typechecked: `tsconfig.json` includes the test
  directory.
- `when: file` conditions can no longer probe paths outside the project
  root: the existence check resolves the path and verifies it stays under
  the working directory, rejecting `../../.ssh/id_rsa`-style values.

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
