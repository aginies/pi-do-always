// Simulate the pi runtime driving the do-always extension through a
// single auto-run Plan task, to see whether the questionnaire is offered.
import doAlwaysExtension from "../extensions/pi-do-always/index.ts";

type Handler = (event: any, ctx?: any) => any;

const handlers: Record<string, Handler[]> = {};
const notifications: { msg: string; type?: string }[] = [];
let customShown = false;
let customResult: any = null; // resolved when the "user" answers
let customResolver: ((r: any) => void) | null = null;
let sentMessages: { text: string; opts: any }[] = [];
let replacedMessages: any[] = [];
let doAlwaysHandler: ((args: string, ctx: any) => Promise<void>) | null = null;

const ctx: any = {
	mode: "tui",
	ui: {
		notify: (msg: string, type?: string) => {
			notifications.push({ msg, type });
		},
		custom: <T,>(_render: any, done: (r: T) => void): void => {
			customShown = true;
			customResolver = (r: any) => {
				customResult = r;
				done(r);
			};
		},
		select: async () => undefined,
		confirm: async () => false,
		input: async () => undefined,
		setWidget: () => {},
		setEditorText: () => {},
		getEditorText: () => "",
		setStatus: () => {},
	},
	cwd: process.cwd(),
};

const pi = {
	on: (event: string, handler: Handler) => {
		(handlers[event] ??= []).push(handler);
	},
	off: () => {},
	sendUserMessage: (text: string, opts: any) => {
		sentMessages.push({ text, opts });
	},
	registerCommand: (name: string, def: any) => {
		if (name === "do-always") doAlwaysHandler = def.handler;
	},
	registerShortcut: () => {},
	registerTool: () => {},
};

// Boot the extension (session_start gives it the config).
doAlwaysExtension(pi as any);

async function emit(event: string, payload: any = {}) {
	for (const h of handlers[event] ?? []) {
		return await h(payload, ctx);
	}
	return undefined;
}

// Simulate the runtime: message_end handlers may return a replacement,
// which is applied in place (mutating the message object).
async function emitMessageEnd(message: any) {
	let current = message;
	for (const h of handlers["message_end"] ?? []) {
		const res = await h({ type: "message_end", message: current }, ctx);
		if (res?.message) {
			replacedMessages.push(current);
			// in-place replacement like the real runtime
			for (const k of Object.keys(current)) delete current[k];
			Object.assign(current, res.message);
		}
	}
	return current;
}

function assistantMsg(text: string) {
	return { role: "assistant", content: [{ type: "text", text }], stopReason: "stop" };
}

const PLAN_OK =
	"Review finished. Two issues found.\n\n" +
	"```plan\n" +
	'{"summary":"Fix two issues","tiers":[{"id":"P0","label":"Critical","items":[{"title":"Fix race","detail":"src/a.ts:1"}]},{"id":"P1","label":"Important","items":[{"title":"Add null check","detail":"src/b.ts:2"}]}]}\n' +
	"```\n";

const PLAN_TRUNCATED =
	"Review finished. The plan:\n\n" +
	"```plan\n" +
	'{"summary":"Fix 2 test failures","tiers":[{"id":"P0","label":"Critical","items":[{"title":"Fix stale test","detail":"test.py:619"}]},{"id":"P1","label":"High","items":[{"title":"Remove unused class","detail":"core.py:290-300"}]}\n' +
	"</parameter>\n" +
	"</function>\n" +
	"</tool_call>";

async function scenario(name: string, finalText: string, stopReason = "stop") {
	notifications.length = 0;
	customShown = false;
	customResult = null;
	replacedMessages.length = 0;
	sentMessages.length = 0;

	// Fresh session
	await emit("session_start", { reason: "new" });

	// User picks a Plan task → the extension auto-runs it.
	if (!doAlwaysHandler) throw new Error("do-always command not registered");
	await doAlwaysHandler("review code", ctx);

	// The auto-run was sent as a follow-up; the runtime starts a run.
	await emit("agent_start", {});

	// Intermediate assistant message (tool-call turn, no plan fence)
	await emitMessageEnd(assistantMsg("Let me inspect the files..."));

	// Final assistant message with the plan
	const finalMsg = assistantMsg(finalText);
	finalMsg.stopReason = stopReason;
	const finalAfter = await emitMessageEnd(finalMsg);

	await emit("agent_end", { messages: [assistantMsg("Let me inspect the files..."), finalMsg] });
	await emit("agent_settled", {});

	// Let any pending promises settle
	await new Promise((r) => setTimeout(r, 50));

	console.log(`\n=== ${name} ===`);
	console.log("message replaced (stripped):", replacedMessages.length > 0);
	console.log("final message still contains plan fence:", finalAfter.text ?? (finalAfter.content?.[0] as any)?.text?.includes("```plan"));
	console.log("questionnaire shown (ui.custom):", customShown);
	console.log("notifications:");
	for (const n of notifications) console.log(`  [${n.type ?? "info"}] ${n.msg.split("\n")[0].slice(0, 120)}`);
}

// The extension registers commands via pi.on("command")? Let's check what
// registration API it uses first.
console.log("registered events:", Object.keys(handlers));

await scenario("well-formed closed plan (stop)", PLAN_OK, "stop");
await scenario("truncated plan, length stop", PLAN_TRUNCATED, "length");

// The real-world failure (2026-10-09 mocap session): the model writes the
// plan as plain markdown and never emits the required ```plan fence.
const PLAN_NO_FENCE =
	"I've completed a full re-verification of the working tree. Here is the consolidated review.\n\n" +
	"## Executive summary\n\nThe project is well-structured; the main problems are a handful of real\n" +
	"correctness bugs and a stale README.\n\n" +
	"## Fix plan (phased)\n\n" +
	"**Phase 1 — P0 correctness:** fix `mocap_analysis.py` fps read + unit conversion.\n\n" +
	"**Phase 2 — P1 architecture:** make `mocap_core` the single source for quaternion math.\n\n" +
	"**Phase 3 — P2 cleanup:** rewrite the stale README sections.\n";

const NUDGE_REPLY =
	"Here is the plan block based on my findings above:\n\n" +
	"```plan\n" +
	'{"summary":"Fix P0 correctness bugs, consolidate core, refresh README","tiers":[{"id":"P0","label":"Critical","items":[{"title":"Fix fps read in load_recording","detail":"mocap_analysis.py — reads data.fps but export writes metadata.fps"}]},{"id":"P1","label":"Important","items":[{"title":"Make mocap_core the single source for quaternion math","detail":"mocap_core.py / mocap_web_server.py duplication"}]}]}\n' +
	"```\n";

/**
 * Run a Plan task whose final reply has no usable plan block, then simulate
 * the nudge run the extension should start (and its reply).
 */
async function nudgeScenario(name: string, nudgeReply: string, stopReason = "stop") {
	notifications.length = 0;
	customShown = false;
	customResult = null;
	replacedMessages.length = 0;
	sentMessages.length = 0;

	await emit("session_start", { reason: "new" });
	if (!doAlwaysHandler) throw new Error("do-always command not registered");
	await doAlwaysHandler("review code", ctx);

	// Original run.
	await emit("agent_start", {});
	await emitMessageEnd(assistantMsg("Let me inspect the files..."));
	const finalMsg = assistantMsg(PLAN_NO_FENCE);
	finalMsg.stopReason = stopReason;
	await emitMessageEnd(finalMsg);
	await emit("agent_end", { messages: [assistantMsg("Let me inspect the files..."), finalMsg] });
	await emit("agent_settled", {});
	await new Promise((r) => setTimeout(r, 50));

	const nudged = sentMessages.length >= 2 && sentMessages[1].text.includes("plan block");
	console.log(`\n=== ${name} ===`);
	console.log("nudge follow-up sent:", nudged);
	if (!nudged) {
		console.log("notifications:");
		for (const n of notifications) console.log(`  [${n.type ?? "info"}] ${n.msg.split("\n")[0].slice(0, 140)}`);
		return;
	}

	// Nudge run: the runtime starts a new run for the follow-up.
	await emit("agent_start", {});
	const nudgeMsg = assistantMsg(nudgeReply);
	await emitMessageEnd(nudgeMsg);
	await emit("agent_end", { messages: [nudgeMsg] });
	await emit("agent_settled", {});
	await new Promise((r) => setTimeout(r, 50));

	console.log("questionnaire shown after nudge (ui.custom):", customShown);
	console.log("second nudge sent (must be false):", sentMessages.length >= 3);
	console.log("notifications:");
	for (const n of notifications) console.log(`  [${n.type ?? "info"}] ${n.msg.split("\n")[0].slice(0, 140)}`);
}

await nudgeScenario("no plan block → nudge → block emitted → questionnaire", NUDGE_REPLY);
await nudgeScenario("no plan block → nudge → still no block → warning, no loop", "Still no block, sorry.");

// Print mode is one-shot: no nudge follow-up, plain warning instead.
ctx.mode = "print";
await nudgeScenario("print mode: no plan block → no nudge, warning only", NUDGE_REPLY);
