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

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { CONFIG_DIR_NAME, getAgentDir } from "@earendil-works/pi-coding-agent";
import {
	type KeyId,
	type TuiMouseEvent,
	type TuiMouseEventResult,
	getKeybindings,
	truncateToWidth,
	visibleWidth,
	wrapTextWithAnsi,
} from "@earendil-works/pi-tui";
import {
	DEFAULT_SHORTCUT,
	DEFAULT_TASKS,
	evaluateGuards,
	evaluateWhen,
	formatList,
	groupTasksByCategory,
	isValidKeyId,
	mergeTasks,
	parseConfig,
	parseStatusPorcelain,
	orderTasksByCategory,
	renderPrompt,
	resolveShortcut,
	resolveTask,
	shouldAutoRun,
	splitFileLines,
	toPromptContext,
	type DoAlwaysTask,
	type TaskContext,
	type TaskGroup,
} from "./tasks";

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
} {
	const globalPath = join(getAgentDir(), "do-always.json");
	const projectPath = join(cwd, CONFIG_DIR_NAME, "do-always.json");

	const global = existsSync(globalPath)
		? parseConfig(readFileSync(globalPath, "utf-8"), globalPath, onError)
		: { tasks: [], shortcut: undefined, merge: undefined };
	const project = existsSync(projectPath)
		? parseConfig(readFileSync(projectPath, "utf-8"), projectPath, onError)
		: { tasks: [], shortcut: undefined, merge: undefined };

	// The project file's merge mode wins; otherwise the global value; otherwise
	// override (the historical behavior), so existing configs are unaffected.
	const mode = project.merge ?? global.merge ?? "override";

	return {
		// Order the merged list by category so the selector numbers, digit-pick,
		// `/do-always <n>`, and `list` all share one consistent order.
		tasks: orderTasksByCategory(mergeTasks(global.tasks, project.tasks, DEFAULT_TASKS, mode)),
		shortcut: resolveShortcut(global.shortcut, project.shortcut),
	};
}

/**
 * Run a git command in `cwd` and return its trimmed stdout.
 * Returns undefined on any failure (not a git repo, git not installed,
 * empty repo, …) so callers can fall back to a neutral value.
 * No shell is involved (argument array), so file names cannot inject commands.
 */
function git(cwd: string, args: string[]): string | undefined {
	try {
		const out = execFileSync("git", args, {
			cwd,
			encoding: "utf-8",
			stdio: ["ignore", "pipe", "ignore"],
		});
		const trimmed = out.trim();
		return trimmed === "" ? undefined : trimmed;
	} catch {
		return undefined;
	}
}

/**
 * Build the structured context for the current directory. Git facts fall back
 * to neutral values when unavailable (non-git dir, no git, empty repo) so
 * default prompts read cleanly in any directory. The string view for
 * `renderPrompt` is derived with `toPromptContext`.
 */
function buildContext(cwd: string): TaskContext {
	const branch = git(cwd, ["rev-parse", "--abbrev-ref", "HEAD"]) ?? "unknown";
	const lastCommit = git(cwd, ["log", "-1", "--format=%s"]) ?? "unknown";
	const user = git(cwd, ["config", "user.name"]) ?? "unknown";
	// Authoritative working-tree check — the branch sentinel is not (a branch
	// could literally be named "unknown", and detached HEAD reports "HEAD").
	const isGitRepo = git(cwd, ["rev-parse", "--is-inside-work-tree"]) === "true";

	// repo = bare name of the git remote (owner/repo.git -> repo), falling back
	// to the basename of cwd so monorepo work stays disambiguated everywhere.
	const remoteUrl = git(cwd, ["config", "--get", "remote.origin.url"]);
	const repo = remoteUrl
		? (remoteUrl.replace(/\.git$/, "").split("/").pop() ?? "unknown")
		: cwd.split(/[\\/]/).filter(Boolean).pop() ?? "unknown";

	return {
		cwd,
		date: new Date().toLocaleDateString("en-CA"), // local YYYY-MM-DD
		branch,
		lastCommit,
		files: parseStatusPorcelain(git(cwd, ["status", "--porcelain"]) ?? ""),
		user,
		diffStat: git(cwd, ["diff", "--shortstat"]) ?? "none",
		repo,
		stagedFiles: splitFileLines(git(cwd, ["diff", "--cached", "--name-only"])),
		unstagedFiles: splitFileLines(git(cwd, ["diff", "--name-only"])),
		isGitRepo,
	};
}

/** Find the group (among `groups`) that contains a task. */
function findGroupOf(task: DoAlwaysTask, groups: TaskGroup[]): TaskGroup | undefined {
	return groups.find((g) => g.items.includes(task));
}

/** True for a single printable ASCII character (used for filter typing). */
function isPrintable(data: string): boolean {
	return data.length === 1 && data >= " " && data <= "~";
}

/** Delay before the selector reveals the selected task's prompt preview. */
const PREVIEW_DELAY_MS = 2000;
/** Max lines of the prompt shown in the selector preview. */
const PREVIEW_MAX_LINES = 3;

export default function doAlwaysExtension(pi: ExtensionAPI) {
	let tasks: DoAlwaysTask[] = [];
	let loadedCwd = ""; // cwd the cached `tasks` were loaded for
	// The visible (when-filtered) list for the last context we built, so
	// argument completions number tasks the same way the selector and
	// `/do-always <n>` do. When stale (or absent), completions fall back to
	// the full list rather than guessing.
	let visibleCache: { cwd: string; visible: DoAlwaysTask[] } | null = null;

	/** Filter tasks by their `when` condition and refresh the completion cache. */
	function refreshVisible(cwd: string, context: TaskContext): DoAlwaysTask[] {
		const visible = tasks.filter((t) => evaluateWhen(t, context));
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

	pi.on("session_start", (_event, ctx) => {
		// Surface config validation problems (the README promises warnings);
		// in non-TUI modes there is no UI, so fall back to the console.
		const onError = (m: string) => {
			if (ctx.mode === "tui") ctx.ui.notify(m, "warning");
			else console.warn(m);
		};
		loadedCwd = ctx.cwd;
		const config = loadConfig(ctx.cwd, onError);
		tasks = config.tasks;
		refreshVisible(ctx.cwd, buildContext(ctx.cwd));
		registerShortcut(config.shortcut, onError);
	});

	/** Put the task prompt into the editor (TUI) or send it as a user message (other modes). */
	async function fillPrompt(task: DoAlwaysTask, ctx: ExtensionContext, context: TaskContext): Promise<void> {
		const blocked = evaluateGuards(task, context);
		if (blocked) {
			ctx.ui.notify(`do-always: ${blocked}`, "info");
			return;
		}
		// Render with the same context the selector/preview used, so what the
		// user saw is exactly what gets injected.
		const prompt = renderPrompt(task.prompt, toPromptContext(context));
		if (shouldAutoRun(task)) {
			await pi.sendUserMessage(prompt);
			ctx.ui.notify(`do-always: auto-ran "${task.name}"`, "info");
			return;
		}
		if (ctx.mode === "tui") {
			ctx.ui.setEditorText(prompt);
			ctx.ui.notify(`do-always: prompt for "${task.name}" filled — press Enter to run`, "info");
		} else {
			await pi.sendUserMessage(prompt);
		}
	}

	/**
	 * Numbered selector with categorized sections. Press 1-9 to pick by global
	 * number, type to filter, or navigate with arrows + Enter, Esc to cancel.
	 * The context is built once per command run (never inside the render loop
	 * — no process spawning per frame) and shared with `fillPrompt`.
	 */
	async function showSelector(ctx: ExtensionContext, context: TaskContext): Promise<void> {
		// Filter by the `when` condition once per session, so hidden tasks never
		// appear, are never numbered, and can't be picked.
		const visibleTasks = tasks.filter((t) => evaluateWhen(t, context));
		// String view for prompt rendering (derived once, used by the preview).
		const strings = toPromptContext(context);
		const selected = await ctx.ui.custom<number | null>((tui, theme, _kb, done) => {
			let settled = false;
			let previewVisible = false;
			let previewTimer: ReturnType<typeof setTimeout> | null = null;

			function clearPreviewTimer() {
				if (previewTimer) {
					clearTimeout(previewTimer);
					previewTimer = null;
				}
			}

			// `finish` receives the chosen task (or null) and translates it to the
			// full index `tasks[selected]` expects. Reference-based, so it stays
			// correct while a text filter is active (itemRows is then a subset of
			// visibleTasks and positional indices would point at the wrong task).
			const finish = (task: DoAlwaysTask | null) => {
				if (settled) return;
				settled = true;
				clearPreviewTimer();
				done(task ? tasks.indexOf(task) : null);
			};

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
			let selectedIndex = 0;
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

			// Recompute the visible (filtered, grouped) rows on every render so
			// filter typing updates the list live.
			function getVisible() {
				const visibleGroups = groups
					.map((g) => ({ name: g.name, items: g.items.filter(matchesFilter) }))
					.filter((g) => g.items.length > 0);
				const rows: Array<
					| { kind: "header"; name: string }
					| { kind: "item"; task: DoAlwaysTask; group: string }
				> = [];
				for (const g of visibleGroups) {
					rows.push({ kind: "header", name: g.name });
					for (const t of g.items) rows.push({ kind: "item", task: t, group: g.name });
				}
				const itemRows = rows.filter((r): r is (typeof rows)[number] & { kind: "item" } => r.kind === "item");
				// Clamp selection to the visible item count.
				selectedIndex = Math.max(0, Math.min(selectedIndex, Math.max(0, itemRows.length - 1)));
				// Visible item window with scrolling.
				const winStart = Math.max(0, Math.min(selectedIndex - Math.floor(maxVisible / 2), Math.max(0, itemRows.length - maxVisible)));
				const visibleItemKeys = new Set(itemRows.slice(winStart, winStart + maxVisible).map((r) => r.task));
				const visibleHeaderNames = new Set([...visibleItemKeys].map((t) => findGroupOf(t, visibleGroups)?.name ?? ""));
				return { rows, itemRows, visibleItemKeys, visibleHeaderNames };
			}

			const labelCol = 26;

			function renderLabel(task: DoAlwaysTask, globalIndex: number, isSelected: boolean, width: number): string {
				const prefix = isSelected ? "▸ " : "  ";
				const marker = shouldAutoRun(task) ? "⚡ " : "";
				const label = `${prefix}${globalIndex + 1}. ${marker}${task.name}`;
				if (!task.description) {
					const line = truncateToWidth(label, Math.max(1, width - 2), "");
					return isSelected ? theme.fg("accent", theme.bold(line)) : line;
				}
				// Width-aware two-column layout; fall back to label-only when the
				// terminal is too narrow to fit a description column.
				const effCol = Math.max(1, Math.min(labelCol, width - 8));
				const nameOnly = truncateToWidth(label, effCol, "");
				const pad = " ".repeat(Math.max(1, effCol - visibleWidth(nameOnly)));
				const remaining = width - visibleWidth(nameOnly) - pad.length - 2;
				if (remaining < 10) {
					const line = truncateToWidth(label, Math.max(1, width - 2), "");
					return isSelected ? theme.fg("accent", theme.bold(line)) : line;
				}
				const desc = truncateToWidth(task.description, remaining, "");
				if (isSelected) {
					return theme.fg("accent", theme.bold(`${nameOnly}${pad}${desc}`));
				}
				return `${nameOnly}${pad}${theme.fg("muted", desc)}`;
			}

			// Build the full selector output for a width, plus a map from line
			// index to task for the item rows (used by mouse handling).
			function buildRender(width: number) {
				const { rows, itemRows, visibleItemKeys, visibleHeaderNames } = getVisible();
				const lines: string[] = [];
				const itemLine = new Map<number, DoAlwaysTask>();
				lines.push(theme.fg("accent", theme.bold("  do-always — pick a task")));
				lines.push("");
				if (itemRows.length === 0) {
					lines.push(theme.fg("warning", "  No matching tasks"));
				} else {
					for (const row of rows) {
						if (row.kind === "header") {
							if (!visibleHeaderNames.has(row.name)) continue;
							lines.push(theme.fg("accent", theme.bold(`  ${row.name.toUpperCase()}`)));
							continue;
						}
						if (!visibleItemKeys.has(row.task)) continue;
						const globalIndex = visibleTasks.indexOf(row.task);
						const isSelected = row.task === itemRows[selectedIndex].task;
						lines.push(renderLabel(row.task, globalIndex, isSelected, width));
						itemLine.set(lines.length - 1, row.task);
					}
					if (itemRows.length > maxVisible) {
						const hint = `  (${selectedIndex + 1}/${itemRows.length})`;
						lines.push(theme.fg("dim", truncateToWidth(hint, width - 2, "")));
					}
				}
				// Prompt preview: revealed after the selection has been stable for
				// PREVIEW_DELAY_MS, showing exactly what will be injected.
				if (previewVisible) {
					const sel = itemRows[selectedIndex];
					if (sel) {
						const wrapWidth = Math.max(10, width - 4);
						// Show the rendered prompt — exactly what will be injected.
						const wrapped = wrapTextWithAnsi(renderPrompt(sel.task.prompt, strings), wrapWidth);
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
				lines.push("");
				const anyAutoRun = itemRows.some((r) => shouldAutoRun(r.task));
				const footer = anyAutoRun
					? "  1-9 pick by number  •  type to filter  •  ↑↓ navigate  •  enter select  •  esc cancel  •  ⚡ auto-runs"
					: "  1-9 pick by number  •  type to filter  •  ↑↓ navigate  •  enter select  •  esc cancel";
				lines.push(theme.fg("dim", truncateToWidth(footer, width - 2, "")));
				return { lines, itemLine, itemRows };
			}

			return {
				render(width: number) {
					return buildRender(width).lines;
				},
				invalidate() {},
				handleInput(data: string) {
					// Direct pick by number (1-9) — only when not filtering, and within
					// the visible set, so digits pick a visible task by its number.
					if (!filter && /^[1-9]$/.test(data) && Number(data) <= visibleTasks.length) {
						finish(visibleTasks[Number(data) - 1]);
						return;
					}
					// Filter typing.
					if (kb.matches(data, "tui.editor.deleteCharBackward")) {
						filter = filter.slice(0, -1);
						selectedIndex = 0;
						resetPreview();
						tui.requestRender();
						return;
					}
					if (isPrintable(data)) {
						filter += data;
						selectedIndex = 0;
						resetPreview();
						tui.requestRender();
						return;
					}
					// Navigation / confirmation.
					const { itemRows } = getVisible();
					if (kb.matches(data, "tui.select.up")) {
						selectedIndex = selectedIndex === 0 ? itemRows.length - 1 : selectedIndex - 1;
						resetPreview();
						tui.requestRender();
					}
					else if (kb.matches(data, "tui.select.down")) {
						selectedIndex = selectedIndex === itemRows.length - 1 ? 0 : selectedIndex + 1;
						resetPreview();
						tui.requestRender();
					}
					else if (kb.matches(data, "tui.select.confirm")) {
						const chosen = itemRows[selectedIndex];
						if (chosen) finish(chosen.task);
					}
					else if (kb.matches(data, "tui.select.cancel")) {
						finish(null);
					}
				},
				handleMouse(event: TuiMouseEvent): TuiMouseEventResult | undefined {
					if (event.type === "wheel" && event.wheelDelta) {
						const { itemRows } = getVisible();
						if (itemRows.length === 0) return undefined;
						const delta = event.wheelDelta < 0 ? -1 : 1;
						const prev = selectedIndex;
						selectedIndex = Math.max(0, Math.min(itemRows.length - 1, selectedIndex + delta));
						if (selectedIndex !== prev) resetPreview();
						return { handled: true, render: selectedIndex !== prev };
					}
					if (event.button !== "left" || (event.type !== "press" && event.type !== "click")) return undefined;
					const { itemLine, itemRows } = buildRender(event.width);
					const task = itemLine.get(event.y);
					if (!task) return undefined;
					const idx = itemRows.findIndex((r) => r.task === task);
					if (idx < 0) return undefined;
					if (event.type === "press") {
						mousePressedIndex = idx;
						if (selectedIndex !== idx) {
							selectedIndex = idx;
							resetPreview();
						}
						return { handled: true, focus: true, render: true };
					}
					const clicked = mousePressedIndex ?? idx;
					mousePressedIndex = null;
					const chosen = itemRows[clicked];
					if (chosen) finish(chosen.task);
					return { handled: true };
				},
			};
		});

		if (selected === null || selected === undefined) return;
		await fillPrompt(tasks[selected], ctx, context);
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
				...visible.map((t, i) => ({ value: t.name, label: `${i + 1}. ${t.name}` })),
			].filter((c) => c.value.toLowerCase().includes(p));
			return matches.length > 0 ? matches : null;
		},
		handler: async (args, ctx) => {
			await runDoAlways(args, ctx);
		},
	});

	async function runDoAlways(args: string, ctx: ExtensionContext): Promise<void> {
		// Reload when the active directory changes, so switching projects
		// mid-session serves the right config instead of stale tasks.
		if (ctx.cwd !== loadedCwd) {
			loadedCwd = ctx.cwd;
			const onError = (m: string) => {
				if (ctx.mode === "tui") ctx.ui.notify(m, "warning");
				else console.warn(m);
			};
			tasks = loadConfig(ctx.cwd, onError).tasks;
		}

		// One context per command run: shared by visibility filtering, rendering,
		// and the completion cache (never inside a render loop).
		const context = buildContext(ctx.cwd);
		const visible = refreshVisible(ctx.cwd, context);

		const arg = args.trim();

		if (!arg) {
			if (ctx.mode === "tui") {
				await showSelector(ctx, context);
			} else {
				ctx.ui.notify(`do-always tasks (use /do-always <number|name>):\n${formatList(visible)}`, "info");
			}
			return;
		}

		if (arg.toLowerCase() === "list") {
			ctx.ui.notify(formatList(visible), "info");
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
					for (const line of renderPrompt(t.prompt, strings).split("\n")) lines.push(`   ${line}`);
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
