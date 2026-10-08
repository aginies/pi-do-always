/**
 * do-always — Pi extension
 *
 * Registers /do-always: shows a numbered list of common tasks
 * ("review code and double-check changes", "update the README", ...).
 * Pick one by number (press 1-9), or navigate with arrows + Enter.
 * The selected task's prompt is filled into the input editor — review,
 * tweak, then press Enter to run it.
 *
 * Config (JSON array of tasks, or {"tasks": [...], "shortcut": "f4" | null};
 * project file overrides global by name):
 *   ~/.pi/agent/do-always.json   (global)
 *   <cwd>/.pi/do-always.json     (project)
 *
 *   [
 *     {
 *       "name": "review",
 *       "description": "Review code and double-check changes",
 *       "prompt": "Review the recent changes..."
 *     }
 *   ]
 *
 * The object form also accepts "shortcut": a key id (e.g. "f4",
 * "ctrl+shift+p") or null to disable the keyboard shortcut. Default: F4.
 *
 * Usage:
 *   /do-always         → numbered selector (or press the configured shortcut, default F4)
 *   /do-always 2       → fill prompt for task #2
 *   /do-always review  → fill prompt for task named "review"
 *   /do-always list    → print the task list
 *   /do-always list-details → show the full prompt text each task injects
 *
 * If no config file exists, built-in default tasks are used.
 */

import { execFile } from "node:child_process";
import { appendFileSync, existsSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import type { AgentEndEvent, ExtensionAPI, ExtensionContext, MessageEndEvent, Theme } from "@earendil-works/pi-coding-agent";
import { CONFIG_DIR_NAME, getAgentDir } from "@earendil-works/pi-coding-agent";
import {
	type KeyId,
	type TuiMouseEvent,
	type TuiMouseEventResult,
	Container,
	Text,
	getKeybindings,
	matchesKey,
	truncateToWidth,
	wrapTextWithAnsi,
} from "@earendil-works/pi-tui";
import {
	CHAIN_MAX,
	COMMIT_BROWSER_MAX,
	COMMIT_SELECT_MAX,
	DEFAULT_SHORTCUT,
	DEFAULT_TASKS,
	PLAN_OUTPUT_INSTRUCTION,
	assistantText,
	buildTableRows,
	chainAdd,
	chainClear,
	chainRemove,
	chainRunLabel,
	chainSummary,
	chainUndo,
	evaluateGuards,
	evaluateWhen,
	formatChainSequence,
	formatList,
	formatPlanExecutionPrompt,
	formatSelectedCommits,
	groupCommitsByDate,
	groupTasksByCategory,
	isPlanTask,
	isTaskVisible,
	isValidKeyId,
	mergeTasks,
	parseConfig,
	parseConfigRegexpValueForKey,
	parseCommitSubject,
	parseGitLogOutput,
	parsePlanProposal,
	parseStatusPorcelain,
	parseStatusStagedUnstaged,
	orderTasksByCategory,
	planBlockDiagnostics,
	planItemKey,
	planSelectAll,
	planSelectionClear,
	planSelectedItems,
	planTierState,
	planToggleItem,
	planToggleTier,
	reportAbandonedFooter,
	reportFooter,
	reportHeader,
	reportStepSection,
	reportWorthKeeping,
	renderPrompt,
	resolveReportPath,
	resolveShortcut,
	resolveTask,
	shouldAutoRun,
	stepSummary,
	stripPlanBlocks,
	toPromptContext,
	validateChain,
	type ChainStepOutcome,
	type CommitInfo,
	type DateGroup,
	type DoAlwaysTask,
	type PlanProposal,
	type PlanSelection,
	type PlanSelectionEntry,
	type SelectedCommit,
	type TaskContext,
	type TableRow,
} from "./tasks";

/**
 * What the selector resolved to: a single task (the classic pick), a chain to
 * run, or a cancel.
 */
type SelectorResult =
	| { kind: "single"; task: DoAlwaysTask }
	| { kind: "chain"; names: string[] }
	| { kind: "cancel" };

/**
 * Selector cursor: a cell in the task table (TASK or ORDER column) or the
 * pinned Run row.
 */
type Cursor = { kind: "cell"; row: number; col: "task" | "order" } | { kind: "run" };

/**
 * Safely read a config file's contents, returning null if missing or unreadable.
 * Read errors are reported through `onError`.
 */
function readConfigFile(filePath: string, onError: (message: string) => void): string | null {
	if (!existsSync(filePath)) return null;
	try {
		return readFileSync(filePath, "utf-8");
	} catch (err) {
		onError(`do-always: could not read ${filePath}: ${err}`);
		return null;
	}
}

/**
 * Load tasks and the selector shortcut from config files.
 * Project-local tasks override global tasks with the same name (or are
 * appended, per the `merge` field); new ones are appended. Falls back to
 * DEFAULT_TASKS when nothing is defined.
 *
 * Validation problems (malformed JSON, invalid tasks/shortcut/merge/when/
 * guards) are reported through `onError` — callers must wire it up, since
 * the default is a silent no-op.
 */
function loadConfig(
	cwd: string,
	onError: (message: string) => void = () => {},
): {
	tasks: DoAlwaysTask[];
	shortcut: string | null;
	/** Whether chain runs write a Markdown report file (default true). */
	report: boolean;
	/** Whether plan questionnaires are offered (default true). */
	questionnaire: boolean;
	/** Whether the raw plan block is hidden from the transcript (default true). */
	hidePlan: boolean;
} {
	const globalPath = join(getAgentDir(), "do-always.json");
	const projectPath = join(cwd, CONFIG_DIR_NAME, "do-always.json");

	const globalRaw = readConfigFile(globalPath, onError);
	const projectRaw = readConfigFile(projectPath, onError);

	const global = globalRaw !== null
		? parseConfig(globalRaw, globalPath, onError)
		: { tasks: [], shortcut: undefined, merge: undefined, report: undefined, questionnaire: undefined, hidePlan: undefined };
	const project = projectRaw !== null
		? parseConfig(projectRaw, projectPath, onError)
		: { tasks: [], shortcut: undefined, merge: undefined, report: undefined, questionnaire: undefined, hidePlan: undefined };

	// The project file's merge mode wins; otherwise the global value; otherwise
	// override (the historical behavior), so existing configs are unaffected.
	const mode = project.merge ?? global.merge ?? "override";

	return {
		// Order the merged list by category so the selector numbers, digit-pick,
		// `/do-always <n>`, and `list` all share one consistent order.
		tasks: orderTasksByCategory(mergeTasks(global.tasks, project.tasks, DEFAULT_TASKS, mode)),
		shortcut: resolveShortcut(global.shortcut, project.shortcut),
		// The project file's value wins; otherwise the global value; otherwise
		// reports are on.
		report: project.report ?? global.report ?? true,
		// Same precedence: project, then global, then on.
		questionnaire: project.questionnaire ?? global.questionnaire ?? true,
		// Same precedence: project, then global, then on (the block is hidden).
		hidePlan: project.hidePlan ?? global.hidePlan ?? true,
	};
}

/**
 * Run a git command in `cwd` and return its trimmed stdout.
 * Returns undefined on any failure (not a git repo, git not installed,
 * empty repo, …) so callers can fall back to a neutral value.
 * No shell is involved (argument array), so file names cannot inject commands.
 */
function git(cwd: string, args: string[]): Promise<string | undefined> {
	return new Promise((resolve) => {
		// No stdio option: execFile's string-encoding overload doesn't accept
		// it, and stdin/stderr need no special handling here (no input is
		// written; stderr is simply ignored by the callback).
		execFile(
			"git",
			args,
			{ cwd, encoding: "utf-8" },
			(error, stdout) => {
				if (error) {
					resolve(undefined);
					return;
				}
				const trimmed = stdout.trim();
				resolve(trimmed === "" ? undefined : trimmed);
			},
		);
	});
}

/**
 * Count changed files (staged, unstaged, untracked) with a single git spawn.
 * Lighter than a full `buildContext` when only the count is needed (chain
 * step summaries). Returns 0 when git is unavailable — the same neutral
 * result `buildContext` yields via its empty file list.
 */
async function changedFileCount(cwd: string): Promise<number> {
	const porcelain = await git(cwd, ["status", "--porcelain"]);
	return porcelain ? parseStatusPorcelain(porcelain).length : 0;
}

/**
 * Build the structured context for the current directory. Git facts fall back
 * to neutral values when unavailable (non-git dir, no git, empty repo) so
 * default prompts read cleanly in any directory.
 *
 * Collects the git facts the prompts interpolate:
 *  1. rev-parse --is-inside-work-tree → isGitRepo
 *  2. branch --show-current → branch (fallback: rev-parse --abbrev-ref HEAD)
 *  3. log -1 --format="%H %s" → commit hash + subject
 *  4. config --get-regexp "^(user.name|remote.origin.url)$" → user + repo
 *  5. status --porcelain → files + stagedFiles + unstagedFiles
 *  6. diff --shortstat → diffStat
 *
 * Outside a work tree only call 1 runs; inside one, calls 2–6 run in
 * parallel, so wall time is about one spawn.
 */
async function buildContext(cwd: string): Promise<TaskContext> {
	// 1. Authoritative check: are we inside a work tree?
	//    rev-parse --is-inside-work-tree outputs "true" when inside a work tree,
	//    and fails (exit != 0) when outside.
	const inside = await git(cwd, ["rev-parse", "--is-inside-work-tree"]);
	const isGitRepo = inside === "true";

	// Outside a work tree the remaining facts don't exist; skip the spawns
	// and return the neutral fallbacks directly.
	if (!isGitRepo) {
		return {
			cwd,
			date: new Date().toLocaleDateString("en-CA"), // local YYYY-MM-DD
			branch: "unknown",
			lastCommit: "unknown",
			files: [],
			user: "unknown",
			diffStat: "none",
			repo: cwd.split(/[\\/]/).filter(Boolean).pop() ?? "unknown",
			stagedFiles: [],
			unstagedFiles: [],
			selectedCommits: "none",
			isGitRepo: false,
		};
	}

	// 2–6. In a work tree: query branch and the remaining facts in parallel.
	const [branchOut, lastCommitLine, configLine, porcelain, diffStat] = await Promise.all([
		// branch --show-current works on both normal and unborn (empty repo) branches;
		// returns empty on detached HEAD.
		git(cwd, ["branch", "--show-current"]),
		// "%H %s" prints "<hash> <subject>"; the subject may contain spaces.
		git(cwd, ["log", "-1", "--format=%H %s"]),
		// --get-regexp prints "key value" lines; one call covers both keys.
		git(cwd, ["config", "--get-regexp", "^(user\\.name|remote\\.origin\\.url)$"]),
		git(cwd, ["status", "--porcelain"]),
		git(cwd, ["diff", "--shortstat"]),
	]);

	const branch = branchOut || (await git(cwd, ["rev-parse", "--abbrev-ref", "HEAD"])) || "unknown";
	const lastCommit = parseCommitSubject(lastCommitLine);
	const user = parseConfigRegexpValueForKey(configLine, "user.name");
	const remoteUrl = parseConfigRegexpValueForKey(configLine, "remote.origin.url");
	const repo = remoteUrl
		? (remoteUrl.replace(/\.git$/, "").split("/").pop() ?? "unknown")
		: cwd.split(/[\\/]/).filter(Boolean).pop() ?? "unknown";

	// status --porcelain gives staged + unstaged in one call.
	// Porcelain v1 lines are "XY <path>" (path starts at index 3); a space
	// in the X column means unstaged, anything else is staged/untracked.
	const { staged: stagedFiles, unstaged: unstagedFiles } = parseStatusStagedUnstaged(porcelain ?? "");

	return {
		cwd,
		date: new Date().toLocaleDateString("en-CA"), // local YYYY-MM-DD
		branch,
		lastCommit,
		files: parseStatusPorcelain(porcelain ?? ""),
		user: user ?? "unknown",
		diffStat: diffStat ?? "none",
		repo,
		stagedFiles,
		unstagedFiles,
		selectedCommits: "none",
		isGitRepo,
	};
}

/**
 * Fetch a page of commits from git with lightweight stats via a single log call.
 * Fetches pageSize + 1 commits to determine if more commits are available.
 */
async function fetchCommitsPage(
	cwd: string,
	page = 0,
	pageSize = COMMIT_BROWSER_MAX,
): Promise<{ commits: CommitInfo[]; groups: DateGroup[]; hasMore: boolean }> {
	const countToFetch = pageSize + 1;
	const skip = page * pageSize;
	const format = "COMMIT%x09%H%x09%h%x09%s%x09%ad%x09%an";
	const logOutput = await git(cwd, [
		"log",
		"-n",
		`${countToFetch}`,
		`--skip=${skip}`,
		`--format=${format}`,
		"--shortstat",
		"--date=short",
	]);
	if (!logOutput) {
		return { commits: [], groups: [], hasMore: false };
	}

	const allParsed = parseGitLogOutput(logOutput);
	const hasMore = allParsed.length > pageSize;
	const commits = hasMore ? allParsed.slice(0, pageSize) : allParsed;
	const groups = groupCommitsByDate(commits);
	return { commits, groups, hasMore };
}

/**
 * Date-grouped commit browser: browse recent commits in pages of 20, select some,
 * then review them. Reuses the task-selector interaction model (↑↓, Space toggle,
 * type-to-filter, Ctrl+U clear, Esc cancel, ←/→ or PgUp/PgDn for paging).
 *
 * Returns the selected commits (ordered by user selection), or null on cancel.
 */
function browseCommits(
	ctx: ExtensionContext,
	initialData?: { commits: CommitInfo[]; groups: DateGroup[]; hasMore: boolean },
): Promise<SelectedCommit[] | null> {
	return new Promise<SelectedCommit[] | null>((resolve) => {
		const pageCache = new Map<number, { commits: CommitInfo[]; groups: DateGroup[]; hasMore: boolean }>();
		let page = 0;
		if (initialData) {
			pageCache.set(0, initialData);
		}

		type CommitCursor = { kind: "commit"; index: number } | { kind: "run" };
		const maxVisible = 14; // commits visible in the scroll window
		const selectedMap = new Map<string, SelectedCommit>(); // hash -> SelectedCommit
		let cursor: CommitCursor = { kind: "commit", index: 0 };
		let lastCommitIndex = 0;
		let filter = "";
		let settled = false;
		let isLoading = false;

		ctx.ui.custom<SelectedCommit[] | null>((tui, theme, _kb, done) => {
			const kb = getKeybindings();

			function finish(selectedCommits: SelectedCommit[]) {
				if (settled) return;
				settled = true;
				done(selectedCommits);
				resolve(selectedCommits);
			}

			function finishCancel() {
				if (settled) return;
				settled = true;
				done(null);
				resolve(null);
			}

			async function loadPage(newPage: number) {
				if (isLoading || newPage < 0) return;
				page = newPage;
				if (!pageCache.has(page)) {
					isLoading = true;
					tui.requestRender();
					try {
						const fetched = await fetchCommitsPage(ctx.cwd, page);
						pageCache.set(page, fetched);
					} finally {
						isLoading = false;
					}
				}
				cursor = { kind: "commit", index: 0 };
				lastCommitIndex = 0;
				tui.requestRender();
			}

			function getCurrentPageData() {
				return pageCache.get(page) ?? { commits: [], groups: [], hasMore: false };
			}

			function getVisibleCommits(): CommitInfo[] {
				const { commits } = getCurrentPageData();
				if (!filter) return commits;
				const f = filter.toLowerCase();
				return commits.filter(
					(c) => c.subject.toLowerCase().includes(f) || c.shortHash.toLowerCase().includes(f),
				);
			}

			function render(width: number): string[] {
				const currentData = getCurrentPageData();
				const visibleCommits = getVisibleCommits();
				const lines: string[] = [];

				// Clamp cursor index if visible list changed
				if (cursor.kind === "commit") {
					if (visibleCommits.length === 0) {
						cursor = { kind: "run" };
					} else if (cursor.index >= visibleCommits.length) {
						cursor = { kind: "commit", index: visibleCommits.length - 1 };
						lastCommitIndex = cursor.index;
					}
				}

				// Header
				const startNum = page * COMMIT_BROWSER_MAX + 1;
				const endNum = page * COMMIT_BROWSER_MAX + (visibleCommits.length || 0);
				const pageLabel = currentData.hasMore
					? `Page ${page + 1} (${startNum}–${endNum}+)`
					: `Page ${page + 1} (${startNum}–${endNum})`;

				lines.push(
					theme.fg(
						"muted",
						truncateToWidth(
							`   #  DATE       HASH     FILES  ORDER  SUBJECT  [${pageLabel}]`,
							width - 2,
							"",
						),
					),
				);

				if (isLoading) {
					lines.push(theme.fg("accent", "  Loading commits from git…"));
				} else if (visibleCommits.length === 0) {
					lines.push(
						filter
							? theme.fg("warning", `  No commits matching "${filter}" on this page`)
							: theme.fg("muted", "  No commits found"),
					);
				} else {
					const anchor = cursor.kind === "commit" ? cursor.index : lastCommitIndex;
					const winStart = visibleCommits.length > maxVisible
						? Math.max(0, Math.min(anchor + 1 - maxVisible, visibleCommits.length - maxVisible))
						: 0;
					const winEnd = Math.min(winStart + maxVisible, visibleCommits.length);

					for (let i = winStart; i < winEnd; i++) {
						const c = visibleCommits[i];
						// Show date divider if it's the first commit in window or date changed
						if (i === winStart || c.date !== visibleCommits[i - 1].date) {
							lines.push(theme.fg("dim", `  ── ${c.date} ──`));
						}

						const isCursor = cursor.kind === "commit" && cursor.index === i;
						const isSelected = selectedMap.has(c.hash);
						const order = isSelected ? [...selectedMap.keys()].indexOf(c.hash) + 1 : 0;
						const cursorMark = isCursor ? theme.fg("accent", "►") : " ";
						const globalIdx = page * COMMIT_BROWSER_MAX + i + 1;
						const num = `${cursorMark} ${String(globalIdx).padStart(2)}`;
						const marker = isSelected ? `${theme.fg("accent", "◉")} [${order}]` : "  ·  ";
						const hash = theme.fg("dim", c.shortHash.slice(0, 7));
						const statStr = c.filesChanged > 0 ? `${c.filesChanged}f` : "";
						const statCell = statStr.padStart(3);
						const dateShort = c.date.slice(5); // MM-DD
						const subject = truncateToWidth(c.subject, Math.max(10, width - 36), "…");

						const rowText = `${num}  ${dateShort}  ${hash}  ${statCell}  ${marker}  ${subject}`;
						if (isCursor) {
							lines.push(theme.bg("selectedBg", theme.bold(rowText)));
						} else {
							lines.push(rowText);
						}
					}

					if (visibleCommits.length > maxVisible) {
						lines.push(
							theme.fg(
								"dim",
								truncateToWidth(
									`  (${cursor.kind === "commit" ? cursor.index + 1 : lastCommitIndex + 1}/${visibleCommits.length} on page ${page + 1})`,
									width - 2,
									"",
								),
							),
						);
					}
				}

				// Run row
				lines.push("");
				lines.push(theme.fg("dim", "  " + "─".repeat(Math.max(1, width - 4))));
				const runLabel = selectedMap.size === 0
					? "do on the commits (no commits selected)"
					: `do on the commits (${selectedMap.size} commit${selectedMap.size !== 1 ? "s" : ""})`;
				if (cursor.kind === "run") {
					lines.push(theme.bg("selectedBg", theme.bold(`${theme.fg("accent", "►")} ${runLabel}`)));
				} else if (selectedMap.size === 0) {
					lines.push(theme.fg("dim", `  ${runLabel}`));
				} else {
					lines.push(theme.fg("accent", `  ${runLabel}`));
				}

				// Footer
				const pageNavHints: string[] = [];
				if (page > 0) pageNavHints.push("← prev page");
				if (currentData.hasMore) pageNavHints.push("→ next page");
				const pageHintStr = pageNavHints.length > 0 ? `  •  ${pageNavHints.join("  •  ")}` : "";

				let footer = `  space/⏎ select  •  ↑/↓ move${pageHintStr}  •  esc`;
				if (selectedMap.size > 0) {
					footer += "  •  ctrl+u clear";
				}
				if (filter) {
					footer += `  •  filter: "${filter}"`;
				}
				lines.push(theme.fg("dim", truncateToWidth(footer, width - 2, "")));

				return lines;
			}

			async function handleInput(data: string) {
				if (settled) return;
				const currentData = getCurrentPageData();
				const visibleCommits = getVisibleCommits();

				// Space: toggle selection on current commit
				if (matchesKey(data, "space")) {
					if (cursor.kind === "commit" && visibleCommits[cursor.index]) {
						const c = visibleCommits[cursor.index];
						if (selectedMap.has(c.hash)) {
							selectedMap.delete(c.hash);
							let i = 1;
							for (const sc of selectedMap.values()) {
								sc.selectionOrder = i++;
							}
						} else if (selectedMap.size < COMMIT_SELECT_MAX) {
							selectedMap.set(c.hash, { ...c, selectionOrder: selectedMap.size + 1 });
						} else {
							ctx.ui.notify(`do-always: chain is full (${COMMIT_SELECT_MAX}) — remove a commit first`, "error");
						}
						tui.requestRender();
					}
					return;
				}

				// Confirm (Enter): run the chain if on run row, or toggle selection if on a commit
				if (kb.matches(data, "tui.select.confirm") || matchesKey(data, "enter")) {
					if (cursor.kind === "run") {
						if (selectedMap.size === 0) {
							ctx.ui.notify("do-always: no commits selected", "info");
						} else {
							finish([...selectedMap.values()]);
						}
						return;
					}
					if (cursor.kind === "commit" && visibleCommits[cursor.index]) {
						const c = visibleCommits[cursor.index];
						if (selectedMap.has(c.hash)) {
							selectedMap.delete(c.hash);
							let i = 1;
							for (const sc of selectedMap.values()) {
								sc.selectionOrder = i++;
							}
						} else if (selectedMap.size < COMMIT_SELECT_MAX) {
							selectedMap.set(c.hash, { ...c, selectionOrder: selectedMap.size + 1 });
						} else {
							ctx.ui.notify(`do-always: chain is full (${COMMIT_SELECT_MAX}) — remove a commit first`, "error");
						}
						tui.requestRender();
					}
					return;
				}

				// Cancel (Esc / Ctrl+C)
				if (kb.matches(data, "tui.select.cancel") || matchesKey(data, "escape")) {
					finishCancel();
					return;
				}

				// Ctrl+U: clear selections
				if (matchesKey(data, "ctrl+u")) {
					if (selectedMap.size > 0) {
						selectedMap.clear();
						tui.requestRender();
					}
					return;
				}

				// Backspace: delete character from filter, or undo last selection
				if (kb.matches(data, "tui.editor.deleteCharBackward") || matchesKey(data, "backspace")) {
					if (filter.length > 0) {
						filter = filter.slice(0, -1);
						cursor = { kind: "commit", index: 0 };
						lastCommitIndex = 0;
					} else if (selectedMap.size > 0) {
						const lastHash = [...selectedMap.keys()].pop()!;
						selectedMap.delete(lastHash);
					}
					tui.requestRender();
					return;
				}

				// Page navigation: Next page (Right arrow, or PageDown when at the end)
				if (matchesKey(data, "right")) {
					if (currentData.hasMore) {
						await loadPage(page + 1);
					}
					return;
				}
				if (kb.matches(data, "tui.select.pageDown") || matchesKey(data, "pageDown")) {
					if (cursor.kind === "commit") {
						const next = cursor.index + maxVisible;
						if (next < visibleCommits.length) {
							cursor = { kind: "commit", index: next };
							lastCommitIndex = next;
							tui.requestRender();
						} else if (currentData.hasMore) {
							await loadPage(page + 1);
						} else {
							cursor = { kind: "run" };
							tui.requestRender();
						}
					} else if (currentData.hasMore) {
						await loadPage(page + 1);
					}
					return;
				}

				// Page navigation: Previous page (Left arrow, or PageUp when at the top)
				if (matchesKey(data, "left")) {
					if (page > 0) {
						await loadPage(page - 1);
					}
					return;
				}
				if (kb.matches(data, "tui.select.pageUp") || matchesKey(data, "pageUp")) {
					if (cursor.kind === "commit") {
						const prev = cursor.index - maxVisible;
						if (prev >= 0) {
							cursor = { kind: "commit", index: prev };
							lastCommitIndex = prev;
							tui.requestRender();
						} else if (page > 0) {
							await loadPage(page - 1);
						} else {
							cursor = { kind: "commit", index: 0 };
							lastCommitIndex = 0;
							tui.requestRender();
						}
					} else if (visibleCommits.length > 0) {
						cursor = { kind: "commit", index: Math.max(0, visibleCommits.length - maxVisible) };
						lastCommitIndex = cursor.index;
						tui.requestRender();
					}
					return;
				}

				// Up arrow
				if (kb.matches(data, "tui.select.up") || matchesKey(data, "up")) {
					if (cursor.kind === "run") {
						if (visibleCommits.length > 0) {
							cursor = { kind: "commit", index: visibleCommits.length - 1 };
							lastCommitIndex = visibleCommits.length - 1;
						}
					} else if (cursor.index > 0) {
						cursor = { kind: "commit", index: cursor.index - 1 };
						lastCommitIndex = cursor.index;
					} else {
						cursor = { kind: "run" };
					}
					tui.requestRender();
					return;
				}

				// Down arrow
				if (kb.matches(data, "tui.select.down") || matchesKey(data, "down")) {
					if (cursor.kind === "run") {
						if (visibleCommits.length > 0) {
							cursor = { kind: "commit", index: 0 };
							lastCommitIndex = 0;
						}
					} else if (cursor.index < visibleCommits.length - 1) {
						cursor = { kind: "commit", index: cursor.index + 1 };
						lastCommitIndex = cursor.index;
					} else {
						cursor = { kind: "run" };
					}
					tui.requestRender();
					return;
				}

				// Home / End
				if (matchesKey(data, "home")) {
					if (visibleCommits.length > 0) {
						cursor = { kind: "commit", index: 0 };
						lastCommitIndex = 0;
						tui.requestRender();
					}
					return;
				}
				if (matchesKey(data, "end")) {
					cursor = { kind: "run" };
					tui.requestRender();
					return;
				}

				// Filter typing (printable chars, excluding Space which toggles)
				if (isPrintable(data) && data !== " ") {
					filter += data;
					cursor = { kind: "commit", index: 0 };
					lastCommitIndex = 0;
					tui.requestRender();
					return;
				}
			}

			return {
				render,
				handleInput,
				invalidate: () => {},
			};
		});
	});
}

/** True for a single printable ASCII character (used for filter typing). */
function isPrintable(data: string): boolean {
	return data.length === 1 && data >= " " && data <= "~";
}

/**
 * Task picker shown after a commit selection: proposes the Plan tasks (hidden
 * ones included — e.g. "Review commits" exists to be picked here) to run on
 * the selected commits. Type to filter, ↑/↓ move, Enter runs, Esc cancels.
 * Returns the chosen task, or null on cancel.
 */
function pickPlanTaskForCommits(
	ctx: ExtensionContext,
	candidates: DoAlwaysTask[],
	commitCount: number,
): Promise<DoAlwaysTask | null> {
	return new Promise<DoAlwaysTask | null>((resolve) => {
		ctx.ui.custom<DoAlwaysTask | null>((tui, theme, _kb, done) => {
			const kb = getKeybindings();
			let settled = false;
			let filter = "";
			let cursor = 0;

			const visible = () => {
				if (!filter) return candidates;
				const f = filter.toLowerCase();
				return candidates.filter(
					(t) =>
						t.name.toLowerCase().includes(f) ||
						(t.description ?? "").toLowerCase().includes(f),
				);
			};

			function finish(task: DoAlwaysTask | null) {
				if (settled) return;
				settled = true;
				done(task);
				resolve(task);
			}

			function render(width: number): string[] {
				const items = visible();
				if (items.length === 0) cursor = 0;
				else if (cursor >= items.length) cursor = items.length - 1;
				const lines: string[] = [];
				lines.push(
					theme.fg(
						"accent",
						theme.bold(
							truncateToWidth(
								`  do-always — run on ${commitCount} selected commit${commitCount !== 1 ? "s" : ""}`,
								width - 2,
								"",
							),
						),
					),
				);
				lines.push(theme.fg("muted", "   #  TASK"));
				if (items.length === 0) {
					lines.push(theme.fg("warning", `  No Plan tasks matching "${filter}"`));
				} else {
					for (let i = 0; i < items.length; i++) {
						const t = items[i];
						const auto = shouldAutoRun(t);
						const name = truncateToWidth(t.name, Math.max(10, width - 8 - (auto ? 3 : 0)), "…", true);
						const rowText = `  ${String(i + 1).padStart(2)}  ${auto ? "⚡ " : ""}${name}`;
						lines.push(i === cursor ? theme.bg("selectedBg", theme.bold(rowText)) : rowText);
					}
				}
				lines.push(
					theme.fg(
						"dim",
						truncateToWidth(
							`  ↑/↓ move  •  ⏎ run  •  esc${filter ? `  •  filter: "${filter}"` : ""}`,
							width - 2,
							"",
						),
					),
				);
				return lines;
			}

			function handleInput(data: string) {
				if (settled) return;
				const items = visible();
				if (kb.matches(data, "tui.select.cancel") || matchesKey(data, "escape")) {
					finish(null);
					return;
				}
				if (kb.matches(data, "tui.select.confirm") || matchesKey(data, "enter")) {
					finish(items[cursor] ?? null);
					return;
				}
				if (kb.matches(data, "tui.select.up") || matchesKey(data, "up")) {
					if (items.length > 0) cursor = cursor === 0 ? items.length - 1 : cursor - 1;
					tui.requestRender();
					return;
				}
				if (kb.matches(data, "tui.select.down") || matchesKey(data, "down")) {
					if (items.length > 0) cursor = cursor === items.length - 1 ? 0 : cursor + 1;
					tui.requestRender();
					return;
				}
				if (kb.matches(data, "tui.editor.deleteCharBackward") || matchesKey(data, "backspace")) {
					filter = filter.slice(0, -1);
					cursor = 0;
					tui.requestRender();
					return;
				}
				if (isPrintable(data)) {
					filter += data;
					cursor = 0;
					tui.requestRender();
				}
			}

			return { render, handleInput, invalidate: () => {} };
		});
	});
}

/** Delay before the selector reveals the selected task's prompt preview. */
const PREVIEW_DELAY_MS = 2000;
/** Max lines of the prompt shown in the selector preview. */
const PREVIEW_MAX_LINES = 3;

/** Outcome of one chain step's run (see sendAndWait). */
/**
 * Status of one chain step for the below-prompt status widget: pending
 * (not reached yet), running (its turn is in flight), waiting (fill-first:
 * step 1 is in the editor, waiting for the user's Enter), completed, or one
 * of the stop outcomes (failed-to-start/aborted/error/skipped-by-guards).
 */
type ChainStepStatus =
	| "pending"
	| "running"
	| "waiting"
	| "completed"
	| "failed-to-start"
	| "aborted"
	| "error"
	| "skipped";

interface ChainStepView {
	name: string;
	status: ChainStepStatus;
}

export default function doAlwaysExtension(pi: ExtensionAPI) {
	let tasks: DoAlwaysTask[] = [];
	let loadedCwd = ""; // cwd the cached `tasks` were loaded for
	// The visible (when-filtered) list for the last context we built, so
	// argument completions number tasks the same way the selector and
	// `/do-always <n>` do. When stale (or absent), completions fall back to
	// the full list rather than guessing.
	let visibleCache: { cwd: string; visible: DoAlwaysTask[] } | null = null;

	// Chain control: `pi.sendUserMessage` is fire-and-forget (returns void),
	// so the chain runner sequences steps on session events:
	//   agent_start   — the run actually began. A send that fails before the
	//                   run starts (no API key, compaction collision) never
	//                   emits agent events and its error is swallowed by the
	//                   runtime; the grace timer in sendAndWait turns that
	//                   into "failed-to-start".
	//   agent_end     — carries the run's messages; the last assistant
	//                   message's stopReason gives completed/aborted/error.
	//   agent_settled — the session is fully idle (the busy flag is cleared
	//                   before this fires), so the next step can be sent
	//                   safely; auto-retry, compaction, and queued
	//                   continuations have all had their chance.
	let chainWaiter: {
		started: boolean;
		outcome: "completed" | "aborted" | "error" | null;
		timer: NodeJS.Timeout | null;
		resolve: (outcome: ChainStepOutcome) => void;
		/** Which chain step (0-based) this waiter belongs to — for the report. */
		stepIndex: number;
		startTime?: number;
	} | null = null;

	function settleChainWaiter(outcome: ChainStepOutcome) {
		if (!chainWaiter) return;
		const waiter = chainWaiter;
		chainWaiter = null;
		if (waiter.timer) clearTimeout(waiter.timer);
		if (waiter.startTime !== undefined) {
			chainDurations[waiter.stepIndex] = performance.now() - waiter.startTime;
		}
		waiter.resolve(outcome);
	}

	// Below-prompt status widget while a chain is running: the chain's tasks
	// with per-step status and a (n/N) progress marker. Shown in TUI mode
	// only; cleared when the chain completes, kept (as a trace) when it stops
	// early, and reset on session start.
	let chainStatus: { steps: ChainStepView[]; note?: string } | null = null;
	const CHAIN_WIDGET_KEY = "do-always-chain";
	// The most recent command context, so event handlers (which carry no
	// context of their own) can still refresh the widget.
	let lastCtx: ExtensionContext | null = null;
	// True while a chain's runner is in flight (from start to its final
	// outcome). A second chain started while one is running would interleave
	// their event waiters (the old chain's sendAndWait would resolve on the
	// new chain's step), so starting one is refused until the first ends.
	let chainActive = false;
	// Per-step durations (ms) for the chain-end summary. Indexed by step
	// position; 0 means the step was not timed (e.g. blocked before running).
	let chainDurations: number[] = [];
	// For single auto-run tasks: the task name whose summary we post after
	// agent_end. Only set when a Plan task (auto-run) is sent via
	// pi.sendUserMessage (which does NOT arm a chainWaiter). The grace timer
	// mirrors the chain's failed-to-start handling: a send that fails before
	// the run starts emits no agent events at all, so without it the stale
	// flag would post a spurious summary for the next unrelated turn.
	let pendingSummaryTask: string | null = null;
	let pendingSummaryTimer: NodeJS.Timeout | null = null;
	// The completed auto-run task's reply, captured at agent_end and offered
	// at agent_settled (the session is fully idle then, so the confirm
	// follow-up cannot race queued continuations). Discarded on agent_start
	// — a new run started, so the proposal is stale — and on session start.
	let pendingProposal: { taskName: string; text: string } | null = null;
	// The last offered plan proposal (parseable, questionnaire enabled), kept
	// so `/do-always replan` can re-open the questionnaire after a
	// withdrawal. Cleared on confirm (executed) and on session start.
	let lastProposal: { taskName: string; text: string } | null = null;
	// The raw (unstripped) reply text of the pending auto-run task, captured
	// at message_end before its plan block is stripped from the transcript
	// (by the time agent_end fires, the message there is already stripped).
	// Cleared on agent_start (a new run makes it stale), agent_end (consumed
	// or discarded), and session start.
	let pendingPlanRaw: string | null = null;

	/** Clear the auto-run summary flag and its grace timer (session start). */
	function resetPendingSummary(): void {
		pendingSummaryTask = null;
		// A completed auto-run's captured reply is only offered at the
		// settle that follows its own agent_end — a new run invalidates it.
		pendingProposal = null;
		lastProposal = null;
		pendingPlanRaw = null;
		if (pendingSummaryTimer) {
			clearTimeout(pendingSummaryTimer);
			pendingSummaryTimer = null;
		}
	}
	// Whether chain runs write a Markdown report file (config `report`,
	// default true). Refreshed whenever the config is (re)loaded.
	let reportEnabled = true;
	// Whether completed auto-run tasks whose reply carries a "plan" block
	// offer the selection questionnaire (config `questionnaire`, default
	// true). Refreshed whenever the config is (re)loaded.
	let questionnaireEnabled = true;
	// Whether the raw "plan" block is stripped from the transcript after a
	// completed auto-run task (config `hidePlan`, default true). Refreshed
	// whenever the config is (re)loaded.
	let hidePlanEnabled = true;

	/** The result of the plan questionnaire: the confirmed selection, or a withdrawal. */
	type PlanQuestionnaireResult =
		| { kind: "confirm"; items: PlanSelectionEntry[] }
		| { kind: "withdraw" };

	/**
	 * Render a task's prompt for injection or preview. Plan-category tasks get
	 * PLAN_OUTPUT_INSTRUCTION appended (once) so the reply carries the
	 * machine-readable "plan" block the questionnaire parses — but only when
	 * the questionnaire is actually offered for this task, otherwise the agent
	 * would emit a block nobody reads. A prompt that already mentions the plan
	 * fence keeps its own contract; chain-step prompts are rendered with the
	 * plain renderPrompt and never get it.
	 */
	function renderTaskPrompt(task: DoAlwaysTask, ctx: Record<string, string>): string {
		const base = renderPrompt(task.prompt, ctx);
		const enabled = task.questionnaire ?? questionnaireEnabled;
		if (isPlanTask(task) && enabled && !base.includes("```plan")) {
			return `${base}\n\n${PLAN_OUTPUT_INSTRUCTION}`;
		}
		return base;
	}

	/**
	 * Offer a completed auto-run task's reply. When it carries a parseable
	 * "plan" block and the questionnaire is enabled, the TUI shows the tier/
	 * item questionnaire: confirming sends the selection as an execution
	 * follow-up, Esc withdraws (nothing happens). Everything else — disabled,
	 * non-TUI, or no plan block — falls back to the plain summary
	 * notification.
	 */
	async function offerPlanProposal(
		captured: { taskName: string; text: string },
		ctx: ExtensionContext | null,
	): Promise<void> {
		const proposal = parsePlanProposal(captured.text);
		if (!ctx) return;
		const task = tasks.find((t) => t.name === captured.taskName);
		const enabled = task?.questionnaire ?? questionnaireEnabled;
		// The prompt asked for a plan block only for Plan tasks with the
		// questionnaire enabled (renderTaskPrompt's gate) — only then is a
		// missing or invalid block a contract violation worth explaining; for
		// a non-Plan auto-run task its absence is the expected outcome.
		const blockExpected = task !== undefined && isPlanTask(task) && enabled;
		if (!proposal || !enabled) {
			const base = `do-always: ${stepSummary("completed", captured.taskName, 0, 0)}`;
			if (!blockExpected) {
				// Questionnaire disabled, or a non-Plan auto-run task: the
				// prompt never asked for a plan block, so its absence is not a
				// contract violation — plain summary.
				ctx.ui.notify(base, "info");
				return;
			}
			// The prompt asked for a plan block but none was usable — say why,
			// so the fallback to a plain summary is not a mystery.
			const diag = planBlockDiagnostics(captured.text);
			if (diag.kind === "none") {
				ctx.ui.notify(`${base} — reply had no plan block, so no questionnaire was offered`, "warning");
			} else if (diag.kind === "malformed") {
				ctx.ui.notify(`${base} — plan block was not valid JSON (${diag.detail}); no questionnaire offered`, "warning");
			} else {
				// "empty": the agent proposed no action items — a legitimate
				// outcome, not a contract violation.
				ctx.ui.notify(`${base} — no action items proposed`, "info");
			}
			return;
		}
		// Remember the last offered proposal so /do-always replan can re-open
		// it after a withdrawal.
		lastProposal = captured;
		if (ctx.mode !== "tui") {
			// Non-TUI: list the proposed items so the user can reply with a
			// selection; nothing is sent automatically.
			const all = planSelectedItems(proposal, planSelectAll(proposal, planSelectionClear()));
			const list = all.map(({ tier, item }, i) => `  ${i + 1}. [${tier.id}] ${item.title}`).join("\n");
			ctx.ui.notify(
				`do-always: "${captured.taskName}" proposed ${all.length} action item(s):\n${list}\nReply with the item numbers to execute (or do nothing to withdraw).`,
				"info",
			);
			return;
		}
		const result = await showPlanQuestionnaire(ctx, proposal, captured.taskName);
		if (result.kind === "confirm") {
			lastProposal = null; // executed — nothing left to re-offer
			const prompt = formatPlanExecutionPrompt(result.items, captured.taskName);
			pi.sendUserMessage(prompt, { deliverAs: "followUp" });
			ctx.ui.notify(
				`do-always: executing ${result.items.length} selected item(s) from the "${captured.taskName}" plan`,
				"info",
			);
		} else {
			ctx.ui.notify(`do-always: plan withdrawn — no action taken (re-open with /do-always replan)`, "info");
		}
	}

	/**
	 * Plan questionnaire: shown after a completed auto-run task whose reply
	 * carries a parseable "plan" block. The summary line up top, then the tiers
	 * with their action items. Selecting a tier row toggles the whole tier (all
	 * its items); selecting an item row toggles just that item. The pinned
	 * Confirm row sends the selection as an execution follow-up; Esc withdraws
	 * (nothing happens).
	 */
	function showPlanQuestionnaire(
		ctx: ExtensionContext,
		proposal: PlanProposal,
		taskName: string,
	): Promise<PlanQuestionnaireResult> {
		return new Promise<PlanQuestionnaireResult>((resolve) => {
			ctx.ui.custom<PlanQuestionnaireResult>((tui, theme, _kb, done) => {
				const kb = getKeybindings();
				let settled = false;
				let selection: PlanSelection = planSelectionClear();

				// Flat cursor rows: a tier header row, its item rows, and the
				// pinned Confirm row last.
				type Row =
					| { kind: "tier"; index: number }
					| { kind: "item"; tier: number; index: number }
					| { kind: "confirm" };
				const rows: Row[] = [];
				proposal.tiers.forEach((tier, ti) => {
					rows.push({ kind: "tier", index: ti });
					tier.items.forEach((_, ii) => rows.push({ kind: "item", tier: ti, index: ii }));
				});
				rows.push({ kind: "confirm" });
				// The scrollable part: everything but the pinned Confirm row.
				// (Cast — slice() does not narrow the row union; the last row
				// is always the confirm row pushed above.)
				type ListRow = Exclude<Row, { kind: "confirm" }>;
				const listRows = rows.slice(0, -1) as ListRow[];
				let cursor = 0;
				const MAX_VISIBLE = 12; // tier/item rows visible in the scroll window
				// Per-item notes (item key → note), added with `e` on an item
				// row and carried into the execution prompt on confirm.
				const notes = new Map<string, string>();
				let noteKey: string | null = null; // the item being annotated
				let noteDraft = "";

				function finish(result: PlanQuestionnaireResult) {
					if (settled) return;
					settled = true;
					done(result);
					resolve(result);
				}

				function tierCount(ti: number): string {
					const tier = proposal.tiers[ti];
					let n = 0;
					tier.items.forEach((_, ii) => {
						if (selection.has(planItemKey(ti, ii))) n++;
					});
					return `${n}/${tier.items.length}`;
				}

				// Line map for mouse hit-testing (rebuilt on every render).
				let rowLine = new Map<number, Row>();

				function render(width: number): string[] {
					rowLine = new Map();
					const lines: string[] = [];
					lines.push(
						theme.fg("accent", theme.bold(truncateToWidth(`  Plan proposal — ${taskName}`, width - 2, ""))),
					);
					if (proposal.summary) {
						lines.push(theme.fg("muted", truncateToWidth(`  ${proposal.summary}`, width - 2, "…")));
					}
					lines.push("");
					// Scroll window over the tier/item rows (the Confirm row is
					// pinned below it). The window follows the cursor, clamped at
					// both edges — the same pattern as the task selector.
					const anchor = cursor < listRows.length ? cursor : listRows.length - 1;
					const winStart =
						listRows.length > MAX_VISIBLE
							? Math.max(0, Math.min(anchor + 1 - MAX_VISIBLE, listRows.length - MAX_VISIBLE))
							: 0;
					const winEnd = Math.min(winStart + MAX_VISIBLE, listRows.length);
					for (let i = winStart; i < winEnd; i++) {
						const row = listRows[i];
						if (row.kind === "tier") {
							const ti = row.index;
							const tier = proposal.tiers[ti];
							const state = planTierState(proposal, ti, selection);
							const glyph = state === "all" ? "✓" : state === "partial" ? "◐" : "·";
							const color = state === "all" ? "success" : state === "partial" ? "warning" : "dim";
							const headerText = `  [${glyph}] ${tier.id} — ${tier.label} (${tierCount(ti)})`;
							if (cursor === i) {
								lines.push(theme.bg("selectedBg", theme.bold(headerText)));
							} else {
								lines.push(`  ${theme.fg(color, `[${glyph}]`)} ${tier.id} — ${tier.label} (${tierCount(ti)})`);
							}
							rowLine.set(lines.length - 1, row);
						} else {
							const ti = row.tier;
							const ii = row.index;
							const key = planItemKey(ti, ii);
							const item = proposal.tiers[ti].items[ii];
							const mark = selection.has(key) ? theme.fg("success", "✓") : theme.fg("dim", "·");
							const note = notes.get(key);
							const title = truncateToWidth(
								note ? `${item.title}  ✎ ${note}` : item.title,
								Math.max(10, width - 8),
								"…",
							);
							const rowText = `  ${mark}  ${title}`;
							if (cursor === i) {
								lines.push(theme.bg("selectedBg", theme.bold(rowText)));
							} else {
								lines.push(rowText);
							}
							rowLine.set(lines.length - 1, row);
						}
					}
					// Scroll position marker (only when the list overflows the window).
					if (listRows.length > MAX_VISIBLE) {
						lines.push(theme.fg("dim", `  (${anchor + 1}/${listRows.length})`));
					}
				// Pinned Confirm row (always visible, outside the scroll window).
				lines.push("");
				lines.push(theme.fg("dim", `  ${"─".repeat(Math.max(1, width - 4))}`));
				const totalItems = proposal.tiers.reduce((n, t) => n + t.items.length, 0);
				const confirmLabel = `Confirm (${selection.size}/${totalItems})`;
				if (cursor === rows.length - 1) {
					lines.push(theme.bg("selectedBg", theme.bold(`${theme.fg("accent", "►")} ${confirmLabel}`)));
				} else if (selection.size > 0) {
					lines.push(theme.fg("accent", `  ${confirmLabel}`));
				} else {
					lines.push(theme.fg("dim", `  ${confirmLabel}`));
				}
				rowLine.set(lines.length - 1, { kind: "confirm" });
				if (noteKey !== null) {
					// Note editor: replaces the key hint while active.
					lines.push(theme.fg("accent", truncateToWidth(`  note> ${noteDraft}`, width - 2, "")));
					lines.push(theme.fg("dim", "  enter save note  •  esc cancel"));
				} else {
					lines.push(
						theme.fg(
							"dim",
							truncateToWidth(
								`  space/⏎ toggle  •  a all  •  ctrl+u clear  •  e note  •  ⏎ confirm  •  esc withdraw`,
								width - 2,
								"",
							),
						),
					);
				}
				return lines;
			}

				function toggleAt(row: Row) {
					if (row.kind === "tier") {
						selection = planToggleTier(proposal, row.index, selection).selection;
					} else if (row.kind === "item") {
						selection = planToggleItem(selection, planItemKey(row.tier, row.index));
					}
				}

				function confirmIfPossible(): boolean {
					const items = planSelectedItems(proposal, selection, notes);
					if (items.length === 0) {
						ctx.ui.notify("do-always: nothing selected — pick a tier or item first (or esc to withdraw)", "info");
						return false;
					}
					finish({ kind: "confirm", items });
					return true;
				}

				function handleInput(data: string) {
					if (settled) return;
					// Note mode: capture the note for the item under the cursor.
					// Enter saves (an empty note clears it), Esc cancels (the
					// previous note, if any, is kept).
					if (noteKey !== null) {
						if (matchesKey(data, "enter") || kb.matches(data, "tui.select.confirm")) {
							const trimmed = noteDraft.trim();
							if (trimmed) notes.set(noteKey, trimmed);
							else notes.delete(noteKey);
							noteKey = null;
							noteDraft = "";
							tui.requestRender();
							return;
						}
						if (kb.matches(data, "tui.select.cancel") || matchesKey(data, "escape")) {
							noteKey = null;
							noteDraft = "";
							tui.requestRender();
							return;
						}
						if (kb.matches(data, "tui.editor.deleteCharBackward")) {
							noteDraft = noteDraft.slice(0, -1);
							tui.requestRender();
							return;
						}
						if (isPrintable(data)) {
							if (noteDraft.length < 200) noteDraft += data;
							tui.requestRender();
							return;
						}
						return; // swallow other keys while editing
					}
					const row = rows[cursor];
					// Withdraw (Esc / Ctrl+C).
					if (kb.matches(data, "tui.select.cancel") || matchesKey(data, "escape")) {
						finish({ kind: "withdraw" });
						return;
					}
					// Space or Enter: toggle at the cursor (tier or item), or
					// confirm on the Confirm row.
					if (matchesKey(data, "space") || kb.matches(data, "tui.select.confirm") || matchesKey(data, "enter")) {
						if (row.kind === "confirm") {
							confirmIfPossible();
						} else {
							toggleAt(row);
							tui.requestRender();
						}
						return;
					}
					// a / Ctrl+A: select all.
					if (data === "a" || matchesKey(data, "ctrl+a")) {
						selection = planSelectAll(proposal, selection);
						tui.requestRender();
						return;
					}
					// e: edit the note for the item under the cursor.
					if (data === "e") {
						if (row.kind === "item") {
							const key = planItemKey(row.tier, row.index);
							noteKey = key;
							noteDraft = notes.get(key) ?? "";
							tui.requestRender();
						} else {
							ctx.ui.notify("do-always: notes attach to item rows — put the cursor on an item, then press e", "info");
						}
						return;
					}
					// Ctrl+U: clear the selection.
					if (matchesKey(data, "ctrl+u")) {
						selection = planSelectionClear();
						tui.requestRender();
						return;
					}
					// Navigation (wraps at the edges).
					if (kb.matches(data, "tui.select.up") || matchesKey(data, "up")) {
						cursor = cursor === 0 ? rows.length - 1 : cursor - 1;
						tui.requestRender();
						return;
					}
					if (kb.matches(data, "tui.select.down") || matchesKey(data, "down")) {
						cursor = cursor === rows.length - 1 ? 0 : cursor + 1;
						tui.requestRender();
						return;
					}
					if (matchesKey(data, "home")) {
						cursor = 0;
						tui.requestRender();
						return;
					}
					if (matchesKey(data, "end")) {
						cursor = rows.length - 1;
						tui.requestRender();
						return;
					}
				}

				function handleMouse(event: TuiMouseEvent): TuiMouseEventResult | undefined {
					// Wheel: move the cursor one row (the scroll window follows) —
					// the same behavior as the task selector.
					if (event.type === "wheel" && event.wheelDelta) {
						if (noteKey !== null) return { handled: true };
						const delta = event.wheelDelta < 0 ? -1 : 1;
						const next = Math.max(0, Math.min(rows.length - 1, cursor + delta));
						if (next === cursor) return { handled: true };
						cursor = next;
						return { handled: true, render: true };
					}
					if (event.button !== "left" || (event.type !== "press" && event.type !== "click")) return undefined;
					if (noteKey !== null) return { handled: true }; // clicks are swallowed while editing
					const row = rowLine.get(event.y);
					if (!row) return undefined;
					if (row.kind === "confirm") {
						if (event.type === "press") confirmIfPossible();
						return { handled: true };
					}
					if (event.type === "press") {
						toggleAt(row);
						return { handled: true, render: true };
					}
					return { handled: true };
				}

				return { render, handleInput, handleMouse, invalidate: () => {} };
			});
		});
	}

	// The in-flight chain's report file: its path (absolute + relative for
	// display), the precomputed header (deferred — written together with the
	// first step section, so a chain that dies before that leaves no
	// header-only file behind), whether the file exists on disk yet, when the
	// current step's run actually started (agent_start; null until then and
	// for failed-to-start steps), whether the footer has been appended, the
	// index of the last step section written (dedupes retried runs), and
	// whether any step section carried result text (the file is worth
	// keeping).
	// Max in-memory sections kept for inline display; the file on disk retains
	// all steps. Bounded to avoid holding 400KB–2MB of assistant text per chain.
	const MAX_INLINE_SECTIONS = 3;

	let chainReport: {
		path: string;
		display: string;
		/** Precomputed header; written together with the first section. */
		header: string;
		/** True once the file exists on disk (header written). */
		written: boolean;
		stepStartedAt: Date | null;
		/** True once the summary (or abandoned) footer has been appended. */
		footerWritten: boolean;
		/** Index of the last step whose section was appended (-1 = none). */
		lastStepSection: number;
		/** True once a step section with result text was appended. */
		hasContent: boolean;
		/**
		 * In-memory section data for inline display (populated in agent_end,
		 * bounded to the last MAX_INLINE_SECTIONS). `index` is the step's
		 * position in the chain (retries share it); `markdown` is the formatted section.
		 */
		sections: Array<{ index: number; markdown: string }>;
	} | null = null;

	/** Status marker glyph (all one column wide) with its color. */
	function stepMarker(status: ChainStepStatus, theme: Theme): string {
		switch (status) {
			case "completed":
				return theme.fg("success", "✓");
			case "running":
				return theme.fg("accent", theme.bold("▶"));
			case "waiting":
				return theme.fg("warning", "▶");
			case "aborted":
				return theme.fg("warning", "⊘");
			case "error":
			case "failed-to-start":
				return theme.fg("error", "✗");
			case "skipped":
				return theme.fg("muted", "–");
			default:
				return theme.fg("dim", "○");
		}
	}

	/** Replace the chain status and refresh the widget. */
	function showChainStatus(ctx: ExtensionContext, steps: ChainStepView[], note?: string): void {
		chainStatus = { steps, note };
		updateChainWidget(ctx);
	}

	/** Update one step's status (and optionally the note) and refresh. */
	function setChainStep(ctx: ExtensionContext, index: number, status: ChainStepStatus, note?: string): void {
		if (!chainStatus) return;
		const s = chainStatus.steps[index];
		if (s) s.status = status;
		if (note !== undefined) chainStatus.note = note;
		updateChainWidget(ctx);
	}

	/**
	 * Mark the chain as stopped at `index` with `status`, keeping the widget
	 * visible as a trace of where it stopped.
	 */
	function markChainStopped(ctx: ExtensionContext, index: number, status: ChainStepStatus, detail?: string): void {
		const name = chainStatus?.steps[index]?.name;
		setChainStep(
			ctx,
			index,
			status,
			`stopped at step ${index + 1}${name ? ` (${name})` : ""}${detail ? `: ${detail}` : ""}`,
		);
	}

	/**
	 * Finish the report file: append the summary footer. Called on every
	 * terminal path (complete, stopped, skipped); a no-op when no report was
	 * created (disabled or write failure). A run that produced nothing worth
	 * keeping (no completed step, no result text) leaves no file behind — see
	 * `reportWorthKeeping`. When the chain completed fully (all steps done),
	 * removes the status widget so nothing lingers below the prompt; otherwise
	 * keeps it as a trace with the report path in the note.
	 */
	/**
	 * Write the deferred report header so the file exists before the first
	 * section/footer append. Returns false when there is no report or the
	 * write failed (a warning was shown); the chain runs on without a file.
	 */
	function ensureReportFile(ctx: ExtensionContext | null): boolean {
		const report = chainReport;
		if (!report || report.written) return report !== null;
		try {
			writeFileSync(report.path, report.header);
			report.written = true;
			return true;
		} catch (err) {
			ctx?.ui.notify(`do-always: could not create the report file: ${err}`, "warning");
			return false;
		}
	}

	async function finishReport(ctx: ExtensionContext): Promise<void> {
		if (!chainReport || !chainStatus) return;
		const statuses = chainStatus.steps.map((s) => s.status);
		// Nothing worth keeping — remove the (mostly) empty file so a quick
		// same-minute retry doesn't get a -N sibling next to it.
		if (!reportWorthKeeping(statuses, chainReport.hasContent)) {
			closeAbandonedReport(statuses);
			chainReport = null;
			return;
		}
		if (ensureReportFile(ctx)) {
			try {
				appendFileSync(chainReport.path, reportFooter(statuses, new Date()));
				chainReport.footerWritten = true;
			} catch (err) {
				ctx.ui.notify(`do-always: could not update the report file: ${err}`, "warning");
			}
		}
		const prev = chainStatus.note ? `${chainStatus.note} • ` : "";
		chainStatus.note = `${prev}📄 ${chainReport.display}`;
		// Chain fully done → show the inline report, then clear the
		// trace widget. Chain stopped early → keep the trace widget.
		const allDone = statuses.every((s) => s === "completed");
		if (allDone) {
			await showInlineReport(ctx);
			clearChainWidget(ctx);
		} else {
			updateChainWidget(ctx);
		}
	}

	/**
	 * Show the full chain report in an ephemeral editor view when a chain
	 * completes (TUI only). Built from in-memory section data (no file read
	 * needed). Nothing is persisted to the session — the view closes with
	 * Esc and the report file on disk is the permanent artifact. In non-TUI
	 * modes the editor is a no-op; the final notification carries the file
	 * path.
	 */
	async function showInlineReport(ctx: ExtensionContext): Promise<void> {
		if (ctx.mode !== "tui") return;
		if (!chainReport || !chainStatus || chainReport.sections.length === 0) return;
		// Reconstruct the report from in-memory sections. Only the last
		// MAX_INLINE_SECTIONS are kept (the file on disk has all of them), so
		// flag the omission when a step has no section in the window.
		const shownSteps = new Set(chainReport.sections.map((s) => s.index));
		const omitted = chainStatus.steps.length - shownSteps.size;
		const lines: string[] = [];
		lines.push(`# do-always chain report — ${new Date().toISOString().slice(0, 10)}`);
		lines.push("");
		lines.push(`- Project: ${chainReport.display}`);
		lines.push(`- Steps: ${chainStatus.steps.map((s) => s.name).join(" → ")}`);
		lines.push("");
		if (omitted > 0) {
			lines.push(`> … ${omitted} earlier step${omitted === 1 ? "" : "s"} omitted — see ${chainReport.display}`);
			lines.push("");
		}
		for (const sec of chainReport.sections) {
			lines.push(sec.markdown);
		}
		// Footer.
		const statuses = chainStatus.steps.map((s) => s.status);
		lines.push(reportFooter(statuses, new Date()));

		// Ephemeral editor view: read the report, Esc to dismiss. Unlike
		// pi.sendMessage this persists nothing to the session.
		await ctx.ui.editor("do-always — chain report", lines.join("\n"));
	}

	/**
	 * Close an in-flight report that never reached a terminal path (e.g.,
	 * the session ended mid-chain): delete the file when the run produced
	 * nothing worth keeping (a no-op when the deferred header was never
	 * written), otherwise append an "abandoned" footer so it does not stay
	 * header-only on disk.
	 */
	function closeAbandonedReport(statuses: string[]): void {
		if (!chainReport || chainReport.footerWritten) return;
		if (!reportWorthKeeping(statuses, chainReport.hasContent)) {
			// Nothing worth keeping — remove the file if it was written.
			if (chainReport.written) {
				try {
					unlinkSync(chainReport.path);
				} catch {
					// Best effort — the file stays on disk.
				}
			}
			return;
		}
		try {
			if (chainReport.written) {
				appendFileSync(chainReport.path, reportAbandonedFooter(statuses, new Date()));
			} else {
				writeFileSync(chainReport.path, chainReport.header + reportAbandonedFooter(statuses, new Date()));
			}
		} catch {
			// Best effort — the report file stays as-is on disk.
		}
	}

	/**
	 * Remove the widget and forget the status (and any in-flight report).
	 * When the report never reached a terminal path (e.g., the session
	 * ended mid-chain), it is closed by `closeAbandonedReport`.
	 */
	function clearChainWidget(ctx: ExtensionContext): void {
		if (!chainStatus) return;
		const statuses = chainStatus.steps.map((s) => s.status);
		chainStatus = null;
		closeAbandonedReport(statuses);
		chainReport = null;
		if (ctx.mode === "tui") ctx.ui.setWidget(CHAIN_WIDGET_KEY, undefined);
	}

	/**
	 * Render the status widget from `chainStatus` (TUI only): the chain's
	 * steps with per-step markers, a (n/N) progress line, and the note,
	 * below the editor. Refreshed on every step change; removed by
	 * `clearChainWidget` when the chain completes or a new prompt starts.
	 */
	function updateChainWidget(ctx: ExtensionContext): void {
		if (ctx.mode !== "tui" || !chainStatus) return;
		const { steps, note } = chainStatus;

		// Chain status widget: stays below the editor.
		ctx.ui.setWidget(
			CHAIN_WIDGET_KEY,
			(tui, theme) => {
				const lines: string[] = [];
				// (n/N): the step the chain is currently at (N when it is done).
				let at = 0;
				steps.forEach((s, i) => {
					if (s.status !== "pending") at = i + 1;
				});
				lines.push(theme.fg("accent", theme.bold(`⛓ do-always (${at}/${steps.length})`)));
				for (const s of steps) {
					lines.push(`  ${stepMarker(s.status, theme)} ${s.name}`);
				}
				if (note) lines.push(theme.fg("muted", truncateToWidth(`  ${note}`, tui.terminal.columns - 2, "…")));
				const container = new Container();
				for (const line of lines) container.addChild(new Text(line, 1, 0));
				return container;
			},
			{ placement: "belowEditor" },
		);
	}

	pi.on("agent_start", () => {
		if (chainWaiter) {
			chainWaiter.started = true;
			chainWaiter.startTime = performance.now();
		}
		// The run actually began — cancel the auto-run task's failed-to-start
		// grace timer (its summary posts at agent_end).
		if (pendingSummaryTimer) {
			clearTimeout(pendingSummaryTimer);
			pendingSummaryTimer = null;
		}
		// A new run began before the captured plan proposal was offered (the
		// user typed a prompt right after the Plan run ended) — it is stale.
		pendingProposal = null;
		pendingPlanRaw = null;
		// The run actually began — time the step for the report.
		if (chainReport) chainReport.stepStartedAt = new Date();
		// Fill-first: step 1 left the editor and is running — update the
		// widget (and drop the "press Enter" note) as soon as the run starts.
		if (lastCtx && chainStatus?.steps[0]?.status === "waiting") {
			setChainStep(lastCtx, 0, "running", "");
		}
		// User entered a new prompt and the old chain is no longer active —
		// clear the trace widget so nothing lingers below the prompt.
		if (!chainActive && chainStatus && lastCtx) {
			clearChainWidget(lastCtx);
		}
	});
	/** The turn's last assistant message (backward scan — no copy/reverse). */
	function lastAssistantMessage(messages: AgentEndEvent["messages"]) {
		for (let i = messages.length - 1; i >= 0; i--) {
			const m = messages[i];
			if (m.role === "assistant") return m;
		}
		return null;
	}

	/** Map an assistant message's stopReason to a chain step outcome. */
	function outcomeFromStopReason(stopReason: string | undefined): "completed" | "aborted" | "error" {
		if (stopReason === "aborted") return "aborted";
		if (stopReason === "error") return "error";
		return "completed";
	}

	/**
	 * The message with every fenced plan block removed from its text parts,
	 * or null when nothing changed. Strips per part: a fence spanning two
	 * parts is left in place (the questionnaire parser works on the joined
	 * text, so its behavior is unaffected by that edge case).
	 */
	function stripPlanFromMessage(message: MessageEndEvent["message"]): MessageEndEvent["message"] | null {
		if (message.role !== "assistant") return null;
		// Assistant content is a parts array (text / thinking / toolCall);
		// only text parts can carry the plan fence.
		const content = message.content;
		if (!Array.isArray(content)) return null;
		let removed = false;
		const parts = content.map((part) => {
			if (part.type === "text" && typeof part.text === "string") {
				const { text, removed: partRemoved } = stripPlanBlocks(part.text);
				if (partRemoved) {
					removed = true;
					return { ...part, text };
				}
			}
			return part;
		});
		return removed ? { ...message, content: parts } : null;
	}

	/**
	 * Hide the plan block: while a single auto-run Plan task is in flight
	 * (its prompt carried PLAN_OUTPUT_INSTRUCTION), capture the reply's raw
	 * text for the questionnaire, then — in the TUI — replace the finalized
	 * message with the plan block(s) stripped out. The runtime applies the
	 * replacement in place, so the stripped text is what the model sees in
	 * later turns and what the session file persists. In non-TUI modes the
	 * block stays in the transcript: it is the model's only record of the
	 * proposal, and the user may reply with item numbers to execute. Scoped
	 * to the pending auto-run Plan task (renderTaskPrompt's gate), so a
	 * plan-tagged JSON block in a normal conversation or in a non-Plan
	 * auto-run's reply is never touched; `hidePlan` (per task, then global)
	 * opts out of the strip.
	 */
	pi.on("message_end", (event) => {
		if (event.message.role !== "assistant" || !pendingSummaryTask) return;
		const task = tasks.find((t) => t.name === pendingSummaryTask);
		// Only the runs whose prompt carried PLAN_OUTPUT_INSTRUCTION (Plan
		// tasks with the questionnaire enabled — renderTaskPrompt's gate)
		// may have the block captured and stripped; a plan fence in any other
		// reply is the user's content and stays in the transcript.
		if (!task || !isPlanTask(task) || !(task.questionnaire ?? questionnaireEnabled)) return;
		const text = assistantText(event.message.content);
		if (!text.includes("```plan")) return;
		// Capture the raw (unstripped) text for the questionnaire — after the
		// strip below the message text no longer carries the block.
		pendingPlanRaw = text;
		// TUI-only strip: in non-TUI modes the block stays in the transcript
		// so the model can resolve the item-number replies the notification
		// offers (and the session file keeps the proposal on record).
		if (lastCtx?.mode !== "tui") return;
		// `hidePlan` (per task, then global) opts out of the strip.
		if (!(task.hidePlan ?? hidePlanEnabled)) return;
		const stripped = stripPlanFromMessage(event.message);
		if (stripped) return { message: stripped };
	});

	pi.on("agent_end", (event) => {
		// The agent may have changed the repo — drop the TTL context cache so
		// the next action sees the new tree (a running chain keeps its own
		// per-action snapshot and is unaffected).
		contextCache = null;
		// Single auto-run task summary (no chainWaiter: pi.sendUserMessage is
		// fire-and-forget, so no armWaiter is called).
		if (!chainWaiter && pendingSummaryTask) {
			if (pendingSummaryTimer) {
				clearTimeout(pendingSummaryTimer);
				pendingSummaryTimer = null;
			}
			const lastAssistant = lastAssistantMessage(event.messages);
			if (lastAssistant) {
				const outcome = outcomeFromStopReason(lastAssistant.stopReason);
				if (outcome === "completed") {
					// Completed auto-run: capture the reply; the plan
					// questionnaire (or the plain summary when there is no
					// parseable plan block / the mode is not TUI) is offered at
					// agent_settled, when the session is fully idle. The
					// message_end handler stripped the plan block from the
					// transcript, so the message here no longer carries it — the
					// raw capture is the parse source (the message text is the
					// fallback when no capture exists).
					pendingProposal = {
						taskName: pendingSummaryTask,
						text: pendingPlanRaw ?? assistantText(lastAssistant.content),
					};
				} else {
					const summary = stepSummary(outcome, pendingSummaryTask, 0, 0);
					lastCtx?.ui.notify(`do-always: ${summary}`, "info");
				}
			}
			pendingSummaryTask = null;
			pendingPlanRaw = null;
			return;
		}
		if (!chainWaiter) return;
		const lastAssistant = lastAssistantMessage(event.messages);
		if (lastAssistant) {
			const outcome = outcomeFromStopReason(lastAssistant.stopReason);
			chainWaiter.outcome = outcome;
			// Append this step's result to the report while the transcript is
			// fresh (the step's final assistant message is its result).
			if (chainReport && chainStatus) {
				const idx = chainWaiter.stepIndex;
				// A retried/continued run emits a second agent_end for the
				// same step before agent_settled — mark the repeat so the
				// report shows both attempts without a duplicate heading.
				const isRetry = chainReport.lastStepSection === idx;
				const name = chainStatus.steps[idx]?.name ?? `step ${idx + 1}`;
				const displayName = isRetry ? `${name} (retry)` : name;
				const text = assistantText(lastAssistant.content);
				const section = reportStepSection(
					idx,
					displayName,
					outcome,
					chainReport.stepStartedAt,
					new Date(),
					text,
				);
				if (ensureReportFile(lastCtx)) {
					try {
						appendFileSync(chainReport.path, section);
						chainReport.lastStepSection = idx;
						if (text.trim() !== "") chainReport.hasContent = true;
						// Keep in-memory section data for inline display (bounded);
						// index lets it number sections like the file.
						chainReport.sections.push({ index: idx, markdown: section });
						if (chainReport.sections.length > MAX_INLINE_SECTIONS) {
							chainReport.sections.splice(0, chainReport.sections.length - MAX_INLINE_SECTIONS);
						}
					} catch (err) {
						lastCtx?.ui.notify(`do-always: could not update the report file: ${err}`, "warning");
					}
				}
				chainReport.stepStartedAt = null;
			}
		}
	});
	// The settle that follows a chain run's agent_end (or the
	// failed-to-start grace timer): settle the waiter there, not in
	// agent_end, because agent_end can fire while a queued follow-up is
	// still pending — the settle is the point where the session is
	// truly idle. A settle with no waiter is a plain user turn (or the
	// settle of a completed auto-run, which offers its captured reply).
	pi.on("agent_settled", () => {
		if (chainWaiter) {
			settleChainWaiter(chainWaiter.started ? (chainWaiter.outcome ?? "completed") : "failed-to-start");
			return;
		}
		// A completed auto-run task may have a captured reply to offer (the
		// plan questionnaire in TUI, the summary elsewhere). Skip when a chain
		// is active — the questionnaire is only for single auto-runs.
		if (pendingProposal && !chainActive) {
			const captured = pendingProposal;
			pendingProposal = null;
			void offerPlanProposal(captured, lastCtx);
		}
	});

	/**
	 * Arm the chain waiter and resolve when the next run has fully settled
	 * (agent_settled), reporting that run's outcome. With `graceMs`, resolves
	 * "failed-to-start" if no agent_start arrives in time — a send that
	 * throws before the run begins emits no agent events and its error is
	 * swallowed by the runtime. `stepIndex` tags the waiter so the report
	 * knows which chain step the run belongs to.
	 */
	function armWaiter(graceMs?: number, stepIndex = 0): Promise<ChainStepOutcome> {
		return new Promise((resolve) => {
			const timer = graceMs
				? setTimeout(() => {
						if (chainWaiter && !chainWaiter.started) settleChainWaiter("failed-to-start");
					}, graceMs)
				: null;
			chainWaiter = { started: false, outcome: null, timer, resolve, stepIndex };
		});
	}

	/**
	 * Send a prompt and resolve when the run it starts has fully settled,
	 * reporting the run's outcome (see armWaiter).
	 */
		function sendAndWait(prompt: string, graceMs = 10_000, stepIndex = 0): Promise<ChainStepOutcome> {
				const done = armWaiter(graceMs, stepIndex);
				pi.sendUserMessage(prompt, { deliverAs: 'followUp' });
				return done;
		}

	/** Filter tasks by visibility (`hidden` flag + `when` condition) and refresh the completion cache. */
	function refreshVisible(cwd: string, context: TaskContext): DoAlwaysTask[] {
		const visible = tasks.filter((t) => isTaskVisible(t, context));
		visibleCache = { cwd, visible };
		return visible;
	}

	/**
	 * Register the selector shortcut from a resolved config value (null
	 * disables it). Called from session_start so it reads the session's cwd,
	 * not the process cwd; re-registering the same key is idempotent.
	 */
	function registerShortcut(shortcut: string | null, onError: (message: string) => void): void {
		if (shortcut === null) return;
		const shortcutKey = isValidKeyId(shortcut) ? shortcut : DEFAULT_SHORTCUT;
		if (shortcutKey !== shortcut) {
			onError(`do-always: invalid shortcut "${shortcut}" in do-always.json — using ${DEFAULT_SHORTCUT}`);
		}
		pi.registerShortcut(shortcutKey as KeyId, {
			description: "do-always: pick a common task",
			handler: async (ctx) => {
				await runDoAlways("", ctx);
			},
		});
	}

	pi.on("session_start", async (_event, ctx) => {
		lastCtx = ctx;
		// Surface config validation problems (the README promises warnings);
		// in non-TUI modes there is no UI, so fall back to the console.
		const onError = (m: string) => {
			if (ctx.mode === "tui") ctx.ui.notify(m, "warning");
			else console.warn(m);
		};
		// A failed chain's status widget is a trace of the previous session;
		// start each session clean.
		clearChainWidget(ctx);
		// Likewise a stale auto-run summary flag (e.g., a send that never
		// started) must not post a spurious summary for this session's turns.
		resetPendingSummary();
		loadedCwd = ctx.cwd;
		const config = loadConfig(ctx.cwd, onError);
		tasks = config.tasks;
		reportEnabled = config.report;
		questionnaireEnabled = config.questionnaire;
		hidePlanEnabled = config.hidePlan;
		refreshVisible(ctx.cwd, await getContext(ctx.cwd));
		registerShortcut(config.shortcut, onError);
	});

	// Extension-level git context cache, keyed by cwd with a short TTL:
	// buildContext spawns git, and the repo rarely changes between actions,
	// so the session_start precompute feeds the first /do-always and
	// repeated invocations within the window reuse the same context.
	// Invalidated on agent_end (the agent may have changed the repo); a
	// running chain keeps its own per-action snapshot (createContextCache),
	// so its steps reuse one context across the run.
	let contextCache: { cwd: string; at: number; ctx: TaskContext } | null = null;
	const CONTEXT_TTL_MS = 5_000;

	async function getContext(cwd: string): Promise<TaskContext> {
		if (contextCache && contextCache.cwd === cwd && Date.now() - contextCache.at < CONTEXT_TTL_MS) {
			return contextCache.ctx;
		}
		const ctx = await buildContext(cwd);
		contextCache = { cwd, at: Date.now(), ctx };
		return ctx;
	}

	/**
	 * Per-action context cache: the first build consults the extension-level
	 * TTL cache (getContext), and later builds within the same action reuse
	 * that snapshot — what the user saw in the preview is what gets injected.
	 * Created fresh at each action entry point (runDoAlways, runChain).
	 */
	function createContextCache(): {
		get(cwd: string): Promise<TaskContext>;
	} {
		let cached: { cwd: string; ctx: TaskContext } | null = null;
		return {
			async get(cwd: string): Promise<TaskContext> {
				if (cached && cached.cwd === cwd) return cached.ctx;
				cached = { cwd, ctx: await getContext(cwd) };
				return cached.ctx;
			},
		};
	}

	/** Put the task prompt into the editor (TUI) or send it as a user message (other modes). */
	async function fillPrompt(task: DoAlwaysTask, ctx: ExtensionContext, context: TaskContext): Promise<void> {
		// Commit browser: any task with `browser: "commits"` opens the
		// date-grouped browser first. The name check keeps configs that
		// predate the field working. After the selection: a task whose prompt
		// references {{selected_commits}} runs itself on the selection; a
		// generic entry (e.g. "Browse commits") proposes the Plan tasks to
		// run on it — hidden tasks included, since they exist to be picked
		// here (non-TUI: the first one whose guards pass).
		if (task.browser === "commits" || task.name === "Review commits") {
			let selected: SelectedCommit[] = [];
			if (ctx.mode !== "tui") {
				const initialData = await fetchCommitsPage(ctx.cwd, 0, 1);
				if (initialData.commits.length === 0) {
					ctx.ui.notify("do-always: no commits found", "info");
					return;
				}
				selected = [{ ...initialData.commits[0], selectionOrder: 1 }];
			} else {
				const initialData = await fetchCommitsPage(ctx.cwd, 0);
				if (initialData.commits.length === 0) {
					ctx.ui.notify("do-always: no commits found", "info");
					return;
				}
				const result = await browseCommits(ctx, initialData);
				if (!result) {
					ctx.ui.notify("do-always: commit browser cancelled", "info");
					return;
				}
				if (result.length === 0) {
					ctx.ui.notify("do-always: no commits selected", "info");
					return;
				}
				selected = result;
			}

			// Which task runs on the selection: the originating task when its
			// prompt consumes {{selected_commits}}; otherwise a Plan task
			// picked by the user (TUI) or the first whose guards pass (non-TUI).
			const planTasks = tasks.filter(
				(t) =>
					!t.notForCommits &&
					evaluateWhen(t, context) &&
					(t.category ?? "").trim().toLowerCase() === "plan",
			);
			if (planTasks.length === 0) {
				ctx.ui.notify("do-always: no Plan task available to run on the selected commits", "info");
				return;
			}
			let chosen: DoAlwaysTask | undefined;
			if (/\{\{\s*selected_commits\s*\}\}/.test(task.prompt)) {
				chosen = task;
			} else if (ctx.mode === "tui") {
				const picked = await pickPlanTaskForCommits(ctx, planTasks, selected.length);
				if (!picked) {
					ctx.ui.notify("do-always: no task chosen — commits not used", "info");
					return;
				}
				chosen = picked;
			} else {
				// Non-TUI: no picker — the first Plan task whose guards pass.
				chosen = planTasks.find((t) => evaluateGuards(t, context) === null);
			}
			if (!chosen) {
				ctx.ui.notify("do-always: no Plan task available to run on the selected commits (guards unmet)", "info");
				return;
			}

			// Guards apply to the commit run too: a picked (or originating)
			// task blocked for the current tree is not sent — same as the
			// non-browser path below.
			const blocked = evaluateGuards(chosen, context);
			if (blocked) {
				ctx.ui.notify(`do-always: ${blocked}`, "info");
				return;
			}

			// Inject the selection: substitute {{selected_commits}} when the
			// prompt references it, otherwise append the detail block. The run
			// is a single turn (not a chain): sendUserMessage + summary.
			const details = formatSelectedCommits(selected);
			const strings = toPromptContext(context);
			const prompt = /\{\{\s*selected_commits\s*\}\}/.test(chosen.prompt)
				? renderTaskPrompt(chosen, { ...strings, selected_commits: details })
				: `${renderTaskPrompt(chosen, strings)}\n\nSelected commits:\n${details}`;

			pendingSummaryTask = chosen.name;
			if (pendingSummaryTimer) clearTimeout(pendingSummaryTimer);
			pendingSummaryTimer = setTimeout(() => {
				pendingSummaryTimer = null;
				if (!pendingSummaryTask) return;
				const name = pendingSummaryTask;
				pendingSummaryTask = null;
				lastCtx?.ui.notify(`do-always: "${name}" failed to start (check model/API key)`, "error");
			}, 10_000);
			pi.sendUserMessage(prompt, { deliverAs: 'followUp' });
			ctx.ui.notify(
				`do-always: ${selected.length} commit${selected.length !== 1 ? "s" : ""} → ${chosen.name}`,
				"info",
			);
			return;
		}
		const blocked = evaluateGuards(task, context);
		if (blocked) {
			ctx.ui.notify(`do-always: ${blocked}`, "info");
			return;
		}
		// Render with the same context the selector/preview used, so what the
		// user saw is exactly what gets injected.
		const prompt = renderTaskPrompt(task, toPromptContext(context));
		if (shouldAutoRun(task)) {
			// Fire-and-forget: sendUserMessage returns void; the run proceeds
			// independently (see the chain control notes for why).
			// Track the task so we can post a summary after agent_end.
			pendingSummaryTask = task.name;
			// If the run never starts (no agent events at all — same failure
			// mode the chain's grace timer handles), drop the flag so a later
			// unrelated turn can't post a spurious summary for this task.
			if (pendingSummaryTimer) clearTimeout(pendingSummaryTimer);
			pendingSummaryTimer = setTimeout(() => {
				pendingSummaryTimer = null;
				if (!pendingSummaryTask) return;
				const name = pendingSummaryTask;
				pendingSummaryTask = null;
				lastCtx?.ui.notify(`do-always: "${name}" failed to start (check model/API key)`, "error");
			}, 10_000);
			pi.sendUserMessage(prompt, { deliverAs: 'followUp' });
			ctx.ui.notify(`do-always: auto-ran "${task.name}"`, "info");
			return;
		}
		if (ctx.mode === "tui") {
			ctx.ui.setEditorText(prompt);
			ctx.ui.notify(`do-always: prompt for "${task.name}" filled — press Enter to run`, "info");
		} else {
			pi.sendUserMessage(prompt, { deliverAs: 'followUp' });
		}
	}

	/**
	 * Run a chain: each step is sent as its own turn, awaited in order, so the
	 * steps run strictly one after another. Aborting (or erroring) a step
	 * stops the chain.
	 *
	 * Step 1 follows the task's autoRun semantics: ⚡ tasks (and non-TUI modes)
	 * are sent immediately; fill tasks put step 1 in the editor and wait for
	 * its run to settle before starting the remaining steps.
	 */
	async function runChain(
		names: string[],
		ctx: ExtensionContext,
		cache: ReturnType<typeof createContextCache>,
	): Promise<void> {
		if (chainActive) {
			ctx.ui.notify("do-always: a chain is already running — wait for it to finish (or abort the current step with Esc)", "info");
			return;
		}
		const steps = names
			.map((n) => tasks.find((t) => t.name === n))
			.filter((t): t is DoAlwaysTask => t !== undefined);
		if (steps.length === 0) {
			ctx.ui.notify("do-always: nothing to run", "info");
			return;
		}
		// Fail fast: report the first blocked step before sending anything.
		const blocked = validateChain(tasks, { items: names, history: [] }, await cache.get(ctx.cwd));
		if (blocked) {
			ctx.ui.notify(`do-always: chain blocked at step ${blocked.step} (${blocked.task.name}): ${blocked.message}`, "warning");
			return;
		}
		chainActive = true;
		// Per-step durations for the chain-end summary. Re-initialized each
		// chain run so stale durations from a previous run don't leak in.
		// Pre-filled with 0 so the fill-first step (index 0, timed outside
		// runChainSteps) and any unrun steps don't leave `undefined` holes
		// that would poison the reduce with NaN.
		chainDurations = Array.from({ length: steps.length }, () => 0);
		// Report file: one per run, in the project root. The header is
		// deferred until the first step section (a chain that dies before
		// that leaves no file), and each step is appended as it finishes
		// (see the report section in tasks.ts). A write failure is not
		// fatal — the chain still runs, just without a report.
		if (reportEnabled) {
			const now = new Date();
			const path = resolveReportPath(ctx.cwd, now);
			chainReport = {
				path,
				display: relative(ctx.cwd, path),
				header: reportHeader(ctx.cwd, steps.map((t) => t.name), now),
				written: false,
				stepStartedAt: null,
				footerWritten: false,
				lastStepSection: -1,
				hasContent: false,
				sections: [],
			};
		}
		const first = steps[0];
		if (shouldAutoRun(first) || ctx.mode !== "tui") {
			try {
				showChainStatus(
					ctx,
					steps.map((t, i) => ({ name: t.name, status: i === 0 ? "running" : "pending" })),
				);
				await runChainSteps(steps, ctx, 0);
			} finally {
				chainActive = false;
			}
			return;
		}
		// Fill-first: put step 1 in the editor; the remaining steps start once
		// step 1's run has settled successfully. No grace timer — the user
		// takes as long as they need to press Enter. (If the user runs an
		// unrelated prompt instead, the chain continues after it, as the
		// notification says.)
		showChainStatus(
			ctx,
			steps.map((t, i) => ({ name: t.name, status: i === 0 ? "waiting" : "pending" })),
			"step 1 is in the editor — press Enter to start",
		);
		const firstContext = await cache.get(ctx.cwd);
		ctx.ui.setEditorText(renderPrompt(first.prompt, toPromptContext(firstContext)));
		ctx.ui.notify(
			`do-always: step 1 of ${steps.length} in the editor — press Enter to run; steps 2–${steps.length} follow automatically`,
			"info",
		);
		void armWaiter(undefined, 0).then(async (outcome) => {
			try {
				if (outcome !== "completed") {
					markChainStopped(ctx, 0, outcome);
					await finishReport(ctx);
					ctx.ui.notify(`do-always: step 1 — ${outcome}; chain stopped`, "error");
					return;
				}
				setChainStep(ctx, 0, "completed");
				// Post-step summary for step 1 (fill-first). When more steps
				// follow, the fresh full build doubles as step 2's pre-context
				// (the tree can only change via agent runs, which have settled);
				// a single-task chain only needs the file count.
				let nextContext: TaskContext | undefined;
				let fileCount: number;
				if (steps.length === 1) {
					fileCount = await changedFileCount(ctx.cwd);
				} else {
					nextContext = await getContext(ctx.cwd);
					fileCount = nextContext.files.length;
				}
				const summary = stepSummary(outcome, first.name, chainDurations[0], fileCount);
				ctx.ui.notify(`do-always: step 1/${steps.length} — ${summary}`, "info");
				await runChainSteps(steps, ctx, 1, nextContext);
			} finally {
				chainActive = false;
			}
		});
	}

	/**
	 * Send chain steps `startAt..end` sequentially. Each step evaluates guards
	 * and renders prompts against fresh repository context, and each step is
	 * awaited until its run has fully settled; an aborted/errored step (or a
	 * send that failed to start) stops the chain.
	 *
	 * Context builds are shared across steps: after each completed step the
	 * fresh full build (needed for the file-count summary) is reused as the
	 * next step's pre-context — the tree can only change via agent runs, and
	 * the step has fully settled before the build runs. `initialContext` lets
	 * the fill-first path hand over its post-step-1 build. The last step's
	 * summary uses a single-spawn file count instead of a full build.
	 */
	async function runChainSteps(
		steps: DoAlwaysTask[],
		ctx: ExtensionContext,
		startAt: number,
		initialContext?: TaskContext,
	): Promise<void> {
		let context = initialContext ?? (await getContext(ctx.cwd));
		for (let i = startAt; i < steps.length; i++) {
			const step = steps[i];
			const blocked = evaluateGuards(step, context);
			if (blocked) {
				markChainStopped(ctx, i, "skipped", blocked);
				await finishReport(ctx);
				ctx.ui.notify(`do-always: chain stopped at step ${i + 1} (${step.name}): ${blocked}`, "warning");
				return;
			}
			const prompt = renderPrompt(step.prompt, toPromptContext(context));
			const label = `do-always: step ${i + 1}/${steps.length} — ${step.name}`;
			setChainStep(ctx, i, "running");
			ctx.ui.notify(`${label} — starting`, "info");
			const stepStart = performance.now();
			const outcome = await sendAndWait(prompt, 10_000, i);
			const stepDuration = chainDurations[i] || performance.now() - stepStart;
			chainDurations[i] = stepDuration;
			if (outcome === "completed") {
				setChainStep(ctx, i, "completed");
				// Post-step summary: files changed + duration. All but the last
				// step get a fresh full build that doubles as the next step's
				// pre-context; the last step only needs the count (one spawn).
				let fileCount: number;
				if (i === steps.length - 1) {
					fileCount = await changedFileCount(ctx.cwd);
				} else {
					context = await getContext(ctx.cwd);
					fileCount = context.files.length;
				}
				const summary = stepSummary(outcome, step.name, stepDuration, fileCount);
				ctx.ui.notify(`do-always: step ${i + 1}/${steps.length} — ${summary}`, "info");
				continue;
			}
			markChainStopped(ctx, i, outcome);
			await finishReport(ctx);
			const summary = stepSummary(outcome, step.name, stepDuration, 0);
			if (outcome === "failed-to-start") {
				ctx.ui.notify(`${label} — ${summary} (check model/API key); chain stopped`, "error");
			} else if (outcome === "aborted") {
				ctx.ui.notify(`${label} — ${summary}; chain stopped`, "error");
			} else {
				ctx.ui.notify(`${label} — ${summary}; chain stopped`, "error");
			}
			return;
		}
		// Complete: the report file holds the full results of every step;
		// finishReport clears the status widget so nothing lingers below
		// the prompt. Capture the display path first — finishReport clears
		// `chainReport` when the chain is fully done.
		const reportDisplay = chainReport?.display;
		// Chain-end summary.
		const completed = chainDurations.filter((d) => d > 0).length;
		const totalMs = chainDurations.reduce((a, b) => a + b, 0);
		const chainSum = chainSummary(completed, steps.length, totalMs);
		if (chainReport) {
			await finishReport(ctx);
			ctx.ui.notify(`do-always: ${chainSum} — report: ${reportDisplay}`, "info");
		} else {
			clearChainWidget(ctx);
			ctx.ui.notify(`do-always: ${chainSum}`, "info");
		}
	}

	/**
	 * Task table with an ORDER column (the chain) and a pinned Run row:
	 *
	 *   #  TASK                  DESCRIPTION              ORDER
	 *   1  ⚡ Review changes      Review the current       ►[1]
	 *   2  Build                 Build the project          ·
	 *   ─────────────────────────────────────────────────────
	 *   Run the chain (1)
	 *
	 * The TASK column is primary: Enter runs just the task under the cursor
	 * (the classic pick). The ORDER column is the optional chain: Enter
	 * toggles the task's membership, and the pinned Run row runs the whole
	 * chain. ←/→ switch columns, 1-9 still runs a task immediately (closing
	 * the selector, discarding the chain). The context is built once per command
	 * run (never inside the render loop — no process spawning per frame) and
	 * shared with `fillPrompt`.
	 */
	async function showSelector(
		ctx: ExtensionContext,
		context: TaskContext,
		cache: ReturnType<typeof createContextCache>,
	): Promise<void> {
		// Filter by the `hidden` flag and the `when` condition once per session,
		// so hidden tasks never appear, are never numbered, and can't be picked
		// (same predicate as refreshVisible, which numbers `/do-always <n>`).
		const visibleTasks = tasks.filter((t) => isTaskVisible(t, context));
		// String view for prompt rendering (derived once, used by the preview).
		const strings = toPromptContext(context);
		const result = await ctx.ui.custom<SelectorResult>((tui, theme, _kb, done) => {
			let settled = false;
			let previewVisible = false;
			let previewTimer: ReturnType<typeof setTimeout> | null = null;

			function clearPreviewTimer() {
				if (previewTimer) {
					clearTimeout(previewTimer);
					previewTimer = null;
				}
			}

			// Finish the selector with a result. Reference-based (task object /
			// chain names), so it stays correct while a text filter is active
			// (itemRows is then a subset of visibleTasks and positional indices
			// would point at the wrong task).
			function finishSingle(task: DoAlwaysTask) {
				if (settled) return;
				settled = true;
				clearPreviewTimer();
				done({ kind: "single", task });
			}
			function finishChain(names: string[]) {
				if (settled) return;
				settled = true;
				clearPreviewTimer();
				done({ kind: "chain", names });
			}
			function finishCancel() {
				if (settled) return;
				settled = true;
				clearPreviewTimer();
				done({ kind: "cancel" });
			}

			// The prompt preview appears only after the selection has been stable
			// for PREVIEW_DELAY_MS; any change hides it and restarts the delay.
			function resetPreview() {
				previewVisible = false;
				clearPreviewTimer();
				previewTimer = setTimeout(() => {
					previewTimer = null;
					if (!settled) {
						previewVisible = true;
						tui.requestRender();
					}
				}, PREVIEW_DELAY_MS);
			}

			// Group tasks under category headers, in a stable order.
			const groups = groupTasksByCategory(visibleTasks);

			const kb = getKeybindings();
			const maxVisible = 12;
			let filter = "";
			let chain = chainClear();
			let cursor: Cursor = { kind: "cell", row: 0, col: "task" };
			let lastCellRow = 0;
			let mousePressedIndex: number | null = null;

			// Arm the preview timer for the initial selection.
			resetPreview();

			const matchesFilter = (t: DoAlwaysTask) => {
				if (!filter) return true;
				const f = filter.toLowerCase();
				return (
					t.name.toLowerCase().includes(f) ||
					(t.description ?? "").toLowerCase().includes(f) ||
					(t.category ?? "").toLowerCase().includes(f)
				);
			};

			// Recompute the visible (filtered) table rows on every render so
			// filter typing and chain edits update the table live.
			function getVisible() {
				const filteredGroups = groups.map((g) => ({ name: g.name, items: g.items.filter(matchesFilter) }));
				const tableRows = buildTableRows(filteredGroups, chain);
				const bodyRows: TableRow[] = [];
				const itemRows: { task: DoAlwaysTask; globalIndex: number; order?: number }[] = [];
				// O(n) index map so indexOf → O(1) lookup.
				const taskToGlobalIndex = new Map(visibleTasks.map((t, i) => [t, i]));
				for (const r of tableRows) {
					if (r.kind === "run") continue; // pinned row, rendered separately
					bodyRows.push(r);
					if (r.kind === "task" && r.task) {
						itemRows.push({ task: r.task, globalIndex: taskToGlobalIndex.get(r.task) ?? -1, order: r.order });
					}
				}
				// Scroll window over the filtered items.
				const anchor = cursor.kind === "cell" ? cursor.row : lastCellRow;
				const winStart =
					itemRows.length > maxVisible
						? Math.max(0, Math.min(anchor + 1 - maxVisible, itemRows.length - maxVisible))
						: 0;
				// Headers whose group has at least one item in the window.
				const inWindow = new Set(itemRows.slice(winStart, winStart + maxVisible).map((r) => r.task));
				const visibleHeaderNames = new Set(
					filteredGroups.filter((g) => g.items.some((t) => inWindow.has(t))).map((g) => g.name),
				);
				return { bodyRows, itemRows, winStart, visibleHeaderNames };
			}
			// One pass's visible state, computed once per input event / render
			// and shared by clampCursor, buildTable, and the navigation logic.
			type Visible = ReturnType<typeof getVisible>;

			// Keep the cursor valid after the rows or the chain change. (The
			// ORDER cell of a non-chained row is a valid cursor position: it is
			// the "add" state.)
			function clampCursor(visible: Visible) {
				const { itemRows } = visible;
				if (itemRows.length === 0) {
					cursor = { kind: "cell", row: 0, col: "task" };
					return;
				}
				if (cursor.kind === "cell" && cursor.row >= itemRows.length) {
					cursor = { kind: "cell", row: itemRows.length - 1, col: "task" };
				}
			}

			// --- Table geometry ---------------------------------------------------
			// Three tiers by width:
			//   >= 76:   # TASK DESCRIPTION ORDER
			//   58-75:   # TASK ORDER
			//   < 58:    # TASK   (chain shown on its own line below the list)
			const ORDER_COL_W = 5;
			const TASK_COL_W = 24;
			type Tier = "full" | "compact" | "narrow";
			function tierFor(width: number): Tier {
				if (width >= 76) return "full";
				if (width >= 58) return "compact";
				return "narrow";
			}
			// Column geometry: [2] # [3]  [taskCol]  [descCol]  [ORDER_COL_W] [1]
			function tableGeometry(width: number) {
				const tier = tierFor(width);
				const taskCol = tier === "full" ? TASK_COL_W : Math.max(10, width - 2 - 3 - 2 - 2 - ORDER_COL_W - 1);
				const descCol = tier === "full" ? Math.max(8, width - 2 - 3 - 2 - TASK_COL_W - 2 - 2 - ORDER_COL_W - 1) : 0;
				// The ORDER cell is the last ORDER_COL_W characters of the line
				// (the line is width-2 chars wide), so it starts at width-2-W.
				const orderColX = tier === "narrow" ? null : width - 2 - ORDER_COL_W;
				return { tier, taskCol, descCol, orderColX };
			}

			// Cached last buildTable result (avoids double-work on mouse hit-test).
			// The table depends on cursor and preview state, so render() must
			// rebuild it on every pass; handleMouse only reuses the last render's
			// table (or builds one if no render has happened yet, e.g. the very
			// first mouse event).
			type Table = { lines: string[]; itemLine: Map<number, DoAlwaysTask>; runLine: number; orderColX: number | null };
			let lastTable: Table | null = null;

			// Build the full selector output for a width, plus the line map for
			// mouse handling (itemLine: line -> task, runLine: the Run row,
			// orderColX: where the ORDER cell starts, or null in the narrow tier).
			function buildTable(width: number, visible: Visible = getVisible()): Table {
				const { bodyRows, itemRows, winStart, visibleHeaderNames } = visible;
				const { tier, taskCol, descCol, orderColX } = tableGeometry(width);
				const lines: string[] = [];
				const itemLine = new Map<number, DoAlwaysTask>();
				let runLine = -1;
				// Cursor marker: a large triangle in the accent color. The row
				// background alone can be invisible (some themes map selectedBg
				// to the terminal's default background), so the marker carries
				// the cursor.
				const cursorMark = theme.fg("accent", "►");

				// Header.
				lines.push(
					theme.fg(
						"muted",
						truncateToWidth(
							// The 6-char prefix ("   #  ") lines the header up with
							// the body rows (2-digit number + 2 spaces).
							tier === "full"
								? `   #  ${"TASK".padEnd(taskCol)}  ${"DESCRIPTION".padEnd(descCol)}  ${"ORDER".padEnd(ORDER_COL_W)}`
								: tier === "compact"
									? `   #  ${"TASK".padEnd(taskCol)}  ${"ORDER".padEnd(ORDER_COL_W)}`
									: "   #  TASK",
							width - 2,
							"",
						),
					),
				);

				if (itemRows.length === 0) {
					lines.push(theme.fg("warning", "  No matching tasks"));
				} else {
					let itemShown = 0;
					// O(n) index map so findIndex → O(1) lookup.
					const idxMap = new Map(itemRows.map((x, i) => [x.task, i]));
					for (const row of bodyRows) {
						if (row.kind === "header") {
							if (!visibleHeaderNames.has(row.name ?? "")) continue;
							if (itemShown >= maxVisible) break;
							lines.push(
								theme.fg("accent", theme.bold(truncateToWidth(`  ${(row.name ?? "").toUpperCase()}`, width - 2, ""))),
							);
							continue;
						}
						if (!row.task) continue;
						const idx = idxMap.get(row.task);
						if (idx === undefined || idx < winStart || idx >= winStart + maxVisible) continue;
						itemShown++;
						const task = row.task;
						const auto = shouldAutoRun(task);
						const focused = cursor.kind === "cell" && cursor.row === idx;
						// Cursor markers: ► in the left gutter = TASK column, ► in the
						// ORDER cell = ORDER column. The row background is applied too,
						// but some themes map selectedBg to a color that is nearly
						// indistinguishable from the terminal background, so the
						// character marker is the reliable indicator.
						const inTaskCol =
							cursor.kind === "cell" && cursor.row === idx && cursor.col === "task";
						const inOrderCol =
							cursor.kind === "cell" && cursor.row === idx && cursor.col === "order";
						const num = inTaskCol
							? `${cursorMark} ${String(itemRows[idx].globalIndex + 1).padStart(2)}`
							: inOrderCol && tier === "narrow"
								? `${theme.fg("warning", "►")} ${String(itemRows[idx].globalIndex + 1).padStart(2)}`
								: `  ${String(itemRows[idx].globalIndex + 1).padStart(2)}`;
						// ⚡ is 2 columns wide, so "⚡ " takes 3 — reserve it so
						// auto-run rows align with the others (ORDER cell is
						// hit-tested at a fixed x).
						const name = truncateToWidth(task.name, taskCol - (auto ? 3 : 0), "…", true);
						const taskCell = (auto ? "⚡ " : "") + name;
						// Every ORDER cell is exactly ORDER_COL_W wide so the column
						// stays aligned (and mouse hit-testing stays exact).
						const orderCell =
							row.order !== undefined
								? inOrderCol
									? truncateToWidth(`${cursorMark}[${row.order}]`, ORDER_COL_W, "", true)
									: ` [${row.order}] `
								: inOrderCol
									? `${cursorMark}  · `
									: "  ·  ";
						let line: string;
						if (tier === "full") {
							const desc = truncateToWidth(task.description ?? "", descCol, "…", true);
							line = `${num}  ${taskCell}  ${desc}  ${orderCell}`;
						} else if (tier === "compact") {
							line = `${num}  ${taskCell}  ${orderCell}`;
						} else {
							line = truncateToWidth(`${num}  ${taskCell}`, width - 2, "…");
						}
						// Full-row background + bold where the theme makes it visible;
						// the ► gutter/cell marker carries the cursor either way.
						if (focused) line = theme.bg("selectedBg", theme.bold(line));
						lines.push(line);
						itemLine.set(lines.length - 1, task);
					}
					if (itemRows.length > maxVisible) {
						const anchor = cursor.kind === "cell" ? cursor.row : lastCellRow;
						lines.push(theme.fg("dim", truncateToWidth(`  (${anchor + 1}/${itemRows.length})`, width - 2, "")));
					}
					// Narrow tier: the chain gets its own line instead of a column.
					if (tier === "narrow" && chain.items.length > 0) {
						lines.push(
							theme.fg("dim", truncateToWidth(`  chain: ${formatChainSequence(visibleTasks, chain)}`, width - 2, "…")),
						);
					}
				}

				// Prompt preview: revealed after the cursor has been stable on a
				// task row for PREVIEW_DELAY_MS, showing exactly what will be
				// injected.
				if (previewVisible && cursor.kind === "cell" && cursor.col === "task") {
					const sel = itemRows[cursor.row];
					if (sel) {
						const wrapWidth = Math.max(10, width - 4);
						const wrapped = wrapTextWithAnsi(renderTaskPrompt(sel.task, strings), wrapWidth);
						const shown = wrapped.slice(0, PREVIEW_MAX_LINES);
						const truncated = wrapped.length > PREVIEW_MAX_LINES;
						lines.push("");
						lines.push(theme.fg("dim", theme.bold(`  ${sel.task.name} — prompt:`)));
						shown.forEach((ln, i) => {
							const isLast = i === shown.length - 1;
							const text = isLast && truncated ? truncateToWidth(`${ln} …`, wrapWidth, "") : ln;
							lines.push(theme.fg("muted", `  ${text}`));
						});
					}
				}

				// Pinned Run row (always visible, outside the scroll window).
				lines.push("");
				lines.push(theme.fg("dim", "  " + "─".repeat(Math.max(1, width - 4))));
				const runLabel = chainRunLabel(chain.items.length);
				runLine = lines.length;
				// No play glyph in the label: the ► cursor marker is the only
				// ">" and it appears only while the row is selected (like task rows).
				if (cursor.kind === "run") {
					lines.push(theme.bg("selectedBg", theme.bold(`${cursorMark} ${runLabel}`)));
				} else if (chain.items.length === 0) {
					lines.push(theme.fg("dim", `  ${runLabel}`));
				} else {
					lines.push(theme.fg("accent", `  ${runLabel}`));
				}

				// Context-sensitive footer.
				let footer: string;
				if (cursor.kind === "run") {
					footer =
						chain.items.length > 0
							? `  ⏎ run: ${formatChainSequence(visibleTasks, chain)}`
							: "  ⏎ run the chain (chain is empty)";
				} else if (cursor.col === "order") {
					const inChain = chain.items.includes(itemRows[cursor.row]?.task.name ?? "");
					footer = inChain ? "  ← tasks  •  ⏎ remove  •  esc" : "  ← tasks  •  ⏎ add  •  esc";
				} else {
					footer = "  1-9 run now  •  ⏎ select  •  → order  •  ⌫ undo  •  esc";
				}
				if (chain.items.length > 0 && cursor.kind !== "run") footer += "  •  ctrl+u clear";
				lines.push(theme.fg("dim", truncateToWidth(footer, width - 2, "")));

				return { lines, itemLine, runLine, orderColX };
			}

			return {
				render(width: number) {
					lastTable = buildTable(width, getVisible());
					return lastTable.lines;
				},
				invalidate() {
					clearPreviewTimer();
				},
				handleInput(data: string) {
					// Direct pick by number (1-9) — runs the task immediately (the
					// classic fast path), closing the selector and discarding the
					// chain. Only when not filtering, and within the visible set,
					// so digits pick a visible task by its number.
					if (!filter && /^[1-9]$/.test(data) && Number(data) <= visibleTasks.length) {
						finishSingle(visibleTasks[Number(data) - 1]);
						return;
					}
					// Filter typing (Backspace edits the filter; with an empty
					// filter it undoes the last chain add). The filter change
					// invalidates the visible set, so the clamp gets a fresh pass.
					if (kb.matches(data, "tui.editor.deleteCharBackward")) {
						if (filter.length > 0) {
							filter = filter.slice(0, -1);
							clampCursor(getVisible());
						} else {
							const { state, removed } = chainUndo(chain);
							if (removed) {
								chain = state;
								clampCursor(getVisible());
							}
						}
						resetPreview();
						tui.requestRender();
						return;
					}
					if (isPrintable(data)) {
						filter += data;
						clampCursor(getVisible());
						resetPreview();
						tui.requestRender();
						return;
					}
					// One pass for the rest of the event: navigation, confirm,
					// and clear below all share this result (chain edits don't
					// change itemRows, so it stays valid).
					const visible = getVisible();
					const { itemRows } = visible;
					if (itemRows.length === 0) {
						// Nothing to navigate; only Esc is useful here.
						if (kb.matches(data, "tui.select.cancel")) finishCancel();
						return;
					}
					// Column switching.
					if (matchesKey(data, "left")) {
						if (cursor.kind === "run") {
							cursor = { kind: "cell", row: itemRows.length - 1, col: "task" };
						} else if (cursor.col === "order") {
							cursor = { kind: "cell", row: cursor.row, col: "task" };
						}
						lastCellRow = cursor.kind === "cell" ? cursor.row : lastCellRow;
						resetPreview();
						tui.requestRender();
						return;
					}
					if (matchesKey(data, "right")) {
						if (cursor.kind === "cell" && cursor.col === "task") {
							// Same row: the ORDER cell shows whether this task is
							// in the chain, and Enter toggles it.
							cursor = { kind: "cell", row: cursor.row, col: "order" };
						}
						// (→ in the ORDER column and on the Run row is a no-op:
						// the cursor is already at the right/bottom edge.)
						lastCellRow = cursor.kind === "cell" ? cursor.row : lastCellRow;
						resetPreview();
						tui.requestRender();
						return;
					}
					// Row navigation: the cursor moves in both columns (wrap at
					// the edges); the Run row is reached from the last task row.
					if (kb.matches(data, "tui.select.up")) {
						if (cursor.kind === "run") {
							cursor = { kind: "cell", row: itemRows.length - 1, col: "task" };
						} else {
							cursor = {
								kind: "cell",
								row: cursor.row === 0 ? itemRows.length - 1 : cursor.row - 1,
								col: cursor.col,
							};
						}
						lastCellRow = cursor.kind === "cell" ? cursor.row : lastCellRow;
						resetPreview();
						tui.requestRender();
						return;
					}
					if (kb.matches(data, "tui.select.down")) {
						if (cursor.kind === "run") {
							cursor = { kind: "cell", row: 0, col: "task" };
						} else if (cursor.row === itemRows.length - 1) {
							// The pinned Run row sits below the last task row.
							cursor = { kind: "run" };
							lastCellRow = itemRows.length - 1;
						} else {
							cursor = {
								kind: "cell",
								row: cursor.row + 1,
								col: cursor.col,
							};
						}
						lastCellRow = cursor.kind === "cell" ? cursor.row : lastCellRow;
						resetPreview();
						tui.requestRender();
						return;
					}
					// Extended navigation: home, end, pageup, pagedown.
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
					if (matchesKey(data, "pageUp")) {
						if (cursor.kind === "run") {
							cursor = { kind: "cell", row: Math.max(0, itemRows.length - maxVisible), col: "task" };
						} else {
							cursor = {
								kind: "cell",
								row: Math.max(0, cursor.row - maxVisible),
								col: cursor.col,
							};
						}
						lastCellRow = cursor.row;
						resetPreview();
						tui.requestRender();
						return;
					}
					if (matchesKey(data, "pageDown")) {
						if (cursor.kind === "cell") {
							const next = cursor.row + maxVisible;
							if (next >= itemRows.length) {
								cursor = { kind: "run" };
								lastCellRow = itemRows.length - 1;
							} else {
								cursor = { kind: "cell", row: next, col: cursor.col };
								lastCellRow = next;
							}
						}
						resetPreview();
						tui.requestRender();
						return;
					}
					// Confirm: context-dependent.
					if (kb.matches(data, "tui.select.confirm")) {
						if (cursor.kind === "run") {
							if (chain.items.length === 0) {
								ctx.ui.notify("do-always: chain is empty — add a task first", "info");
							} else {
								finishChain([...chain.items]);
							}
							return;
						}
						const row = itemRows[cursor.row];
						if (!row) return;
						if (cursor.col === "task") {
							// The classic pick: run just this task (fill or
							// auto-run per its autoRun), discarding the chain.
							finishSingle(row.task);
							return;
						}
						// ORDER column: toggle this task's chain membership.
						// Browser tasks can't be chained: the chain runner sends
						// prompts directly, so the browser (and
						// {{selected_commits}}) never run — run them on their own.
						if (row.task.browser) {
							ctx.ui.notify(`do-always: "${row.task.name}" opens a browser — it can't be chained, run it on its own`, "info");
							return;
						}
						if (chain.items.includes(row.task.name)) {
							chain = chainRemove(chain, row.task.name);
						} else {
							const { state, result } = chainAdd(chain, row.task.name);
							chain = state;
							if (result === "full") {
								ctx.ui.notify(`do-always: chain is full (${CHAIN_MAX}) — remove a task first`, "error");
							}
						}
						lastCellRow = cursor.kind === "cell" ? cursor.row : lastCellRow;
						resetPreview();
						tui.requestRender();
						return;
					}
					// Clear the chain.
					if (matchesKey(data, "ctrl+u")) {
						if (chain.items.length > 0) {
							chain = chainClear();
							clampCursor(visible);
							resetPreview();
							tui.requestRender();
						}
						return;
					}
					if (kb.matches(data, "tui.select.cancel")) {
						finishCancel();
					}
				},
				handleMouse(event: TuiMouseEvent): TuiMouseEventResult | undefined {
					if (event.type === "wheel" && event.wheelDelta) {
						const { itemRows } = getVisible();
						if (itemRows.length === 0) return undefined;
						const delta = event.wheelDelta < 0 ? -1 : 1;
						const prev = cursor.kind === "cell" ? cursor.row : lastCellRow;
						const next = Math.max(0, Math.min(itemRows.length - 1, prev + delta));
						if (next === prev) return { handled: true };
						cursor = { kind: "cell", row: next, col: "task" };
						lastCellRow = next;
						resetPreview();
						return { handled: true, render: true };
					}
					if (event.button !== "left" || (event.type !== "press" && event.type !== "click")) return undefined;
				// Reuse the last render's table for hit-testing (avoids rebuilding
				// the table twice per mouse event). The table is always fresh
				// because handleInput calls requestRender before the next mouse
				// event can arrive; build one if no render has happened yet.
				// One getVisible() per event, shared by the (possibly fresh)
				// table and the itemRows lookup below.
				const visible = getVisible();
				const { itemLine, runLine, orderColX } = lastTable ?? buildTable(event.width, visible);
					// Pinned Run row: press runs the chain.
					if (runLine >= 0 && event.y === runLine) {
						if (event.type === "press" && chain.items.length > 0) {
							finishChain([...chain.items]);
						}
						return { handled: true };
					}
					const task = itemLine.get(event.y);
					if (!task) return undefined;
					const { itemRows } = visible;
					const idx = itemRows.findIndex((r) => r.task === task);
					if (idx < 0) return undefined;
						// ORDER cell: press toggles chain membership.
						if (orderColX !== null && event.x >= orderColX) {
							if (event.type === "press") {
								if (task.browser) {
									// Same rule as the keyboard toggle: browser tasks
									// can't be chained (see ORDER column).
									ctx.ui.notify(`do-always: "${task.name}" opens a browser — it can't be chained, run it on its own`, "info");
									return { handled: true };
								}
								chain = chain.items.includes(task.name) ? chainRemove(chain, task.name) : chainAdd(chain, task.name).state;
								clampCursor(visible);
								resetPreview();
								return { handled: true, render: true };
							}
							return { handled: true }; // swallow the click after the press action
						}
					// Task area: press selects, click runs (the classic fast path).
					if (event.type === "press") {
						mousePressedIndex = idx;
						if (cursor.kind !== "cell" || cursor.row !== idx) {
							cursor = { kind: "cell", row: idx, col: "task" };
							lastCellRow = idx;
							resetPreview();
						}
						return { handled: true, focus: true, render: true };
					}
					const clicked = mousePressedIndex ?? idx;
					mousePressedIndex = null;
					const chosen = itemRows[clicked];
					if (chosen) finishSingle(chosen.task);
					return { handled: true };
				},
			};
		});

		if (!result || result.kind === "cancel") return;
		if (result.kind === "single") {
			await fillPrompt(result.task, ctx, context);
		} else {
			await runChain(result.names, ctx, cache);
		}
	}

	pi.registerCommand("do-always", {
		description: "Pick a common task (review, readme, ...) by number — fills the prompt",
		getArgumentCompletions: (prefix) => {
			const p = prefix.trim().toLowerCase();
			// Number tasks by position in the VISIBLE (when-filtered) list — the
			// same list the selector and `/do-always <n>` use. The cache is
			// refreshed on session start and every command run; when it is
			// stale, fall back to the full list rather than guessing.
			const visible = visibleCache?.cwd === loadedCwd ? visibleCache.visible : tasks;
			const matches = [
				{ value: "list", label: "list" },
				{ value: "list-details", label: "list-details" },
				{ value: "replan", label: "replan" },
				...visible.map((t, i) => ({ value: t.name, label: `${i + 1}. ${t.name}` })),
			].filter((c) => c.value.toLowerCase().includes(p));
			return matches.length > 0 ? matches : null;
		},
		handler: async (args, ctx) => {
			await runDoAlways(args, ctx);
		},
	});

	async function runDoAlways(args: string, ctx: ExtensionContext): Promise<void> {
		lastCtx = ctx;
		// Reload when the active directory changes, so switching projects
		// mid-session serves the right config instead of stale tasks.
		if (ctx.cwd !== loadedCwd) {
			loadedCwd = ctx.cwd;
			const onError = (m: string) => {
				if (ctx.mode === "tui") ctx.ui.notify(m, "warning");
				else console.warn(m);
			};
			const config = loadConfig(ctx.cwd, onError);
			tasks = config.tasks;
			reportEnabled = config.report;
			questionnaireEnabled = config.questionnaire;
			hidePlanEnabled = config.hidePlan;
		}

		// One context per command run: shared by visibility filtering, rendering,
		// and the completion cache (never inside a render loop).
		const cache = createContextCache();
		const context = await cache.get(ctx.cwd);
		const visible = refreshVisible(ctx.cwd, context);

		const arg = args.trim();

		if (!arg) {
			if (ctx.mode === "tui") {
				await showSelector(ctx, context, cache);
			} else {
				ctx.ui.notify(`do-always tasks (use /do-always <number|name>):\n${formatList(visible)}`, "info");
			}
			return;
		}

		if (arg.toLowerCase() === "list") {
			ctx.ui.notify(formatList(visible), "info");
			return;
		}

		// Re-open the questionnaire for the last offered plan proposal (e.g.
		// after an accidental esc). Re-offers the same captured reply, so the
		// confirm/withdraw behavior is exactly as before.
		if (arg.toLowerCase() === "replan") {
			if (!lastProposal) {
				ctx.ui.notify("do-always: no plan proposal to re-open — run a Plan task (⚡) first", "info");
				return;
			}
			void offerPlanProposal(lastProposal, ctx);
			return;
		}

		if (arg.toLowerCase() === "list-details") {
			// Display only — the description is metadata; selecting a task injects just its prompt.
			// Render with the current context so what is shown is what gets injected.
			const strings = toPromptContext(context);
			const details = visible
				.map((t, i) => {
					const lines = [`${i + 1}. ${t.name}`];
					if (t.description) lines.push(`   description: ${t.description}`);
					lines.push("   prompt (this is what gets injected on select):");
					for (const line of renderTaskPrompt(t, strings).split("\n")) lines.push(`   ${line}`);
					return lines.join("\n");
				})
				.join("\n\n");
			if (ctx.mode === "tui") {
				await ctx.ui.editor("do-always — task details (only the prompt is injected; esc to close)", details);
			} else {
				ctx.ui.notify(details, "info");
			}
			return;
		}

		// Numbers index the VISIBLE list (what the user sees in the selector and
		// `list`); names resolve against the full set so picking a hidden task by
		// name gets an explanatory message below instead of "unknown task".
		const task = resolveTask(/^\d+$/.test(arg) ? visible : tasks, arg);
		if (!task) {
			const available = visible.map((t, i) => `${i + 1}=${t.name}`).join(", ");
			ctx.ui.notify(`do-always: unknown task "${arg}". Available: ${available}`, "error");
			return;
		}
		// Respect the task's `when` condition: never inject a task hidden for the
		// current environment (the selector and lists already hide it).
		if (!evaluateWhen(task, context)) {
			ctx.ui.notify(`do-always: "${task.name}" is hidden by its "when" condition`, "info");
			return;
		}
		await fillPrompt(task, ctx, context);
	}
}
