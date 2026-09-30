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
import type { ExtensionAPI, ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
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
	DEFAULT_SHORTCUT,
	DEFAULT_TASKS,
	buildTableRows,
	chainAdd,
	chainClear,
	chainRemove,
	chainRunLabel,
	chainUndo,
	evaluateGuards,
	evaluateWhen,
	formatChainSequence,
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
	validateChain,
	type DoAlwaysTask,
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

/** True for a single printable ASCII character (used for filter typing). */
function isPrintable(data: string): boolean {
	return data.length === 1 && data >= " " && data <= "~";
}

/** Delay before the selector reveals the selected task's prompt preview. */
const PREVIEW_DELAY_MS = 2000;
/** Max lines of the prompt shown in the selector preview. */
const PREVIEW_MAX_LINES = 3;

/** Outcome of one chain step's run (see sendAndWait). */
type ChainStepOutcome = "completed" | "aborted" | "error" | "failed-to-start";

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
	} | null = null;

	function settleChainWaiter(outcome: ChainStepOutcome) {
		if (!chainWaiter) return;
		const waiter = chainWaiter;
		chainWaiter = null;
		if (waiter.timer) clearTimeout(waiter.timer);
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

	/** Remove the widget and forget the status. */
	function clearChainWidget(ctx: ExtensionContext): void {
		if (!chainStatus) return;
		chainStatus = null;
		if (ctx.mode === "tui") ctx.ui.setWidget(CHAIN_WIDGET_KEY, undefined);
	}

	/** Render the status widget from `chainStatus` (TUI only). */
	function updateChainWidget(ctx: ExtensionContext): void {
		if (ctx.mode !== "tui" || !chainStatus) return;
		const { steps, note } = chainStatus;
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
		if (chainWaiter) chainWaiter.started = true;
		// Fill-first: step 1 left the editor and is running — update the
		// widget (and drop the "press Enter" note) as soon as the run starts.
		if (lastCtx && chainStatus?.steps[0]?.status === "waiting") {
			setChainStep(lastCtx, 0, "running", "");
		}
	});
	pi.on("agent_end", (event) => {
		if (!chainWaiter) return;
		const lastAssistant = [...event.messages].reverse().find((m) => m.role === "assistant");
		if (lastAssistant) {
			const stopReason = lastAssistant.stopReason;
			chainWaiter.outcome = stopReason === "aborted" ? "aborted" : stopReason === "error" ? "error" : "completed";
		}
	});
	pi.on("agent_settled", () => {
		if (!chainWaiter) return;
		settleChainWaiter(chainWaiter.started ? (chainWaiter.outcome ?? "completed") : "failed-to-start");
	});

	/**
	 * Arm the chain waiter and resolve when the next run has fully settled
	 * (agent_settled), reporting that run's outcome. With `graceMs`, resolves
	 * "failed-to-start" if no agent_start arrives in time — a send that
	 * throws before the run begins emits no agent events and its error is
	 * swallowed by the runtime.
	 */
	function armWaiter(graceMs?: number): Promise<ChainStepOutcome> {
		return new Promise((resolve) => {
			const timer = graceMs
				? setTimeout(() => {
						if (chainWaiter && !chainWaiter.started) settleChainWaiter("failed-to-start");
					}, graceMs)
				: null;
			chainWaiter = { started: false, outcome: null, timer, resolve };
		});
	}

	/**
	 * Send a prompt and resolve when the run it starts has fully settled,
	 * reporting the run's outcome (see armWaiter).
	 */
	function sendAndWait(prompt: string, graceMs = 10_000): Promise<ChainStepOutcome> {
		const done = armWaiter(graceMs);
		pi.sendUserMessage(prompt);
		return done;
	}

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
			// Fire-and-forget: sendUserMessage returns void; the run proceeds
			// independently (see the chain control notes for why).
			pi.sendUserMessage(prompt);
			ctx.ui.notify(`do-always: auto-ran "${task.name}"`, "info");
			return;
		}
		if (ctx.mode === "tui") {
			ctx.ui.setEditorText(prompt);
			ctx.ui.notify(`do-always: prompt for "${task.name}" filled — press Enter to run`, "info");
		} else {
			pi.sendUserMessage(prompt);
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
	async function runChain(names: string[], ctx: ExtensionContext): Promise<void> {
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
		const blocked = validateChain(tasks, { items: names, history: [] }, buildContext(ctx.cwd));
		if (blocked) {
			ctx.ui.notify(`do-always: chain blocked at step ${blocked.step} (${blocked.task.name}): ${blocked.message}`, "warning");
			return;
		}
		chainActive = true;
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
		ctx.ui.setEditorText(renderPrompt(first.prompt, toPromptContext(buildContext(ctx.cwd))));
		ctx.ui.notify(
			`do-always: step 1 of ${steps.length} in the editor — press Enter to run; steps 2–${steps.length} follow automatically`,
			"info",
		);
		void armWaiter().then(async (outcome) => {
			try {
				if (outcome !== "completed") {
					markChainStopped(ctx, 0, outcome);
					ctx.ui.notify(`do-always: step 1 — ${outcome}; chain stopped`, "error");
					return;
				}
				setChainStep(ctx, 0, "completed");
				await runChainSteps(steps, ctx, 1);
			} finally {
				chainActive = false;
			}
		});
	}

	/**
	 * Send chain steps `startAt..end` sequentially. Each step gets a fresh
	 * context (so its guards see the tree as it is now) and is awaited until
	 * its run has fully settled; an aborted/errored step (or a send that
	 * failed to start) stops the chain.
	 */
	async function runChainSteps(steps: DoAlwaysTask[], ctx: ExtensionContext, startAt: number): Promise<void> {
		for (let i = startAt; i < steps.length; i++) {
			const step = steps[i];
			const context = buildContext(ctx.cwd);
			const blocked = evaluateGuards(step, context);
			if (blocked) {
				markChainStopped(ctx, i, "skipped", blocked);
				ctx.ui.notify(`do-always: chain stopped at step ${i + 1} (${step.name}): ${blocked}`, "warning");
				return;
			}
			const prompt = renderPrompt(step.prompt, toPromptContext(context));
			const label = `do-always: step ${i + 1}/${steps.length} — ${step.name}`;
			setChainStep(ctx, i, "running");
			ctx.ui.notify(`${label} — starting`, "info");
			const outcome = await sendAndWait(prompt);
			if (outcome === "completed") {
				setChainStep(ctx, i, "completed");
				continue;
			}
			markChainStopped(ctx, i, outcome);
			if (outcome === "failed-to-start") {
				ctx.ui.notify(`${label} — failed to start (check model/API key); chain stopped`, "error");
			} else if (outcome === "aborted") {
				ctx.ui.notify(`${label} — aborted; chain stopped`, "error");
			} else {
				ctx.ui.notify(`${label} — run errored; chain stopped`, "error");
			}
			return;
		}
		clearChainWidget(ctx);
		ctx.ui.notify(`do-always: chain complete (${steps.length} steps)`, "info");
	}

	/**
	 * Task table with an ORDER column (the chain) and a pinned Run row:
	 *
	 *   #  TASK                  DESCRIPTION              ORDER
	 *   1  ⚡ Review changes      Review the current       ▸[1]
	 *   2  Build                 Build the project          ·
	 *   ─────────────────────────────────────────────────────
	 *   ▶ Run the chain (1)
	 *
	 * The TASK column is primary: Enter runs just the task under the cursor
	 * (the classic pick). The ORDER column is the optional chain: Enter
	 * toggles the task's membership, and the pinned Run row runs the whole
	 * chain. ←/→ switch columns, 1-9 still runs a task immediately (closing
	 * the selector, discarding the chain). The context is built once per command
	 * run (never inside the render loop — no process spawning per frame) and
	 * shared with `fillPrompt`.
	 */
	async function showSelector(ctx: ExtensionContext, context: TaskContext): Promise<void> {
		// Filter by the `when` condition once per session, so hidden tasks never
		// appear, are never numbered, and can't be picked.
		const visibleTasks = tasks.filter((t) => evaluateWhen(t, context));
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
				for (const r of tableRows) {
					if (r.kind === "run") continue; // pinned row, rendered separately
					bodyRows.push(r);
					if (r.kind === "task" && r.task) {
						itemRows.push({ task: r.task, globalIndex: visibleTasks.indexOf(r.task), order: r.order });
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

			// Keep the cursor valid after the rows or the chain change. (The
			// ORDER cell of a non-chained row is a valid cursor position: it is
			// the "add" state.)
			function clampCursor() {
				const { itemRows } = getVisible();
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

			// Build the full selector output for a width, plus the line map for
			// mouse handling (itemLine: line -> task, runLine: the Run row,
			// orderColX: where the ORDER cell starts, or null in the narrow tier).
			function buildTable(width: number) {
				const { bodyRows, itemRows, winStart, visibleHeaderNames } = getVisible();
				const { tier, taskCol, descCol, orderColX } = tableGeometry(width);
				const lines: string[] = [];
				const itemLine = new Map<number, DoAlwaysTask>();
				let runLine = -1;

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
						const idx = itemRows.findIndex((x) => x.task === row.task);
						if (idx < 0 || idx < winStart || idx >= winStart + maxVisible) continue;
						itemShown++;
						const task = row.task;
						const auto = shouldAutoRun(task);
						const focused = cursor.kind === "cell" && cursor.row === idx;
						// The ▸ in the ORDER cell marks the ORDER column specifically;
						// the full-row background marks the row in either column.
						const inOrderCol =
							cursor.kind === "cell" && cursor.row === idx && cursor.col === "order";
						const num = `  ${String(itemRows[idx].globalIndex + 1).padStart(2)}`;
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
									? truncateToWidth(`▸[${row.order}]`, ORDER_COL_W, "", true)
									: ` [${row.order}] `
								: inOrderCol
									? "▸  · "
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
						// The cursor is a full-row background highlight so it is
						// visible at a glance; the ▸ in the ORDER cell marks the
						// column.
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

				// Pinned Run row (always visible, outside the scroll window).
				lines.push("");
				lines.push(theme.fg("dim", "  " + "─".repeat(Math.max(1, width - 4))));
				const runLabel = chainRunLabel(chain.items.length);
				runLine = lines.length;
				if (cursor.kind === "run") {
					lines.push(theme.bg("selectedBg", theme.bold(`▸ ▶ ${runLabel}`)));
				} else if (chain.items.length === 0) {
					lines.push(theme.fg("dim", `  ▶ ${runLabel}`));
				} else {
					lines.push(theme.fg("accent", `  ▶ ${runLabel}`));
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
					return buildTable(width).lines;
				},
				invalidate() {},
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
					// filter it undoes the last chain add).
					if (kb.matches(data, "tui.editor.deleteCharBackward")) {
						if (filter.length > 0) {
							filter = filter.slice(0, -1);
							clampCursor();
						} else {
							const { state, removed } = chainUndo(chain);
							if (removed) {
								chain = state;
								clampCursor();
							}
						}
						resetPreview();
						tui.requestRender();
						return;
					}
					if (isPrintable(data)) {
						filter += data;
						clampCursor();
						resetPreview();
						tui.requestRender();
						return;
					}
					const { itemRows } = getVisible();
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
							clampCursor();
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
					const { itemLine, runLine, orderColX } = buildTable(event.width);
					// Pinned Run row: press runs the chain.
					if (runLine >= 0 && event.y === runLine) {
						if (event.type === "press" && chain.items.length > 0) {
							finishChain([...chain.items]);
						}
						return { handled: true };
					}
					const task = itemLine.get(event.y);
					if (!task) return undefined;
					const { itemRows } = getVisible();
					const idx = itemRows.findIndex((r) => r.task === task);
					if (idx < 0) return undefined;
					// ORDER cell: press toggles chain membership.
					if (orderColX !== null && event.x >= orderColX) {
						if (event.type === "press") {
							chain = chain.items.includes(task.name) ? chainRemove(chain, task.name) : chainAdd(chain, task.name).state;
							clampCursor();
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
			await runChain(result.names, ctx);
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
