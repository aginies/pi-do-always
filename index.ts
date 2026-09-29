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
	formatList,
	groupTasksByCategory,
	isValidKeyId,
	mergeTasks,
	parseConfig,
	orderTasksByCategory,
	resolveShortcut,
	resolveTask,
	shouldAutoRun,
	type DoAlwaysTask,
	type TaskGroup,
} from "./tasks";

/**
 * Load tasks and the selector shortcut from config files.
 * Project-local tasks override global tasks with the same name; new ones are appended.
 * Falls back to DEFAULT_TASKS when nothing is defined.
 */
function loadConfig(cwd: string): { tasks: DoAlwaysTask[]; shortcut: string | null } {
	const globalPath = join(getAgentDir(), "do-always.json");
	const projectPath = join(cwd, CONFIG_DIR_NAME, "do-always.json");

	const global = existsSync(globalPath)
		? parseConfig(readFileSync(globalPath, "utf-8"), globalPath)
		: { tasks: [], shortcut: undefined };
	const project = existsSync(projectPath)
		? parseConfig(readFileSync(projectPath, "utf-8"), projectPath)
		: { tasks: [], shortcut: undefined };

	return {
		// Order the merged list by category so the selector numbers, digit-pick,
		// `/do-always <n>`, and `list` all share one consistent order.
		tasks: orderTasksByCategory(mergeTasks(global.tasks, project.tasks, DEFAULT_TASKS)),
		shortcut: resolveShortcut(global.shortcut, project.shortcut),
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

	pi.on("session_start", async (_event, ctx) => {
		loadedCwd = ctx.cwd;
		tasks = loadConfig(ctx.cwd).tasks;
	});

	/** Put the task prompt into the editor (TUI) or send it as a user message (other modes). */
	async function fillPrompt(task: DoAlwaysTask, ctx: ExtensionContext): Promise<void> {
		if (shouldAutoRun(task)) {
			await pi.sendUserMessage(task.prompt);
			ctx.ui.notify(`do-always: auto-ran "${task.name}"`, "info");
			return;
		}
		if (ctx.mode === "tui") {
			ctx.ui.setEditorText(task.prompt);
			ctx.ui.notify(`do-always: prompt for "${task.name}" filled — press Enter to run`, "info");
		} else {
			await pi.sendUserMessage(task.prompt);
		}
	}

	/**
	 * Numbered selector with categorized sections. Press 1-9 to pick by global
	 * number, type to filter, or navigate with arrows + Enter, Esc to cancel.
	 */
	async function showSelector(ctx: ExtensionContext): Promise<void> {
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

			const finish = (value: number | null) => {
				if (settled) return;
				settled = true;
				clearPreviewTimer();
				done(value);
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
			const groups = groupTasksByCategory(tasks);

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
						const globalIndex = tasks.indexOf(row.task);
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
						const wrapped = wrapTextWithAnsi(sel.task.prompt, wrapWidth);
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
					// Direct pick by number (1-9) — only when not filtering, so
					// digits can be typed into the filter otherwise.
					if (!filter && /^[1-9]$/.test(data) && Number(data) <= tasks.length) {
						finish(Number(data) - 1);
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
						if (chosen) finish(tasks.indexOf(chosen.task));
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
					if (chosen) finish(tasks.indexOf(chosen.task));
					return { handled: true };
				},
			};
		});

		if (selected === null || selected === undefined) return;
		await fillPrompt(tasks[selected], ctx);
	}

	pi.registerCommand("do-always", {
		description: "Pick a common task (review, readme, ...) by number — fills the prompt",
		getArgumentCompletions: (prefix) => {
			const p = prefix.trim().toLowerCase();
			const matches = [
				{ value: "list", label: "list" },
				{ value: "list-details", label: "list-details" },
				...tasks.map((t, i) => ({ value: t.name, label: `${i + 1}. ${t.name}` })),
			].filter((c) => c.value.toLowerCase().includes(p));
			return matches.length > 0 ? matches : null;
		},
		handler: async (args, ctx) => {
			await runDoAlways(args, ctx);
		},
	});

	// Keyboard shortcut: open the task selector without typing the command.
	// The key is configurable via the "shortcut" field in do-always.json
	// (null disables it). It is read once at extension load, so changing it
	// requires a reload or a new session.
	const configuredShortcut = loadConfig(process.cwd()).shortcut;
	if (configuredShortcut !== null) {
		const shortcutKey = isValidKeyId(configuredShortcut) ? configuredShortcut : DEFAULT_SHORTCUT;
		if (shortcutKey !== configuredShortcut) {
			console.warn(`do-always: invalid shortcut "${configuredShortcut}" in do-always.json — using ${DEFAULT_SHORTCUT}`);
		}
		pi.registerShortcut(shortcutKey as KeyId, {
			description: "do-always: pick a common task",
			handler: async (ctx) => {
				await runDoAlways("", ctx);
			},
		});
	}

	async function runDoAlways(args: string, ctx: ExtensionContext): Promise<void> {
		// Reload when the active directory changes, so switching projects
		// mid-session serves the right config instead of stale tasks.
		if (ctx.cwd !== loadedCwd) {
			loadedCwd = ctx.cwd;
			tasks = loadConfig(ctx.cwd).tasks;
		}

		const arg = args.trim();

		if (!arg) {
			if (ctx.mode === "tui") {
				await showSelector(ctx);
			} else {
				ctx.ui.notify(`do-always tasks (use /do-always <number|name>):\n${formatList(tasks)}`, "info");
			}
			return;
		}

		if (arg.toLowerCase() === "list") {
			ctx.ui.notify(formatList(tasks), "info");
			return;
		}

		if (arg.toLowerCase() === "list-details") {
			// Display only — the description is metadata; selecting a task injects just its prompt.
			const details = tasks
				.map((t, i) => {
					const lines = [`${i + 1}. ${t.name}`];
					if (t.description) lines.push(`   description: ${t.description}`);
					lines.push("   prompt (this is what gets injected on select):");
					for (const line of t.prompt.split("\n")) lines.push(`   ${line}`);
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

		const task = resolveTask(tasks, arg);
		if (!task) {
			const available = tasks.map((t, i) => `${i + 1}=${t.name}`).join(", ");
			ctx.ui.notify(`do-always: unknown task "${arg}". Available: ${available}`, "error");
			return;
		}
		await fillPrompt(task, ctx);
	}
}
