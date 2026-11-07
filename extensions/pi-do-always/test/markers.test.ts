// The marker palette: `markers: "unicode"` (default) or `"ascii"` for terminals
// and fonts that lack — or double-width — the glyphs the UI draws its state
// with. The palette covers markers, status glyphs, rules and footer key hints
// (the things that carry a column-width assumption); prose punctuation in
// notifications and reports is out of scope.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { visibleWidth } from "@earendil-works/pi-tui";
import {
	ASCII_MARKERS,
	MARKER_SETS,
	UNICODE_MARKERS,
	formatChainSequence,
	formatNamedChains,
	formatRunModes,
	isMarkerSet,
	markersFor,
	parseConfig,
	runModeGlyph,
	runModeMarker,
	runModeShort,
	stepSummary,
	chainSummary,
	chainAdd,
	chainClear,
	type DoAlwaysTask,
	type Markers,
} from "../tasks";
import { harness, lastNote } from "./harness";

const PLAN_TASK: DoAlwaysTask = { name: "Review", category: "Plan", prompt: "Review it.", mode: "plan" };
const DO_TASK: DoAlwaysTask = { name: "Build", category: "Do", prompt: "Build it.", mode: "run" };
const TASKS = [PLAN_TASK, DO_TASK];

const isAscii = (s: string) => /^[\x09\x0a\x20-\x7e]*$/.test(s);

// ── The palettes themselves ──────────────────────────────────────────────────

test("markersFor resolves the configured set, defaulting to unicode", () => {
	assert.equal(markersFor(undefined), UNICODE_MARKERS);
	assert.equal(markersFor("unicode"), UNICODE_MARKERS);
	assert.equal(markersFor("ascii"), ASCII_MARKERS);
});

test("isMarkerSet accepts only the two configured values", () => {
	for (const ok of MARKER_SETS) assert.equal(isMarkerSet(ok), true, ok);
	for (const bad of ["ASCII", "plain", "", "text", null, undefined, 1]) assert.equal(isMarkerSet(bad), false, String(bad));
});

test("the ascii palette is 7-bit and covers exactly the same fields", () => {
	const unicodeKeys = Object.keys(UNICODE_MARKERS).sort();
	const asciiKeys = Object.keys(ASCII_MARKERS).sort();
	assert.deepEqual(asciiKeys, unicodeKeys, "a field missing from one palette would render as undefined");
	assert.equal(UNICODE_MARKERS.summaryDone, "✅", "the completion summary keeps its emoji by default");
	for (const [key, value] of Object.entries(ASCII_MARKERS)) {
		assert.ok(isAscii(value), `${key} is not ASCII: ${JSON.stringify(value)}`);
	}
	assert.ok(
		Object.values(UNICODE_MARKERS).some((v) => !isAscii(v)),
		"the unicode palette really does use non-ASCII glyphs (otherwise the option is pointless)",
	);
});

test("both palettes keep the marker cell 3 columns wide", () => {
	// The selector reserves 3 columns for a marked row, so a palette whose cell
	// is a different width would misalign the whole table (and the ORDER cell's
	// mouse hit-testing, which is at a fixed x).
	for (const m of [UNICODE_MARKERS, ASCII_MARKERS]) {
		assert.equal(visibleWidth(m.planCell), 3, "plan cell");
		assert.equal(visibleWidth(m.runCell), 3, "run cell");
		assert.equal(runModeMarker("plan", m), m.planCell);
		assert.equal(runModeMarker("run", m), m.runCell);
		assert.equal(runModeMarker("fill", m), "", "a fill row reserves no column");
		assert.equal(visibleWidth(m.cursor), 1, "the cursor is one column (it is padded by the row template)");
		assert.equal(visibleWidth(m.orderEmpty), 1);
		assert.equal(visibleWidth(m.commitSelected), 1);
		for (const k of ["stepDone", "stepRunning", "stepPending", "stepError", "stepAborted", "stepSkipped"] as const) {
			assert.equal(visibleWidth(m[k]), 1, `${k} is one column in the chain widget`);
		}
		for (const k of ["tierNone", "tierSome", "tierAll", "itemOn", "itemOff"] as const) {
			assert.equal(visibleWidth(m[k]), 1, `${k} is one column in the questionnaire`);
		}
	}
});

test("the mode helpers draw with the palette they are given", () => {
	assert.equal(runModeGlyph("plan", ASCII_MARKERS), "*");
	assert.equal(runModeGlyph("run", ASCII_MARKERS), ">");
	assert.equal(runModeGlyph("fill", ASCII_MARKERS), "");
	assert.equal(runModeShort("plan", ASCII_MARKERS), "* plan");
	assert.equal(runModeShort("run", ASCII_MARKERS), "> run");
	assert.equal(runModeShort("fill", ASCII_MARKERS), "fill", "ascii has no fill glyph, so no dangling space");
	assert.equal(runModeShort("fill"), "✎ fill", "unicode keeps it");
	// Defaults stay unicode, so every existing call site is unaffected.
	assert.equal(runModeGlyph("plan"), "⚡");
	assert.equal(runModeShort("run"), "▶ run");
});

test("listings and summaries draw with the palette they are given", () => {
	const chain = chainAdd(chainAdd(chainClear(), "Review").state, "Build").state;
	assert.equal(
		formatChainSequence(TASKS, chain, (t) => runModeGlyph("plan", ASCII_MARKERS), ASCII_MARKERS),
		"1.*Review -> 2.*Build",
	);
	assert.equal(
		formatNamedChains({ ship: ["Review", "Deploy"] }, TASKS, () => "", ASCII_MARKERS),
		"1. ship — Review -> Deploy (unknown task)",
		"the arrow follows the palette; the dash is prose and stays",
	);
	assert.equal(
		formatRunModes(TASKS, (t) => (t.mode as "plan") ?? "run", () => "default", ASCII_MARKERS),
		["PLAN", "1. * Review — plan", "DO", "2. > Build — run"].join("\n"),
	);
	assert.ok(stepSummary("completed", "Build", 0, 0, ASCII_MARKERS).startsWith("x "), "completed marker");
	assert.ok(stepSummary("error", "Build", 0, 0, ASCII_MARKERS).startsWith("! "), "error marker");
	assert.ok(chainSummary(2, 2, 0, ASCII_MARKERS).startsWith("ok: 2/2"), "chain summary marker");
	assert.ok(stepSummary("completed", "Build", 0, 0).startsWith("✓ "), "…and unicode by default");
});

// ── Config ───────────────────────────────────────────────────────────────────

test("parseConfig reads and validates the markers key", () => {
	const warns: string[] = [];
	const parse = (raw: unknown) => parseConfig(JSON.stringify(raw), "test.json", (m) => warns.push(m));
	assert.equal(parse({ tasks: [], markers: "ascii" }).markers, "ascii");
	assert.equal(parse({ tasks: [], markers: "unicode" }).markers, "unicode");
	assert.equal(parse({ tasks: [] }).markers, undefined, "absent when the file does not set one");
	assert.equal(parse([{ name: "x", prompt: "p" }]).markers, undefined, "the array form has no settings");

	assert.equal(parse({ tasks: [], markers: "ASCII" }).markers, undefined, "the value is case-sensitive");
	assert.equal(warns.length, 1);
	assert.ok(warns[0].includes('"markers"') && warns[0].includes("unicode, ascii"), warns[0]);
});

// ── Rendered UI ──────────────────────────────────────────────────────────────

test("markers: ascii renders the whole selector in 7-bit", async () => {
	const h = harness([PLAN_TASK, DO_TASK], { markers: "ascii" });
	await h.start();
	const opened = h.open();
	await h.waitForComponents(1);
	const out = h.render(80);
	assert.ok(isAscii(out), `the selector must be pure ASCII:\n${out.replace(/[^\x20-\x7e\n]/g, "?")}`);
	// The marker cell is padded to 3 columns in both palettes, so assert on the
	// cell the palette defines rather than on a single space.
	assert.ok(out.includes(`${ASCII_MARKERS.planCell}Review`), "the plan row carries the ascii plan marker");
	assert.ok(out.includes(`${ASCII_MARKERS.runCell}Build`), "the run row carries the ascii run marker");
	assert.ok(out.includes("ctrl+p * plan"), "and the footer names the mode with it");
	assert.ok(out.includes("Enter select") && out.includes("right order") && out.includes("BS undo"), "key hints are words");
	assert.ok(out.includes("|"), "the hint separator is a pipe");
	h.drive(["\x1b"]);
	await opened;
});

test("the unicode default renders the same selector with glyphs", async () => {
	const h = harness([PLAN_TASK, DO_TASK]);
	await h.start();
	const opened = h.open();
	await h.waitForComponents(1);
	const out = h.render(80);
	assert.ok(
		out.includes(`${UNICODE_MARKERS.planCell}Review`) && out.includes(`${UNICODE_MARKERS.runCell}Build`),
		"unicode markers",
	);
	assert.ok(out.includes("ctrl+p ⚡ plan") && out.includes("⏎ select") && out.includes("→ order"), "unicode hints");
	assert.ok(out.includes("►"), "the cursor marker");
	h.drive(["\x1b"]);
	await opened;
});

test("ascii mode keeps the footer within the width at every size", async () => {
	// The ascii hints are words, so they are longer than the glyphs they replace:
	// the priority-fit footer must still drop segments rather than overflow.
	const h = harness([PLAN_TASK, DO_TASK], { markers: "ascii" });
	await h.start();
	const opened = h.open();
	await h.waitForComponents(1);
	for (const width of [120, 100, 80, 76, 70, 58, 46, 40, 30]) {
		const footer = (h.render(width).split("\n").at(-1) ?? "").replace(/\s+$/, "");
		assert.ok(visibleWidth(footer) <= width - 2, `width ${width}: "${footer}"`);
		assert.ok(isAscii(footer), `width ${width} is ascii: "${footer}"`);
	}
	assert.ok((h.render(120).split("\n").at(-1) ?? "").includes("ctrl+p"), "the mode hint survives");
	h.drive(["\x1b"]);
	await opened;
});

test("the listings follow the configured palette", async () => {
	const h = harness([PLAN_TASK, DO_TASK], { markers: "ascii", chains: { ship: ["Review", "Build"] } });
	await h.start();
	await h.command("mode");
	const modes = lastNote(h);
	assert.ok(modes.includes("1. * Review — plan"), modes);
	assert.ok(modes.includes("2. > Build — run"), modes);
	await h.command("chain");
	const chains = lastNote(h);
	assert.ok(chains.includes("*Review -> >Build"), chains);
});

test("a project file's markers value wins over the global one", async () => {
	// The harness dir is both the agent dir (global config) and the project cwd,
	// so the project file goes in <dir>/.pi/do-always.json; session_start reloads.
	const h = harness([PLAN_TASK], { markers: "unicode" });
	await h.start();
	const first = h.open();
	await h.waitForComponents(1);
	assert.ok(h.render(80).includes(`${UNICODE_MARKERS.planCell}Review`), "the global setting applies first");
	h.drive(["\x1b"]);
	await first;

	mkdirSync(join(h.dir(), ".pi"), { recursive: true });
	// A project config needs its (possibly empty) `tasks` array: parseConfig
	// rejects an object without one, settings included.
	writeFileSync(join(h.dir(), ".pi", "do-always.json"), JSON.stringify({ tasks: [], markers: "ascii" }));
	await h.start(); // reload: project wins over global
	const second = h.open();
	await h.waitForComponents(2);
	const out = h.render(80);
	assert.ok(out.includes(`${ASCII_MARKERS.planCell}Review`), `the project file switched the palette:\n${out}`);
	assert.ok(isAscii(out));
	h.drive(["\x1b"]);
	await second;
});
