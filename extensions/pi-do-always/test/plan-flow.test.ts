// Regression tests for the plan-questionnaire RUN FLOW (the event state
// machine in index.ts), not just the parser: an auto-run Plan task must reach a
// questionnaire even when its own run was interrupted, and a stray plan fence
// in an unrelated turn must never open one.
//
// The pi runtime is stubbed: the extension boots against a fake `pi`, events
// are emitted by hand, and `ui.custom` (the questionnaire overlay) is recorded
// and driven with real key sequences instead of rendered. A throwaway agent dir
// keeps config resolution off the developer's own ~/.pi.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import doAlwaysExtension from "../index";

/** Minimal message/event shapes for the stub (structural — no pi internals). */
type Part = { type: string; text?: string };
type Msg = { role: string; content: Part[]; stopReason?: string };
type Handler = (event: Record<string, unknown>, ctx: Record<string, unknown>) => unknown;
/** The questionnaire component the extension hands back from ui.custom. */
type Overlay = { handleInput?: (data: string) => void; render?: (width: number) => string[] };

interface Harness {
	emit(event: string, payload?: Record<string, unknown>): Promise<void>;
	messageEnd(message: Msg): Promise<Msg>;
	start(): Promise<void>;
	command(args: string): Promise<void>;
	turn(messages: Msg[]): Promise<void>;
	questionnaireOpened(): boolean;
	/** The open questionnaire's rendered text ("" when none is open). */
	overlayText(): string;
	/** Answer the open questionnaire the way the TUI keys would. */
	answer(kind: "confirm" | "withdraw"): Promise<void>;
	sent(): string[];
	notes(): string[];
	settle(): Promise<void>;
}

/** Boot the extension against a stub runtime; `extra` adds config-file keys. */
function harness(tasks: unknown[], extra: Record<string, unknown> = {}): Harness {
	const dir = mkdtempSync(join(tmpdir(), "pi-do-always-test-"));
	writeFileSync(join(dir, "do-always.json"), JSON.stringify({ tasks, ...extra }));
	const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
	process.env.PI_CODING_AGENT_DIR = dir;

	const handlers: Record<string, Handler[]> = {};
	const sent: string[] = [];
	const notes: string[] = [];
	const answers: unknown[] = [];
	let overlay: Overlay | null = null;
	let overlayOpened = false;
	let command: ((args: string, ctx: Record<string, unknown>) => Promise<void>) | null = null;

	const ctx: Record<string, unknown> = {
		mode: "tui",
		cwd: dir,
		ui: {
			notify: (msg: string) => notes.push(msg.split("\n")[0]),
			// pi's contract: the factory gets (tui, theme, keybindings, done)
			// and returns the component; the component calls `done` on the
			// user's final keystroke. `done` is recorded, so driving the
			// component's real input handler answers the questionnaire exactly
			// as the TUI would.
			custom: (
				factory: (
					tui: unknown,
					theme: unknown,
					kb: unknown,
					done: (r: unknown) => void,
				) => unknown,
			) => {
				overlayOpened = true;
				const theme = { fg: (_c: string, s: string) => s, bg: (_c: string, s: string) => s, bold: (s: string) => s };
				const tui = { requestRender() {}, terminal: { columns: 80, rows: 24 } };
				const created = factory(tui, theme, { matches: () => false }, (r: unknown) => answers.push(r)) as Overlay;
				overlay = created;
				// Select everything, jump to the pinned Confirm row, press Enter.
				// (Withdraw: Esc.)
				(created as Overlay & { __answer?: (kind: string) => void }).__answer = (kind: string) => {
					if (kind === "withdraw") created.handleInput?.("\x1b");
					else {
						created.handleInput?.("a");
						created.handleInput?.("\x1b[F");
						created.handleInput?.("\r");
					}
				};
			},
			select: async () => undefined,
			confirm: async () => false,
			input: async () => undefined,
			setWidget: () => {},
			setStatus: () => {},
			setEditorText: () => {},
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
		registerCommand: (
			name: string,
			def: { handler: (args: string, c: Record<string, unknown>) => Promise<void> },
		) => {
			if (name === "do-always") command = def.handler;
		},
		registerShortcut: () => {},
		registerTool: () => {},
	};

	doAlwaysExtension(pi as never);

	process.on("exit", () => {
		if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
		rmSync(dir, { recursive: true, force: true });
	});

	const h: Harness = {
		async emit(event, payload = {}) {
			for (const handler of handlers[event] ?? []) await handler(payload, ctx);
		},
		async messageEnd(message) {
			let current = message;
			for (const handler of handlers["message_end"] ?? []) {
				const res = (await handler({ type: "message_end", message: current }, ctx)) as
					| { message?: Msg }
					| undefined;
				if (res?.message) {
					// The runtime applies a message_end replacement IN PLACE (the
					// transcript and later turns see the replacement), so the
					// caller's message object must reflect it — copy the fields back.
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
		async turn(messages) {
			await h.emit("agent_start");
			for (const m of messages) await h.messageEnd(m);
			await h.emit("agent_end", { messages });
			await h.emit("agent_settled", { aborted: messages.some((m) => m.stopReason === "aborted") });
			await h.settle();
		},
		questionnaireOpened: () => overlayOpened,
		overlayText: () => (overlay?.render ? overlay.render(80).join("\n") : ""),
		async answer(kind) {
			(overlay as (Overlay & { __answer?: (k: string) => void }) | null)?.__answer?.(kind);
			await h.settle();
		},
		sent: () => sent,
		notes: () => notes,
		settle: () => new Promise((r) => setTimeout(r, 20)),
	};
	return h;
}

const FENCE = "```";
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
/** A plain assistant reply (no plan block). */
function textReply(text: string, stopReason = "stop"): Msg {
	return { role: "assistant", content: [{ type: "text", text }], stopReason };
}
const hasFence = (msg: Msg) => String(msg.content[0]?.text ?? "").includes(FENCE + "plan");

const PLAN_TASK = { name: "Flow Plan", category: "Plan", prompt: "Review and propose a plan." };
const PLAIN_TASK = { name: "Flow Build", category: "Do", prompt: "Build it." };

test("completed Plan auto-run offers the questionnaire and strips the fence", async () => {
	const h = harness([PLAN_TASK]);
	await h.start();
	await h.command("flow plan");
	const reply = await h.messageEnd(planReply("A"));
	await h.emit("agent_end", { messages: [reply] });
	await h.emit("agent_settled", { aborted: false });
	await h.settle();
	assert.equal(h.questionnaireOpened(), true, "questionnaire should open");
	assert.equal(hasFence(reply), false, "the plan fence should be stripped from the transcript");
});

test("interrupted Plan auto-run still offers it on the follow-up turn", async () => {
	// The failure mode this guards: the auto-run is aborted (Esc, or a provider
	// error) before it answers, the user types "continue", and THAT reply
	// carries the plan block. While the follow-up was untracked the block was
	// neither captured nor stripped — no questionnaire, raw JSON on screen.
	const h = harness([PLAN_TASK]);
	await h.start();
	await h.command("flow plan");
	await h.turn([textReply("interrupted", "aborted")]);
	assert.equal(h.questionnaireOpened(), false, "the aborted run has nothing to offer");
	assert.ok(h.notes().some((n) => n.includes("Flow Plan")), "the abort is reported");

	const reply = planReply("after-continue");
	await h.turn([reply]);
	assert.equal(h.questionnaireOpened(), true, "the follow-up turn's plan block opens the questionnaire");
	assert.equal(hasFence(reply), false, "and its fence is stripped from the transcript");
});

test("Plan run aborted AFTER emitting the block still offers it", async () => {
	const h = harness([PLAN_TASK]);
	await h.start();
	await h.command("flow plan");
	const reply = await h.messageEnd(planReply("mid"));
	await h.emit("agent_end", { messages: [textReply("then cut off", "aborted")] });
	await h.emit("agent_settled", { aborted: true });
	await h.settle();
	assert.equal(h.questionnaireOpened(), true, "the captured block is not dropped with the aborted run");
	assert.equal(hasFence(reply), false, "its fence is stripped");
});

test("a completed follow-up with no plan block drops the expectation", async () => {
	// anyPlan off: this test is about the Plan DEBT lapsing, and since 0.24.0 a
	// trailing block in an ordinary turn is captured on its own (see the ad-hoc
	// tests below) — which would open a questionnaire for the wrong reason.
	const h = harness([PLAN_TASK], { anyPlan: false });
	await h.start();
	await h.command("flow plan");
	await h.turn([textReply("interrupted", "aborted")]);
	// The user's next turn is unrelated and finishes without a block: the Plan
	// debt is discharged, so a plan fence two turns later is not hijacked.
	await h.turn([textReply("unrelated answer")]);
	await h.turn([planReply("stray")]);
	assert.equal(h.questionnaireOpened(), false, "a stray fence after the debt lapsed opens nothing");
});

test("an interrupted non-Plan auto-run never captures a later fence", async () => {
	// anyPlan off: a Do task owes no block, and the ad-hoc path (0.24.0) is
	// covered by its own tests below.
	const h = harness([PLAIN_TASK], { anyPlan: false });
	await h.start();
	await h.command("flow build");
	await h.turn([textReply("interrupted", "aborted")]);
	const reply = planReply("stray");
	await h.turn([reply]);
	assert.equal(h.questionnaireOpened(), false, "a Do task owes no plan block");
	assert.equal(hasFence(reply), true, "and its fence is left in the transcript");
});

test("session_start clears a pending Plan follow-up", async () => {
	// anyPlan off: what is asserted here is that the debt does not survive a new
	// session, not the ad-hoc capture of a trailing block.
	const h = harness([PLAN_TASK], { anyPlan: false });
	await h.start();
	await h.command("flow plan");
	await h.turn([textReply("interrupted", "aborted")]);
	await h.start(); // a new session
	await h.turn([planReply("stale")]);
	assert.equal(h.questionnaireOpened(), false, "the previous session's debt does not carry over");
});

test("confirming the questionnaire sends the execution prompt", async () => {
	const h = harness([PLAN_TASK]);
	await h.start();
	await h.command("flow plan");
	await h.turn([planReply("exec")]);
	assert.equal(h.questionnaireOpened(), true);
	await h.answer("confirm");
	assert.ok(
		h.sent().some((s) => s.startsWith("Execute the following action items")),
		"the confirmed selection is sent as an execution follow-up",
	);
});

test("withdrawing the questionnaire sends nothing", async () => {
	const h = harness([PLAN_TASK]);
	await h.start();
	await h.command("flow plan");
	await h.turn([planReply("quit")]);
	await h.answer("withdraw");
	assert.ok(
		!h.sent().some((s) => s.startsWith("Execute the following action items")),
		"a withdrawal sends no execution prompt",
	);
});

test("a plan block with a stray closing brace still opens the questionnaire", async () => {
	// The failure seen in the wild: the agent closed a tier with `}]}},`
	// instead of `}]},`. The block used to be reported as "not valid JSON" —
	// no questionnaire, and the raw JSON left in the transcript.
	const h = harness([PLAN_TASK]);
	await h.start();
	await h.command("flow plan");

	const strayBrace =
		'{"summary":"S","tiers":[' +
		'{"id":"P0","label":"Critical","items":[{"title":"t0","detail":"d0"}]}},' +
		'{"id":"P1","label":"High","items":[{"title":"t1"}]}]}';
	const reply: Msg = {
		role: "assistant",
		content: [{ type: "text", text: "Review done.\n\n" + FENCE + "plan\n" + strayBrace + "\n" + FENCE + "\n" }],
		stopReason: "stop",
	};

	await h.turn([reply]);
	assert.equal(h.questionnaireOpened(), true, "the repaired block must open the questionnaire");
	assert.equal(hasFence(reply), false, "and its fence is stripped from the transcript");
	assert.ok(
		!h.notes().some((n) => n.includes("not valid JSON")),
		"no malformed-JSON warning for a repairable block",
	);

	await h.answer("confirm");
	assert.ok(
		h.sent().some((s) => s.includes("t1")),
		"the tier AFTER the stray brace is still selectable and sent",
	);
});

// ── Ad-hoc plan capture (anyPlan, 0.24.0) ────────────────────────────────────
//
// Models imitate the plan-block instruction that is still visible in the
// conversation context, so an ORDINARY turn can end with a real proposal nobody
// asked for. Such a reply is captured like an auto-run's block (raw text kept
// for the parser, fence stripped per hidePlan) and offered as "Ad-hoc plan".

test("an ordinary turn ending with a plan block is offered as an ad-hoc proposal", async () => {
	const h = harness([PLAIN_TASK]); // no Plan task ever runs here
	await h.start();
	const reply = planReply("adhoc");
	await h.turn([reply]);
	assert.equal(h.questionnaireOpened(), true, "a trailing block is actionable");
	assert.ok(h.overlayText().includes("Ad-hoc plan"), "and it is offered under the ad-hoc name");
	assert.equal(hasFence(reply), false, "the fence is stripped from the transcript");
	await h.answer("confirm");
	assert.ok(h.sent().some((s) => s.startsWith("Execute the following action items")), "confirming sends the selection");
});

test("an ad-hoc block is captured even with no task configured at all", async () => {
	const h = harness([]);
	await h.start();
	const reply = planReply("no-tasks");
	await h.turn([reply]);
	assert.equal(h.questionnaireOpened(), true);
	assert.ok(h.overlayText().includes("Ad-hoc plan"));
});

test("a plan fence quoted mid-reply is left alone", async () => {
	const h = harness([PLAIN_TASK]);
	await h.start();
	// The block is followed by prose: it is content (documentation, an example),
	// not a proposal the user is being handed.
	const quoted = (planReply("quoted").content[0]?.text ?? "") + "\nUse that shape in your own prompt.";
	const reply = textReply(quoted);
	await h.turn([reply]);
	assert.equal(h.questionnaireOpened(), false, "only a TRAILING block is captured");
	assert.equal(hasFence(reply), true, "and the fence stays in the transcript");
});

test("an unclosed trailing plan fence is captured too", async () => {
	const h = harness([PLAIN_TASK]);
	await h.start();
	// The failure mode the lenient parser already recovers: the reply ends
	// inside the fence (truncated output, trailing tool tags).
	const reply = textReply(
		"Here is what I would do.\n\n```plan\n" +
			'{"summary":"T","tiers":[{"id":"P1","label":"High","items":[{"title":"t1","detail":"d1"}]}]}',
	);
	await h.turn([reply]);
	assert.equal(h.questionnaireOpened(), true, "the trailing unclosed block is still a proposal");
	assert.ok(h.overlayText().includes("t1"), "and its items are selectable");
});

test("anyPlan: false restricts proposals to Plan tasks", async () => {
	const h = harness([PLAIN_TASK], { anyPlan: false });
	await h.start();
	const reply = planReply("adhoc-off");
	await h.turn([reply]);
	assert.equal(h.questionnaireOpened(), false, "an ordinary turn is never captured");
	assert.equal(hasFence(reply), true, "and its fence is not stripped");
});

test("the global questionnaire switch also disables the ad-hoc capture", async () => {
	const h = harness([PLAIN_TASK], { questionnaire: false });
	await h.start();
	const reply = planReply("adhoc-noq");
	await h.turn([reply]);
	assert.equal(h.questionnaireOpened(), false);
	assert.equal(hasFence(reply), true);
});

test("a Plan auto-run's own block is never offered twice as ad-hoc", async () => {
	const h = harness([PLAN_TASK]);
	await h.start();
	await h.command("flow plan");
	const reply = planReply("once");
	await h.turn([reply]);
	assert.equal(h.questionnaireOpened(), true);
	assert.ok(h.overlayText().includes("Flow Plan"), "offered under the task's name, not as Ad-hoc plan");
});

test("a tracked auto-run's reply is never captured as ad-hoc", async () => {
	// The reply belongs to the armed run: agent_end serves that run's summary
	// first and never reaches the ad-hoc branch, so capturing here would strip
	// a block that is then dropped — the proposal would vanish from the
	// transcript without ever being offered. Non-Plan auto-runs hit this too
	// (anyPlan), not just tasks switched out of plan mode with ctrl+p.
	const h = harness([{ ...PLAIN_TASK, autoRun: true }]);
	await h.start();
	await h.command("flow build");
	assert.equal(h.sent().length, 1, "the auto-run was sent");
	const reply = planReply("auto-run-tail");
	await h.turn([reply]);
	assert.equal(h.questionnaireOpened(), false, "no ad-hoc questionnaire for a tracked run");
	assert.equal(hasFence(reply), true, "and its fence stays in the transcript");
	assert.ok(h.notes().some((n) => n.includes("Flow Build")), "the run's own summary is posted");
});
