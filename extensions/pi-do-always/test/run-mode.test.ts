// Run modes: how a task runs when it is selected — `plan` (send + plan
// questionnaire), `run` (send as-is) or `fill` (prompt into the editor). The
// default is derived from the config (category, autoRun, questionnaire) and the
// user can override it per task for the session: ctrl+p on a row in the
// selector, or `/do-always mode <task> [plan|run|fill|default]`.
//
// Two layers are covered: the pure mode logic in tasks.ts, and the runtime
// effect in index.ts (what gets sent / filled, and whether a reply's plan block
// opens the questionnaire) driven against a stub pi runtime.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { visibleWidth } from "@earendil-works/pi-tui";
import doAlwaysExtension from "../index";
import {
	PLAN_OUTPUT_INSTRUCTION,
	RUN_MODE_CYCLE,
	chainAdd,
	chainClear,
	defaultRunMode,
	formatChainSequence,
	formatRunModes,
	isRunMode,
	nextRunMode,
	parseConfig,
	parseRunMode,
	resolveRunMode,
	runModeGlyph,
	runModeLabel,
	runModeMarker,
	runModeShort,
	type DoAlwaysTask,
	type RunMode,
} from "../tasks";

// ── Pure mode logic ──────────────────────────────────────────────────────────

const PLAN_TASK: DoAlwaysTask = { name: "Review", category: "Plan", prompt: "Review it." };
const DO_TASK: DoAlwaysTask = { name: "Build", category: "Do", prompt: "Build it." };

test("defaultRunMode derives the mode from category, autoRun and questionnaire", () => {
	assert.equal(defaultRunMode(PLAN_TASK), "plan", "a Plan task auto-runs with the questionnaire");
	assert.equal(defaultRunMode(DO_TASK), "fill", "a Do task fills the editor");
	assert.equal(defaultRunMode({ ...PLAN_TASK, questionnaire: false }), "run", "no questionnaire → plain auto-run");
	assert.equal(defaultRunMode({ ...PLAN_TASK, autoRun: false }), "fill", "autoRun false → editor");
	assert.equal(defaultRunMode({ ...DO_TASK, autoRun: true }), "run", "autoRun true → plain auto-run");
	assert.equal(defaultRunMode({ name: "x", prompt: "p" }), "fill", "uncategorized tasks fill");
	// The global questionnaire switch is the fallback for tasks that set none.
	assert.equal(defaultRunMode(PLAN_TASK, false), "run", "questionnaire disabled globally → plain auto-run");
	assert.equal(defaultRunMode({ ...PLAN_TASK, questionnaire: true }, false), "plan", "the task's own flag wins");
});

test("defaultRunMode prefers the config's own mode field", () => {
	// `mode` is the direct spelling; it wins over the legacy fields, which is
	// what makes "run Cleanup in the editor from now on" a one-field change.
	assert.equal(defaultRunMode({ ...PLAN_TASK, mode: "fill" }), "fill");
	assert.equal(defaultRunMode({ ...PLAN_TASK, mode: "run" }), "run");
	assert.equal(defaultRunMode({ ...DO_TASK, mode: "plan" }), "plan");
	assert.equal(
		defaultRunMode({ ...PLAN_TASK, mode: "fill", autoRun: true, questionnaire: true }),
		"fill",
		"an explicit mode beats autoRun + questionnaire",
	);
	assert.equal(defaultRunMode({ ...PLAN_TASK, mode: "plan" }, false), "plan", "and beats the global questionnaire switch");
	assert.equal(defaultRunMode(PLAN_TASK), "plan", "no mode field → the legacy derivation");
});

test("isRunMode accepts only the three mode names", () => {
	for (const ok of ["fill", "run", "plan"]) assert.equal(isRunMode(ok), true, ok);
	for (const bad of ["off", "on", "default", "editor", "", "PLAN", null, undefined, 3]) {
		assert.equal(isRunMode(bad), false, String(bad));
	}
});

test("nextRunMode cycles fill → run → plan → fill", () => {
	assert.deepEqual([...RUN_MODE_CYCLE], ["fill", "run", "plan"]);
	assert.equal(nextRunMode("fill"), "run");
	assert.equal(nextRunMode("run"), "plan");
	assert.equal(nextRunMode("plan"), "fill", "one ctrl+p on a Plan task disables plan mode");
});

test("resolveRunMode prefers the session override", () => {
	const overrides = new Map<string, RunMode>([["Review", "fill"]]);
	assert.equal(resolveRunMode(PLAN_TASK, overrides), "fill");
	assert.equal(resolveRunMode(DO_TASK, overrides), "fill", "untouched tasks keep their own default");
	assert.equal(resolveRunMode(PLAN_TASK, new Map(), false), "run", "the global switch still applies");
});

test("runModeMarker keeps the marker column 3 columns wide", () => {
	assert.equal(runModeMarker("fill"), "", "fill shows no marker (like a plain task)");
	assert.equal(visibleWidth(runModeMarker("plan")), 3);
	assert.equal(visibleWidth(runModeMarker("run")), 3);
	assert.equal(runModeGlyph("plan"), "⚡");
	assert.equal(runModeGlyph("run"), "▶");
	assert.equal(runModeGlyph("fill"), "");
});

test("every mode has a short and a long label", () => {
	for (const mode of RUN_MODE_CYCLE) {
		assert.ok(runModeShort(mode).includes(mode), `${mode}: the short label names the mode`);
		assert.ok(runModeLabel(mode).startsWith(mode), `${mode}: the long label names the mode`);
	}
	assert.equal(runModeShort("fill"), "✎ fill", "fill gets a glyph in the footer, where no row marker shows it");
	assert.equal(runModeShort("plan"), "⚡ plan");
	assert.equal(runModeShort("run"), "▶ run");
});

test("parseRunMode reads the mode names and their aliases", () => {
	assert.equal(parseRunMode("plan"), "plan");
	assert.equal(parseRunMode(" RUN "), "run");
	assert.equal(parseRunMode("Fill"), "fill");
	assert.equal(parseRunMode("off"), "fill", "off means: no plan mode, the prompt goes to the editor");
	assert.equal(parseRunMode("on"), "plan");
	assert.equal(parseRunMode("editor"), "fill");
	assert.equal(parseRunMode("default"), "default");
	assert.equal(parseRunMode("reset"), "default");
	for (const junk of ["", "plans", "runnow", "tru", "1"]) {
		assert.equal(parseRunMode(junk), null, `"${junk}" is not a mode`);
	}
});

test("formatRunModes lists tasks in selector order and marks the mode's source", () => {
	const tasks = [PLAN_TASK, DO_TASK];
	assert.equal(
		formatRunModes(tasks, (t) => defaultRunMode(t), (t) => (t.name === "Build" ? "session" : "default")),
		["PLAN", "1. ⚡ Review — plan", "DO", "2. Build — fill (set in this session)"].join("\n"),
		"fill carries no glyph; the session override is named",
	);
	assert.equal(
		formatRunModes(tasks, () => "run", () => "config"),
		["PLAN", "1. ▶ Review — run (config `mode`)", "DO", "2. ▶ Build — run (config `mode`)"].join("\n"),
	);
	assert.equal(
		formatRunModes(tasks, (t) => defaultRunMode(t)),
		["PLAN", "1. ⚡ Review — plan", "DO", "2. Build — fill"].join("\n"),
		"no source callback → no provenance note",
	);
});

test("formatChainSequence honors a custom marker function", () => {
	const chain = chainAdd(chainAdd(chainClear(), "Review").state, "Build").state;
	assert.equal(formatChainSequence([PLAN_TASK, DO_TASK], chain), "1.⚡Review → 2.Build", "default: ⚡ for auto-run");
	assert.equal(
		formatChainSequence([PLAN_TASK, DO_TASK], chain, (t) => runModeGlyph(t.name === "Review" ? "run" : "fill")),
		"1.▶Review → 2.Build",
		"the caller's run modes win",
	);
});

// ── Runtime effect (stub pi) ─────────────────────────────────────────────────

/** Minimal message/event shapes for the stub (structural — no pi internals). */
type Part = { type: string; text?: string };
type Msg = { role: string; content: Part[]; stopReason?: string };
type Handler = (event: Record<string, unknown>, ctx: Record<string, unknown>) => unknown;
/** A component the extension handed to ui.custom (selector, questionnaire, ...). */
type Component = {
	render?: (width: number) => string[];
	handleInput?: (data: string) => void;
	invalidate?: () => void;
};

interface Harness {
	emit(event: string, payload?: Record<string, unknown>): Promise<void>;
	messageEnd(message: Msg): Promise<Msg>;
	start(): Promise<void>;
	/** Run /do-always and wait for it to finish (non-interactive subcommands). */
	command(args: string): Promise<void>;
	/**
	 * Run /do-always without waiting: the selector's promise only resolves on
	 * the user's final keystroke, so a test drives it and settles instead.
	 */
	open(args?: string): Promise<void>;
	/** Resolve once `n` ui.custom components exist (the selector builds async). */
	waitForComponents(n: number): Promise<void>;
	turn(messages: Msg[]): Promise<void>;
	/** Every component ui.custom created, in order. */
	components(): Component[];
	/** Drive the last created component's real input handler with raw keys. */
	drive(keys: string[]): void;
	/** Render the last created component (stub theme: colors pass through). */
	render(width?: number): string;
	sent(): string[];
	editor(): string[];
	notes(): string[];
	settle(): Promise<void>;
}

const FENCE = "```";

// One exit listener for every harness this file boots: node warns past 10, and
// each test needs its own throwaway agent dir.
const tmpDirs: string[] = [];
let cleanupArmed = false;

/** Track a throwaway agent dir and remove it (once) when the process exits. */
function trackAgentDir(dir: string): void {
	const previous = process.env.PI_CODING_AGENT_DIR;
	process.env.PI_CODING_AGENT_DIR = dir;
	tmpDirs.push(dir);
	if (cleanupArmed) return;
	cleanupArmed = true;
	process.on("exit", () => {
		if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = previous;
		for (const d of tmpDirs) rmSync(d, { recursive: true, force: true });
	});
}

/** Boot the extension against a stub runtime; `extra` adds config-file keys. */
function harness(tasks: unknown[], extra: Record<string, unknown> = {}): Harness {
	const dir = mkdtempSync(join(tmpdir(), "pi-do-always-mode-"));
	writeFileSync(join(dir, "do-always.json"), JSON.stringify({ tasks, ...extra }));
	trackAgentDir(dir);

	const handlers: Record<string, Handler[]> = {};
	const sent: string[] = [];
	const editor: string[] = [];
	const notes: string[] = [];
	const components: Component[] = [];
	let command: ((args: string, ctx: Record<string, unknown>) => Promise<void>) | null = null;

	const ctx: Record<string, unknown> = {
		mode: "tui",
		cwd: dir,
		ui: {
			notify: (msg: string) => notes.push(msg),
			// pi's contract: the factory gets (tui, theme, keybindings, done)
			// and returns the component; the component calls `done` on the
			// user's final keystroke, which resolves the ui.custom promise.
			// Recording the component lets a test drive the real selector with
			// real key sequences.
			custom: (factory: (tui: unknown, theme: unknown, kb: unknown, done: (r: unknown) => void) => unknown) =>
				new Promise((resolve) => {
					const theme = { fg: (_c: string, s: string) => s, bg: (_c: string, s: string) => s, bold: (s: string) => s };
					const tui = { requestRender() {}, terminal: { columns: 80, rows: 24 } };
					components.push(factory(tui, theme, { matches: () => false }, resolve) as Component);
				}),
			editor: async (_title: string, body: string) => {
				editor.push(body);
			},
			select: async () => undefined,
			confirm: async () => false,
			input: async () => undefined,
			setWidget: () => {},
			setStatus: () => {},
			setEditorText: (text: string) => {
				editor.push(text);
			},
			getEditorText: () => "",
		},
	};

	const pi = {
		on: (event: string, h: Handler) => {
			(handlers[event] ??= []).push(h);
		},
		off: () => {},
		sendUserMessage: (text: string) => {
			sent.push(text);
		},
		sendMessage: () => {},
		registerCommand: (name: string, def: { handler: (a: string, c: Record<string, unknown>) => Promise<void> }) => {
			if (name === "do-always") command = def.handler;
		},
		registerShortcut: () => {},
		registerTool: () => {},
	};

	doAlwaysExtension(pi as never);

	const last = () => components[components.length - 1] ?? null;
	const h: Harness = {
		async emit(event, payload = {}) {
			for (const handler of handlers[event] ?? []) await handler(payload, ctx);
		},
		async messageEnd(message) {
			let current = message;
			for (const handler of handlers["message_end"] ?? []) {
				const res = (await handler({ type: "message_end", message: current }, ctx)) as { message?: Msg } | undefined;
				if (res?.message) {
					// The runtime applies a message_end replacement IN PLACE (the
					// transcript and later turns see the replacement).
					Object.keys(message).forEach((k) => delete message[k as keyof Msg]);
					Object.assign(message, res.message);
					current = message;
				}
			}
			return current;
		},
		async start() {
			await h.emit("session_start", { reason: "new" });
		},
		async command(args) {
			await command?.(args, ctx);
		},
		open(args = "") {
			return command?.(args, ctx) ?? Promise.resolve();
		},
		async waitForComponents(n, timeoutMs = 3000) {
			const startedAt = Date.now();
			while (components.length < n) {
				if (Date.now() - startedAt > timeoutMs) throw new Error(`timed out waiting for ${n} ui.custom component(s)`);
				await new Promise((r) => setTimeout(r, 5));
			}
		},
		async turn(messages) {
			await h.emit("agent_start");
			for (const m of messages) await h.messageEnd(m);
			await h.emit("agent_end", { messages });
			await h.emit("agent_settled", { aborted: messages.some((m) => m.stopReason === "aborted") });
			await h.settle();
		},
		components: () => components,
		drive(keys) {
			for (const key of keys) last()?.handleInput?.(key);
			last()?.invalidate?.(); // clear the selector's preview timer
		},
		render(width = 80) {
			return (last()?.render?.(width) ?? []).join("\n");
		},
		sent: () => sent,
		editor: () => editor,
		notes: () => notes,
		settle: () => new Promise((r) => setTimeout(r, 20)),
	};
	return h;
}

/** An assistant reply ending with a well-formed plan block. */
function planReply(marker: string): Msg {
	return {
		role: "assistant",
		content: [
			{
				type: "text",
				text:
					`Review ${marker} done.\n\n${FENCE}plan\n` +
					JSON.stringify({
						summary: `plan ${marker}`,
						tiers: [{ id: "P0", label: "Critical", items: [{ title: `fix ${marker}`, detail: "a.ts:1" }] }],
					}) +
					`\n${FENCE}\n`,
			},
		],
		stopReason: "stop",
	};
}
const hasFence = (msg: Msg) => String(msg.content[0]?.text ?? "").includes(FENCE + "plan");
const lastNote = (h: Harness) => h.notes().at(-1) ?? "";

const MODE_PLAN = { name: "Plan review", category: "Plan", prompt: "Review and propose." };
const MODE_DO = { name: "Do build", category: "Do", prompt: "Build it." };

test("parseConfig reads a valid mode and rejects an invalid one", () => {
	const warns: string[] = [];
	const parse = (raw: string) => parseConfig(raw, "test.json", (m) => warns.push(m));
	const ok = parse(JSON.stringify([{ name: "x", prompt: "p", mode: "fill" }]));
	assert.equal(ok.tasks[0].mode, "fill");
	assert.equal(warns.length, 0, "a valid mode is silent");

	const bad = parse(JSON.stringify([{ name: "y", prompt: "p", mode: "sideways" }]));
	assert.equal(bad.tasks[0].mode, undefined, "an invalid mode is dropped");
	assert.ok(
		warns.some((w) => w.includes('"mode"') && w.includes("y")),
		"…with a warning naming the task",
	);

	const absent = parse(JSON.stringify([{ name: "z", prompt: "p" }]));
	assert.ok(!("mode" in absent.tasks[0]), "the key is omitted when the file does not set one");
});

test("a config mode is used, and /do-always mode says where it came from", async () => {
	const h = harness([{ name: "Cfg Plan", category: "Plan", prompt: "Review.", mode: "fill" }]);
	await h.start();
	await h.command("mode");
	assert.ok(lastNote(h).includes("Cfg Plan — fill (config `mode`)"), lastNote(h));

	await h.command("Cfg Plan");
	assert.equal(h.sent().length, 0, "the config mode is honored on select");
	assert.deepEqual(h.editor(), ["Review."], "…the prompt went to the editor");

	// A session override still wins over the config field…
	await h.command("mode Cfg Plan plan");
	await h.command("mode");
	assert.ok(lastNote(h).includes("Cfg Plan — plan (set in this session)"), lastNote(h));
	// …and `default` drops the override, landing back on the config value.
	await h.command("mode Cfg Plan default");
	assert.ok(lastNote(h).includes("(its config `mode`)"), lastNote(h));
	await h.command("mode");
	assert.ok(lastNote(h).includes("Cfg Plan — fill (config `mode`)"), lastNote(h));
});

test("default: a Plan task is sent with the plan-block instruction", async () => {
	const h = harness([MODE_PLAN]);
	await h.start();
	await h.command("mode plan");
	await h.command("Plan review");
	assert.equal(h.sent().length, 1);
	assert.ok(h.sent()[0].startsWith(PLAN_OUTPUT_INSTRUCTION), "the plan instruction is prepended");
	assert.equal(h.editor().length, 0, "nothing is filled into the editor");
});

test("mode fill: the prompt goes to the editor without the plan instruction", async () => {
	const h = harness([MODE_PLAN]);
	await h.start();
	await h.command("mode Plan review fill");
	assert.ok(lastNote(h).includes('"Plan review" → fill'), "the new mode is reported");
	await h.command("Plan review");
	assert.equal(h.sent().length, 0, "a fill task is never sent on select");
	assert.deepEqual(h.editor(), ["Review and propose."], "the bare prompt, no plan instruction");
});

test("mode run: sent as-is, and a plan block in the reply opens no questionnaire", async () => {
	const h = harness([MODE_PLAN]);
	await h.start();
	await h.command("mode Plan review run");
	await h.command("Plan review");
	assert.equal(h.sent().length, 1);
	assert.ok(!h.sent()[0].includes(PLAN_OUTPUT_INSTRUCTION), "no plan block is asked for");
	const reply = planReply("run-mode");
	await h.turn([reply]);
	assert.equal(h.components().length, 0, "no questionnaire overlay for a non-plan run");
	assert.equal(hasFence(reply), true, "and nothing is stripped from the transcript");
	assert.ok(lastNote(h).includes("Plan review"), "the plain summary is still posted");
});

test("mode plan can be switched ON for a non-Plan task", async () => {
	const h = harness([MODE_DO]);
	await h.start();
	await h.command("mode Do build plan");
	await h.command("Do build");
	assert.equal(h.sent().length, 1);
	assert.ok(h.sent()[0].startsWith(PLAN_OUTPUT_INSTRUCTION), "the Do task now asks for a plan block");
	const reply = planReply("do-as-plan");
	await h.turn([reply]);
	assert.equal(h.components().length, 1, "the questionnaire opens");
	assert.equal(hasFence(reply), false, "and the fence is stripped from the transcript");
});

test("mode with no argument cycles, and `default` clears the override", async () => {
	const h = harness([MODE_PLAN]);
	await h.start();
	await h.command("mode Plan review");
	assert.ok(lastNote(h).includes("→ fill"), "plan → fill (one press disables plan mode)");
	await h.command("mode Plan review");
	assert.ok(lastNote(h).includes("→ run"), "fill → run");
	await h.command("mode Plan review");
	assert.ok(lastNote(h).includes("→ plan"), "run → plan");
	await h.command("mode Plan review fill");
	await h.command("mode");
	assert.ok(lastNote(h).includes("Plan review — fill (set in this session)"), "the listing marks the override");
	await h.command("mode Plan review default");
	assert.ok(lastNote(h).includes("(its default)") && lastNote(h).includes("→ plan"), "the config default applies again");
	await h.command("mode");
	assert.ok(lastNote(h).includes("Plan review — plan"), "the listing shows effective modes");
	assert.ok(!lastNote(h).includes("this session"), "and no override is marked once cleared");
	await h.command("mode Plan review off");
	assert.ok(lastNote(h).includes("→ fill"), "`off` is an alias for fill");
});

test("mode accepts a task number and rejects unknown names and modes", async () => {
	const h = harness([MODE_PLAN, MODE_DO]);
	await h.start();
	await h.command("mode 2 run");
	assert.ok(lastNote(h).includes('"Do build" → run'), "numbers index the visible list");
	await h.command("mode nope fill");
	assert.ok(lastNote(h).includes('unknown task "nope"'));
	await h.command("mode Plan review sideways");
	// "sideways" is not a mode, so the whole string is read as a task name.
	assert.ok(lastNote(h).includes("unknown task"), "an unknown mode falls back to the name lookup");
});

test("selector ctrl+p cycles the row under the cursor and the row shows it", async () => {
	const h = harness([MODE_PLAN, MODE_DO]);
	await h.start();
	const opened = h.open();
	await h.waitForComponents(1);

	const before = h.render();
	assert.ok(before.includes("⚡ Plan review"), "the Plan row carries the ⚡ marker");
	assert.ok(before.includes("ctrl+p ⚡ plan"), "the footer names the cursor row's mode");

	h.drive(["\x10"]); // ctrl+p on the first row (Plan review): plan → fill
	const after = h.render();
	assert.ok(!after.includes("⚡"), "the ⚡ marker is gone");
	assert.ok(after.includes("ctrl+p ✎ fill"), "the footer shows the new mode");

	h.drive(["\x10"]); // fill → run
	assert.ok(h.render().includes("▶  Plan review"), "run shows ▶");

	h.drive(["\x1b[B"]); // ↓ to the second row (Do build)
	assert.ok(h.render().includes("ctrl+p ✎ fill"), "the footer follows the cursor");
	h.drive(["\x10"]); // Do build: fill → run
	h.drive(["\x1b[A", "\r"]); // ↑ back to Plan review, Enter: run it in its current mode
	await h.settle();
	assert.equal(h.sent().length, 1, "the selected task ran");
	assert.equal(h.sent()[0], "Review and propose.", "…in the mode ctrl+p left it in: sent as-is, no plan block");
	assert.equal(h.editor().length, 0);
	await opened;
});

test("selector ctrl+p on a Plan task then Enter fills the editor", async () => {
	const h = harness([MODE_PLAN]);
	await h.start();
	const opened = h.open();
	await h.waitForComponents(1);
	h.drive(["\x10", "\r"]); // plan → fill, then Enter
	await h.settle();
	assert.equal(h.sent().length, 0, "nothing is sent");
	assert.deepEqual(h.editor(), ["Review and propose."]);
	await opened;
});

test("the selector ignores ctrl+p on the pinned Run row", async () => {
	const h = harness([MODE_PLAN]);
	await h.start();
	const opened = h.open();
	await h.waitForComponents(1);
	h.drive(["\x1b[B", "\x10"]); // ↓ to the Run row, ctrl+p (no row → no-op)
	h.drive(["\r"]); // Enter on an empty chain: it complains and stays open
	await h.settle();
	assert.equal(h.sent().length, 0, "an empty chain runs nothing");
	assert.ok(h.notes().some((n) => n.includes("chain is empty")), "…and says why");
	h.drive(["\x1b"]); // Esc closes the selector, resolving the ui.custom promise
	await opened;
});

test("the ctrl+p hint is shown at every terminal width", async () => {
	// Regression: the footer used to be one truncated string, so on a terminal
	// narrower than the full hint the mode segment vanished — ctrl+p worked but
	// nothing advertised it. Segments are now fitted by priority.
	const h = harness([MODE_PLAN, MODE_DO]);
	await h.start();
	const opened = h.open();
	await h.waitForComponents(1);
	const footerAt = (width: number) => (h.render(width).split("\n").at(-1) ?? "").replace(/\s+$/, "");
	for (const width of [120, 100, 80, 76, 70, 58, 46, 40, 30]) {
		const footer = footerAt(width);
		assert.ok(footer.includes("ctrl+p"), `width ${width}: the hint is shown — "${footer}"`);
		assert.ok(visibleWidth(footer) <= width - 2, `width ${width}: the footer fits — "${footer}"`);
	}
	assert.ok(footerAt(80).includes("ctrl+p ⚡ plan"), "wide terminals get the full hint with the mode name");
	assert.equal(footerAt(30), "  1-9 run now  •  ctrl+p", "narrow ones degrade to the bare key");
	// The ORDER column advertises it too (ctrl+p works from either column).
	h.drive(["\x1b[C"]);
	for (const width of [80, 58, 40]) {
		const footer = footerAt(width);
		assert.ok(footer.includes("ctrl+p"), `order column at ${width}: "${footer}"`);
		assert.ok(visibleWidth(footer) <= width - 2, `order column at ${width} fits: "${footer}"`);
	}
	h.drive(["\x1b"]);
	await opened;
});

test("a chain's first step follows the overridden mode", async () => {
	// report: false — no report file and no inline report view, so the editor
	// only ever holds step 1's prompt.
	const h = harness([MODE_PLAN], { report: false });
	await h.start();
	await h.command("mode Plan review fill");
	const opened = h.open();
	await h.waitForComponents(1);
	// → (ORDER column), Enter (add to the chain), ↓ (pinned Run row), Enter (run).
	h.drive(["\x1b[C", "\r", "\x1b[B", "\r"]);
	await h.settle();
	assert.equal(h.sent().length, 0, "a fill step 1 waits in the editor instead of being sent");
	assert.deepEqual(h.editor(), ["Review and propose."], "step 1 used the overridden mode");
	assert.ok(h.notes().some((n) => n.includes("step 1 of 1 in the editor")), "the chain says it is waiting");
	// The user's Enter on step 1: the run settles and the chain completes.
	// (runChain fires the waiter off, so `opened` resolves before the step.)
	await opened;
	await h.turn([{ role: "assistant", content: [{ type: "text", text: "done" }], stopReason: "stop" }]);
	await h.settle();
	assert.ok(h.notes().some((n) => n.includes("step 1/1")), "the chain reports its step summary");
});
