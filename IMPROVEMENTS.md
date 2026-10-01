# Code Review & Recommended Improvements: `pi-do-always`

This document details identified improvement areas, edge cases, and recommendations for `@extensions/pi-do-always/index.ts` and `@extensions/pi-do-always/tasks.ts`.

---

## Table of Contents

1. [High Priority: Functional Edge Cases & Consistency](#1-high-priority-functional-edge-cases--consistency)
   - [1.1 Git Context Resolution in Empty / Unborn Repositories](#11-git-context-resolution-in-empty--unborn-repositories)
   - [1.2 Stale Context Snapshot in Sequential Chain Steps](#12-stale-context-snapshot-in-sequential-chain-steps)
   - [1.3 Fill-First Step 1 Human Idle Time in Duration Metrics](#13-fill-first-step-1-human-idle-time-in-duration-metrics)
   - [1.4 Approximate Timestamps & Section Parity in Inline Report](#14-approximate-timestamps--section-parity-in-inline-report)
2. [Medium Priority: Robustness & Data Parsing](#2-medium-priority-robustness--data-parsing)
   - [2.1 Safe File Reading in `loadConfig`](#21-safe-file-reading-in-loadconfig)
   - [2.2 Git Porcelain Parsing: Quoted Filenames and Renames](#22-git-porcelain-parsing-quoted-filenames-and-renames)
   - [2.3 Unbounded `staged_files` and `unstaged_files` in Prompts](#23-unbounded-staged_files-and-unstaged_files-in-prompts)
   - [2.4 TUI Lifecycle Cleanup on Invalidation](#24-tui-lifecycle-cleanup-on-invalidation)
3. [Low Priority: Ergonomics, Typing & Code Polish](#3-low-priority-ergonomics-typing--code-polish)
   - [3.1 Narrow Viewport Cursor Visibility in ORDER Column](#31-narrow-viewport-cursor-visibility-in-order-column)
   - [3.2 Extended Navigation Keys (`Home`, `End`, `PageUp`, `PageDown`)](#32-extended-navigation-keys-home-end-pageup-pagedown)
   - [3.3 Exporting `Guard` Interface and Type Guards](#33-exporting-guard-interface-and-type-guards)
   - [3.4 Source Indentation & Formatting Cleanups](#34-source-indentation--formatting-cleanups)

---

## 1. High Priority: Functional Edge Cases & Consistency

### 1.1 Git Context Resolution in Empty / Unborn Repositories
* **Location:** `extensions/pi-do-always/index.ts` (`buildContext`)
* **Current Behavior:**
  ```ts
  const revParse = await git(cwd, ["rev-parse", "--abbrev-ref", "HEAD", "--is-inside-work-tree"]);
  const lines = revParse ? revParse.split("\n") : [];
  const branch = lines[0] ?? "unknown";
  const isGitRepo = lines[1] === "true";
  ```
  In a newly created repository (`git init`) before an initial commit has been made, `HEAD` points to an unborn branch and does not reference any commit object. `git rev-parse --abbrev-ref HEAD` exits with `128 (fatal: ambiguous argument 'HEAD')`.
  `revParse` resolves to `undefined`, which evaluates `isGitRepo = false`. As a consequence:
  - `buildContext` immediately aborts git checks and returns neutral non-git fallbacks.
  - Tasks conditioned on `when: "git"` (e.g., `Commit`) are hidden.
  - Staged and untracked files intended for the initial commit are ignored (`files: []`).
* **Proposed Improvement:**
  Decouple the repository detection check from revision parsing:
  ```ts
  // 1. Authoritative check: are we inside a work tree?
  const inside = await git(cwd, ["rev-parse", "--is-inside-work-tree"]);
  const isGitRepo = inside === "true";

  if (!isGitRepo) {
      return {
          cwd,
          date: new Date().toLocaleDateString("en-CA"),
          branch: "unknown",
          lastCommit: "unknown",
          files: [],
          user: "unknown",
          diffStat: "none",
          repo: cwd.split(/[\\/]/).filter(Boolean).pop() ?? "unknown",
          stagedFiles: [],
          unstagedFiles: [],
          isGitRepo: false,
      };
  }

  // 2–6. Inside a work tree: query branch and other facts concurrently
  const [branchOut, lastCommitLine, configLine, porcelain, diffStat] = await Promise.all([
      // --show-current works on initial/unborn branches and returns empty on detached HEAD
      git(cwd, ["branch", "--show-current"]),
      git(cwd, ["log", "-1", "--format=%H %s"]),
      git(cwd, ["config", "--get-regexp", "^(user\\.name|remote\\.origin\\.url)$"]),
      git(cwd, ["status", "--porcelain"]),
      git(cwd, ["diff", "--shortstat"]),
  ]);

  const branch = branchOut || (await git(cwd, ["rev-parse", "--short", "HEAD"])) || "unknown";
  ```

---

### 1.2 Stale Context Snapshot in Sequential Chain Steps
* **Location:** `extensions/pi-do-always/index.ts` (`runChainSteps`)
* **Current Behavior:**
  ```ts
  if (outcome === "completed") {
      setChainStep(ctx, i, "completed");
      // Post-step summary: files changed + duration.
          const postContext = await cache.get(ctx.cwd);
      const fileCount = postContext.files.length;
      const summary = stepSummary(outcome, step.name, stepDuration, fileCount);
      ctx.ui.notify(`do-always: step ${i + 1}/${steps.length} — ${summary}`, "info");
      continue;
  }
  ```
  `cache` is an instance of `createContextCache()`, which caches `cached.ctx` indefinitely for the action. While `pi.on("agent_end")` invalidates the extension-level TTL cache (`contextCache = null`), the action-local `cache` never clears its reference.
  - `postContext.files.length` always reports the file count from before step 1 ran.
  - If subsequent steps have guards (e.g. `requireDirty: true`), `await cache.get(ctx.cwd)` checks the stale context from before the chain started rather than reflecting working tree modifications or commits made by earlier steps.
* **Proposed Improvement:**
  In `runChainSteps`, query fresh context directly or invalidate `cache` between steps:
  ```ts
  // After a step completes:
  const postContext = await getContext(ctx.cwd);
  const fileCount = postContext.files.length;
  ```
  And before evaluating guards for step `i`:
  ```ts
  const context = await getContext(ctx.cwd);
  const blocked = evaluateGuards(step, context);
  ```

---

### 1.3 Fill-First Step 1 Human Idle Time in Duration Metrics
* **Location:** `extensions/pi-do-always/index.ts` (`runChain`)
* **Current Behavior:**
  ```ts
  const fillStart = performance.now();
  void armWaiter(undefined, 0).then(async (outcome) => {
      chainDurations[0] = performance.now() - fillStart;
  ...
  ```
  If task 1 is not auto-run, its prompt is inserted into the editor. `fillStart` is recorded at editor fill time. If the user inspects and modifies the prompt for 2 minutes before pressing Enter, `chainDurations[0]` reports `2m + execution time`.
  Meanwhile, `chainReport.stepStartedAt` in `agent_start` measures from when the agent begins running, leading to conflicting duration reports.
* **Proposed Improvement:**
  Track step 0's active execution duration starting at `agent_start`:
  ```ts
  let activeStepStart = 0;

  pi.on("agent_start", () => {
      activeStepStart = performance.now();
      // ...
  });
  ```
  Then in the fill-first callback:
  ```ts
  chainDurations[0] = activeStepStart > 0 ? performance.now() - activeStepStart : 0;
  ```

---

### 1.4 Approximate Timestamps & Section Parity in Inline Report
* **Location:** `extensions/pi-do-always/index.ts` (`showInlineReport`)
* **Current Behavior:**
  ```ts
  for (const sec of chainReport.sections) {
      const section = reportStepSection(
          sec.index,
          sec.name,
          sec.outcome,
          new Date(), // approximate start
          new Date(), // approximate end
          sec.text,
      );
      lines.push(section);
  }
  ```
  Passing `new Date()` for both start and end causes every step section in the ephemeral editor report to show identical start/end times (e.g. `14:30 → 14:30`), diverging from the actual report written to disk.
* **Proposed Improvement:**
  In `agent_end`, `const section = reportStepSection(...)` is already formatted with the exact timestamps. Store `section` (or the actual `startedAt` and `endedAt` dates) directly:
  ```ts
  chainReport.sections.push({
      index: idx,
      section, // pre-rendered markdown section
  });
  ```
  In `showInlineReport`:
  ```ts
  for (const sec of chainReport.sections) {
      lines.push(sec.section);
      lines.push("");
  }
  ```
  This guarantees that the inline view exactly matches the markdown file on disk.

---

## 2. Medium Priority: Robustness & Data Parsing

### 2.1 Safe File Reading in `loadConfig`
* **Location:** `extensions/pi-do-always/index.ts` (`loadConfig`)
* **Current Behavior:**
  ```ts
  const project = existsSync(projectPath)
      ? parseConfig(readFileSync(projectPath, "utf-8"), projectPath, onError)
      : ...;
  ```
  If `projectPath` exists but cannot be read (e.g. permission denied `EACCES`, locked by another process, or pointing to a directory `EISDIR`), `readFileSync` throws an unhandled synchronous exception that halts extension initialization.
* **Proposed Improvement:**
  Wrap file reads in a helper:
  ```ts
  function readConfigFile(filePath: string, onError: (msg: string) => void): string | null {
      try {
          return readFileSync(filePath, "utf-8");
      } catch (err) {
          onError(`do-always: could not read ${filePath}: ${err}`);
          return null;
      }
  }
  ```

---

### 2.2 Git Porcelain Parsing: Quoted Filenames and Renames
* **Location:** `extensions/pi-do-always/tasks.ts` (`parseStatusPorcelain`, `parseStatusStagedUnstaged`)
* **Current Behavior:**
  1. **Quotes:** Git porcelain wraps paths containing whitespace or non-ASCII characters in double quotes (e.g. `"src/my file.ts"`). `line.slice(3)` preserves these quotes, which breaks glob matching in `requireFilePattern` (e.g. `*.ts` will not match `"src/my file.ts"` because of the trailing quote).
  2. **Renames:** When a file is renamed (`R  old.ts -> new.ts`), `line.slice(3)` produces `"old.ts -> new.ts"` as a single combined path.
* **Proposed Improvement:**
  Normalize paths when parsing porcelain output:
  ```ts
  function extractPorcelainPath(line: string): string | null {
      if (line.length < 4) return null;
      let path = line.slice(3).trim();
      if (path.includes(" -> ")) {
          path = path.split(" -> ").pop()!.trim();
      }
      if (path.startsWith('"') && path.endsWith('"')) {
          path = path.slice(1, -1).replace(/\\"/g, '"');
      }
      return path || null;
  }
  ```

---

### 2.3 Unbounded `staged_files` and `unstaged_files` in Prompts
* **Location:** `extensions/pi-do-always/tasks.ts` (`toPromptContext`, `formatFileLines`)
* **Current Behavior:**
  `files_changed` is capped at `MAX_FILES_LISTED = 20` with a summary suffix (`… (+N more)`). However, `formatFileLines` returns every staged/unstaged file without bounds:
  ```ts
  function formatFileLines(files: string[]): string {
      return files.length === 0 ? "none" : files.join("\n");
  }
  ```
  In repositories with hundreds or thousands of staged files, injecting `{{staged_files}}` can overwhelm editor buffers and token context.
* **Proposed Improvement:**
  Cap newline-separated lists similarly:
  ```ts
  export const MAX_FILE_LINES = 50;

  function formatFileLines(files: string[]): string {
      if (files.length === 0) return "none";
      if (files.length > MAX_FILE_LINES) {
          const shown = files.slice(0, MAX_FILE_LINES);
          const remaining = files.length - MAX_FILE_LINES;
          return [...shown, `… (+${remaining} more)`].join("\n");
      }
      return files.join("\n");
  }
  ```

---

### 2.4 TUI Lifecycle Cleanup on Invalidation
* **Location:** `extensions/pi-do-always/index.ts` (`showSelector`)
* **Current Behavior:**
  ```ts
  return {
      render(width: number) { ... },
      invalidate() {},
  ```
  The selector schedules a 2-second preview timer (`previewTimer`). While user actions clear this timer, if the component is dismissed or unmounted externally by Pi (such as on terminal resize or modal takeover), `invalidate()` does nothing, allowing the timer to fire `tui.requestRender()` after unmount.
* **Proposed Improvement:**
  Clear the timer inside `invalidate()`:
  ```ts
  invalidate() {
      clearPreviewTimer();
  },
  ```

---

## 3. Low Priority: Ergonomics, Typing & Code Polish

### 3.1 Narrow Viewport Cursor Visibility in ORDER Column
* **Location:** `extensions/pi-do-always/index.ts` (`buildTable`, `handleInput`)
* **Current Behavior:**
  When terminal width is `< 58` (`tier === "narrow"`), the ORDER column is hidden and the chain sequence is shown below the list.
  However, pressing `→` (right arrow) still transitions `cursor.col` to `"order"`. Because neither the task gutter cursor mark nor the ORDER column is rendered in narrow tier, the visual cursor disappears entirely.
* **Proposed Improvement:**
  - In narrow tier, keep `→` from switching columns (or keep the gutter cursor visible with an indicator like `[►]` to signify order-toggle mode).
  - Alternatively, support pressing `Space` or `+` to toggle chain membership from any column.

---

### 3.2 Extended Navigation Keys (`Home`, `End`, `PageUp`, `PageDown`)
* **Location:** `extensions/pi-do-always/index.ts` (`handleInput`)
* **Current Behavior:**
  Only `up` and `down` arrow keys are handled for row navigation. When lists exceed `maxVisible = 12`, jumping to the top or bottom requires multiple keystrokes.
* **Proposed Improvement:**
  Add support for standard terminal navigation keys:
  ```ts
  if (matchesKey(data, "home")) {
      cursor = { kind: "cell", row: 0, col: cursor.kind === "cell" ? cursor.col : "task" };
      lastCellRow = 0;
      resetPreview();
      tui.requestRender();
      return;
  }
  if (matchesKey(data, "end")) {
      cursor = { kind: "run" };
      lastCellRow = itemRows.length - 1;
      resetPreview();
      tui.requestRender();
      return;
  }
  ```

---

### 3.3 Exporting `Guard` Interface and Type Guards
* **Location:** `extensions/pi-do-always/tasks.ts`
* **Current Behavior:**
  `export interface DoAlwaysTask` includes `guards?: Guard[]`, but `interface Guard` and `GUARD_TYPES` are unexported. External modules or test files cannot reference `Guard` directly.
* **Proposed Improvement:**
  Export the types:
  ```ts
  export type GuardType = (typeof GUARD_TYPES)[number];

  export interface Guard {
      type: GuardType;
      value?: string;
  }
  ```

---

### 3.4 Source Indentation & Formatting Cleanups
* **Location:** `extensions/pi-do-always/index.ts`
  - Line ~1031: `const postContext = await cache.get(ctx.cwd);` has an extra level of indentation.
  - Line ~1056: `const reportDisplay = chainReport?.display;` has 0 indentation inside `runChainSteps`.
  - In `DEFAULT_TASKS`:
    - "Review changes" prompt ends with `"Do a summary of your findings"` without a trailing period.
    - "Propose features" prompt has slight phrasing awkwardness (`"if this will breaks API, compatibility issue."`).

---

## Summary Matrix

| Issue | Category | Severity | File |
|---|---|---|---|
| Unborn / empty git repo breaks `buildContext` | Git / Runtime | High | `index.ts` |
| Stale context cache in chain steps | State / Runtime | High | `index.ts` |
| Fill-first step 1 duration includes idle time | Metrics / Timing | High | `index.ts` |
| Inline report displays approximate identical times | Report / UI | High | `index.ts` |
| Unhandled `readFileSync` failure in `loadConfig` | Robustness | Medium | `index.ts` |
| Git porcelain quoted paths and renames | Git / Parsing | Medium | `tasks.ts` |
| Unbounded staged/unstaged file lists | Prompt / Context | Medium | `tasks.ts` |
| Selector timer cleanup on `invalidate()` | TUI / Lifecycle | Medium | `index.ts` |
| Narrow viewport cursor disappearance | TUI / UX | Low | `index.ts` |
| Missing Home / End navigation keys | TUI / Ergonomics | Low | `index.ts` |
| Unexported `Guard` interface | Types | Low | `tasks.ts` |
| Indentation anomalies | Polish | Low | `index.ts` |
