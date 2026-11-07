// Shared stub-pi harness for the extension's runtime tests: boots the real
// extension against a fake `pi`, records what it sends / fills / notifies, and
// hands back the components it gives to `ui.custom` so a test can drive the real
// selector, commit browser or questionnaire with real key sequences.
//
// A throwaway agent dir keeps config resolution off the developer's own ~/.pi.
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import doAlwaysExtension from "../index";

// ── Runtime effect (stub pi) ─────────────────────────────────────────────────

/** Minimal message/event shapes for the stub (structural — no pi internals). */
type Part = { type: string; text?: string };
export type Msg = { role: string; content: Part[]; stopReason?: string };
type Handler = (event: Record<string, unknown>, ctx: Record<string, unknown>) => unknown;
/** A component the extension handed to ui.custom (selector, questionnaire, ...). */
export type Component = {
	render?: (width: number) => string[];
	handleInput?: (data: string) => void;
	invalidate?: () => void;
};

export interface Harness {
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

export const FENCE = "```";

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
export function harness(tasks: unknown[], extra: Record<string, unknown> = {}): Harness {
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
export function planReply(marker: string): Msg {
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
export const hasFence = (msg: Msg) => String(msg.content[0]?.text ?? "").includes(FENCE + "plan");
export const lastNote = (h: Harness) => h.notes().at(-1) ?? "";

/** A plain assistant reply (no plan block). */
export function textReply(text: string, stopReason = "stop"): Msg {
	return { role: "assistant", content: [{ type: "text", text }], stopReason };
}
