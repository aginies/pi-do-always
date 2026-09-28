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
import { Container, type KeyId, type SelectItem, SelectList, Text } from "@earendil-works/pi-tui";
import {
	DEFAULT_SHORTCUT,
	DEFAULT_TASKS,
	formatList,
	isValidKeyId,
	mergeTasks,
	parseConfig,
	resolveShortcut,
	resolveTask,
	type DoAlwaysTask,
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
		tasks: mergeTasks(global.tasks, project.tasks, DEFAULT_TASKS),
		shortcut: resolveShortcut(global.shortcut, project.shortcut),
	};
}

export default function doAlwaysExtension(pi: ExtensionAPI) {
	let tasks: DoAlwaysTask[] = [];
	let loadedCwd = ""; // cwd the cached `tasks` were loaded for

	pi.on("session_start", async (_event, ctx) => {
		loadedCwd = ctx.cwd;
		tasks = loadConfig(ctx.cwd).tasks;
	});

	/** Put the task prompt into the editor (TUI) or send it as a user message (other modes). */
	async function fillPrompt(task: DoAlwaysTask, ctx: ExtensionContext): Promise<void> {
		if (ctx.mode === "tui") {
			ctx.ui.setEditorText(task.prompt);
			ctx.ui.notify(`do-always: prompt for "${task.name}" filled — press Enter to run`, "info");
		} else {
			await pi.sendUserMessage(task.prompt);
		}
	}

	/** Numbered selector: press 1-9 to pick, or arrows + Enter, Esc to cancel. */
	async function showSelector(ctx: ExtensionContext): Promise<void> {
		const items: SelectItem[] = tasks.map((t, i) => ({
			value: String(i),
			label: `${i + 1}. ${t.name}`,
			description: t.description,
		}));

		const selected = await ctx.ui.custom<number | null>((tui, theme, _kb, done) => {
			let settled = false;
			const finish = (value: number | null) => {
				if (settled) return;
				settled = true;
				done(value);
			};

			const container = new Container();
			container.addChild(new Text(theme.fg("accent", theme.bold("do-always — pick a task"))));

			const selectList = new SelectList(items, Math.min(items.length, 10), {
				selectedPrefix: (text) => theme.fg("accent", text),
				selectedText: (text) => theme.fg("accent", text),
				description: (text) => theme.fg("muted", text),
				scrollInfo: (text) => theme.fg("dim", text),
				noMatch: (text) => theme.fg("warning", text),
			});
			selectList.onSelect = (item) => finish(Number(item.value));
			selectList.onCancel = () => finish(null);
			container.addChild(selectList);
			container.addChild(new Text(theme.fg("dim", "1-9 pick by number  •  ↑↓ navigate  •  enter select  •  esc cancel")));

			return {
				render(width: number) {
					return container.render(width);
				},
				invalidate() {
					container.invalidate();
				},
				handleInput(data: string) {
					// Direct pick by number (1-9)
					if (/^[1-9]$/.test(data) && Number(data) <= tasks.length) {
						finish(Number(data) - 1);
						return;
					}
					selectList.handleInput(data);
					tui.requestRender();
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
