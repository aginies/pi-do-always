// Saved chains: the config's `chains` object maps a name to a list of task
// names, so a pipeline that used to be rebuilt by hand in the selector's ORDER
// column (and died on Esc) can be run with one command — including in non-TUI
// modes, where there is no selector to build it in.
//
// Covers the pure config/listing logic and the run itself, which goes through
// the same runner as the selector's chain row (guards, one chain at a time,
// per-step turns).
import { test } from "node:test";
import assert from "node:assert/strict";
import {
	CHAIN_MAX,
	findTaskByName,
	formatNamedChains,
	mergeNamedChains,
	parseConfig,
	resolveNamedChain,
	resolveTask,
	type DoAlwaysTask,
} from "../tasks";
import { harness, lastNote, textReply } from "./harness";

const BUILD: DoAlwaysTask = { name: "Build", category: "Do", prompt: "Build it.", mode: "run" };
const TEST: DoAlwaysTask = { name: "Tests", category: "Do", prompt: "Run tests.", mode: "run" };
const COMMIT: DoAlwaysTask = { name: "Commit", category: "Ops", prompt: "Commit.", mode: "run" };
const TASKS = [BUILD, TEST, COMMIT];

const parse = (raw: unknown, warns: string[] = []) =>
	parseConfig(JSON.stringify(raw), "test.json", (m) => warns.push(m));

// ── Config parsing ───────────────────────────────────────────────────────────

test("parseConfig reads the chains object", () => {
	const warns: string[] = [];
	const out = parse({ tasks: [{ name: "Build", prompt: "b" }], chains: { ship: ["Build", "Tests"] } }, warns);
	assert.deepEqual(out.chains, { ship: ["Build", "Tests"] });
	assert.equal(warns.length, 0);
});

test("parseConfig trims chain names and steps", () => {
	const out = parse({ tasks: [], chains: { "  ship ": ["  Build ", " Tests"] } });
	assert.deepEqual(out.chains, { ship: ["Build", "Tests"] });
});

test("parseConfig drops a repeated step instead of looping", () => {
	const out = parse({ tasks: [], chains: { ship: ["Build", "Tests", "Build"] } });
	assert.deepEqual(out.chains, { ship: ["Build", "Tests"] }, "first occurrence wins, in order");
});

test("parseConfig refuses a chain longer than CHAIN_MAX", () => {
	const warns: string[] = [];
	const steps = Array.from({ length: CHAIN_MAX + 1 }, (_, i) => `T${i}`);
	const out = parse({ tasks: [], chains: { big: steps, ok: ["Build"] } }, warns);
	assert.deepEqual(out.chains, { ok: ["Build"] }, "the oversized chain is dropped, the rest survive");
	assert.ok(warns.some((w) => w.includes('"big"') && w.includes(String(CHAIN_MAX))), warns.join("|"));
});

test("parseConfig warns on and ignores malformed chains", () => {
	const cases: Record<string, unknown>[] = [
		{ chains: ["Build"] }, // not an object
		{ chains: { ship: "Build" } }, // not an array
		{ chains: { ship: [] } }, // empty
		{ chains: { ship: ["Build", 3] } }, // non-string step
		{ chains: { ship: ["Build", "  "] } }, // blank step
	];
	for (const cfg of cases) {
		const warns: string[] = [];
		const out = parse({ tasks: [], ...cfg }, warns);
		assert.equal(out.chains, undefined, `${JSON.stringify(cfg)} is rejected`);
		assert.equal(warns.length, 1, `${JSON.stringify(cfg)} warns once: ${warns.join("|")}`);
	}
});

test("parseConfig leaves chains undefined when the file sets none", () => {
	assert.equal(parse({ tasks: [] }).chains, undefined);
	assert.equal(parse([{ name: "x", prompt: "p" }]).chains, undefined, "the array form has no chains");
});

test("mergeNamedChains lets the project file win by name", () => {
	const merged = mergeNamedChains({ ship: ["A"], global: ["G"] }, { ship: ["B"], project: ["P"] });
	assert.deepEqual(merged, { ship: ["B"], global: ["G"], project: ["P"] });
	assert.deepEqual(mergeNamedChains(undefined, undefined), {});
	assert.deepEqual(mergeNamedChains(undefined, { a: ["x"] }), { a: ["x"] });
});

test("resolveNamedChain matches case-insensitively and keeps the configured spelling", () => {
	const chains = { Ship: ["Build", "Tests"] };
	assert.deepEqual(resolveNamedChain(chains, "ship"), { name: "Ship", steps: ["Build", "Tests"] });
	assert.deepEqual(resolveNamedChain(chains, "  SHIP "), { name: "Ship", steps: ["Build", "Tests"] });
	assert.equal(resolveNamedChain(chains, "nope"), undefined);
	assert.equal(resolveNamedChain(chains, ""), undefined);
});

test("formatNamedChains numbers the chains and flags unknown steps", () => {
	const out = formatNamedChains({ ship: ["Build", "Deploy"], quick: ["Tests"] }, TASKS, () => "");
	assert.equal(out, ["1. ship — Build → Deploy (unknown task)", "2. quick — Tests"].join("\n"));
	// The marker callback is how index.ts passes the run-mode glyphs.
	assert.equal(
		formatNamedChains({ ship: ["Build"] }, TASKS, () => "▶"),
		"1. ship — ▶Build",
	);
	assert.equal(formatNamedChains({}, TASKS), "");
});

test("findTaskByName resolves names and aliases but never a row number", () => {
	assert.equal(findTaskByName(TASKS, "build")?.name, "Build");
	assert.equal(findTaskByName(TASKS, "  TESTS ")?.name, "Tests");
	assert.equal(findTaskByName([{ ...BUILD, aliases: ["b"] }], "B")?.name, "Build", "aliases resolve too");
	assert.equal(findTaskByName(TASKS, "1"), undefined, "a positional number is not a name here…");
	assert.equal(resolveTask(TASKS, "1")?.name, "Build", "…though /do-always <n> still takes one");
	assert.equal(findTaskByName(TASKS, ""), undefined);
});

// ── /do-always chain ─────────────────────────────────────────────────────────

const CHAIN_TASKS = [
	{ name: "Build", category: "Do", prompt: "Build it.", mode: "run" },
	{ name: "Tests", category: "Do", prompt: "Run tests.", mode: "run" },
];
const CHAIN_CFG = { chains: { ship: ["Build", "Tests"], bad: ["Build", "Deploy"] }, report: false };

test("/do-always chain lists the saved chains", async () => {
	const h = harness(CHAIN_TASKS, CHAIN_CFG);
	await h.start();
	await h.command("chain");
	const note = lastNote(h);
	assert.ok(note.includes("1. ship — ▶Build → ▶Tests"), note);
	assert.ok(note.includes("/do-always chain <name>"), "and says how to run one");
});

test("/do-always chain says so when nothing is configured", async () => {
	const h = harness(CHAIN_TASKS, { report: false });
	await h.start();
	await h.command("chain");
	assert.ok(lastNote(h).includes("no saved chains"), lastNote(h));
	await h.command("chain ship");
	assert.ok(lastNote(h).includes('unknown chain "ship"'), lastNote(h));
});

test("/do-always chain <name> runs the steps in order, one turn each", async () => {
	const h = harness(CHAIN_TASKS, CHAIN_CFG);
	await h.start();
	const started = h.open("chain ship");
	await h.settle();
	assert.deepEqual(h.sent(), ["Build it."], "step 1 is sent");
	await h.turn([textReply("built")]);
	await h.settle();
	assert.deepEqual(h.sent(), ["Build it.", "Run tests."], "step 2 follows once step 1 settled");
	await h.turn([textReply("tested")]);
	await started;
	assert.ok(
		h.notes().some((n) => n.includes("step 1/2")) && h.notes().some((n) => n.includes("step 2/2")),
		"both steps are reported",
	);
	assert.equal(h.sent().length, 2, "and nothing else was sent");
});

test("a chain name is matched case-insensitively", async () => {
	const h = harness(CHAIN_TASKS, CHAIN_CFG);
	await h.start();
	const started = h.open("chain SHIP");
	await h.settle();
	assert.deepEqual(h.sent(), ["Build it."]);
	await h.turn([textReply("built")]);
	await h.settle();
	await h.turn([textReply("tested")]);
	await started;
	assert.equal(h.sent().length, 2);
});

test("a chain with an unknown task is refused, naming it", async () => {
	const h = harness(CHAIN_TASKS, CHAIN_CFG);
	await h.start();
	await h.command("chain bad");
	assert.ok(lastNote(h).includes('chain "bad" refers to unknown task'), lastNote(h));
	assert.ok(lastNote(h).includes("Deploy"), "…and the offending step");
	assert.equal(h.sent().length, 0, "nothing is sent — the runner would have dropped the step silently");
});

test("a chain step can be named by alias", async () => {
	const h = harness(
		[
			{ ...CHAIN_TASKS[0], aliases: ["b"] },
			CHAIN_TASKS[1],
		],
		{ chains: { ship: ["b", "Tests"] }, report: false },
	);
	await h.start();
	const started = h.open("chain ship");
	await h.settle();
	assert.deepEqual(h.sent(), ["Build it."], "the alias resolved to the task");
	await h.turn([textReply("built")]);
	await h.settle();
	await h.turn([textReply("tested")]);
	await started;
	assert.equal(h.sent().length, 2);
});

test("a blocked step stops the chain before anything is sent", async () => {
	const h = harness(
		[
			{ name: "Review", category: "Plan", prompt: "Review.", requireDirty: true, mode: "run" },
			CHAIN_TASKS[1],
		],
		{ chains: { guarded: ["Review", "Tests"] }, report: false },
	);
	await h.start();
	await h.command("chain guarded");
	assert.ok(lastNote(h).includes("chain blocked at step 1"), lastNote(h));
	assert.equal(h.sent().length, 0, "fail fast: nothing was sent");
});

test("a fill-mode step 1 waits in the editor instead of being sent", async () => {
	const h = harness(
		[
			{ name: "Build", category: "Do", prompt: "Build it.", mode: "fill" },
			{ name: "Tests", category: "Do", prompt: "Run tests.", mode: "run" },
		],
		{ chains: { ship: ["Build", "Tests"] }, report: false },
	);
	await h.start();
	const started = h.open("chain ship");
	await h.settle();
	assert.equal(h.sent().length, 0);
	assert.deepEqual(h.editor(), ["Build it."], "step 1 is filled for review");
	// The user's Enter on step 1: the run settles and the chain continues.
	await h.turn([textReply("built")]);
	await h.settle();
	assert.deepEqual(h.sent(), ["Run tests."], "step 2 was sent after step 1 finished");
	await h.turn([textReply("tested")]);
	await started;
});

test("a second chain is refused while one is running", async () => {
	const h = harness(CHAIN_TASKS, CHAIN_CFG);
	await h.start();
	const started = h.open("chain ship");
	await h.settle();
	await h.command("chain ship");
	assert.ok(lastNote(h).includes("a chain is already running"), lastNote(h));
	await h.turn([textReply("built")]);
	await h.settle();
	await h.turn([textReply("tested")]);
	await started;
	assert.equal(h.sent().length, 2, "only the first chain ran");
});
