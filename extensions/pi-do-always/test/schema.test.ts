// The shipped JSON Schema must describe what parseConfig actually reads.
//
// There is deliberately no schema-validator dependency here: the checks are
// structural (the schema's property sets match the parser's, the shipped sample
// config only uses documented keys, and a config exercising every documented
// field parses without a single warning). That is enough to catch the drift
// that matters — a field added to the parser but missing from the schema, or
// documented in the schema but rejected by the parser.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseConfig } from "../tasks";

const extensionDir = join(dirname(fileURLToPath(import.meta.url)), "..");
const read = (name: string) => JSON.parse(readFileSync(join(extensionDir, name), "utf8")) as Record<string, any>;
const schema = read("do-always.schema.json");
const sample = read("do-always.json");

/** The task fields parseConfig reads — keep in step with its task loop. */
const PARSED_TASK_FIELDS = [
	"name",
	"prompt",
	"description",
	"category",
	"aliases",
	"mode",
	"autoRun",
	"questionnaire",
	"hidePlan",
	"browser",
	"hidden",
	"notForCommits",
	"requireDirty",
	"guards",
	"when",
];

/** The object-form keys parseConfig reads, plus the editor-only `$schema`. */
const PARSED_CONFIG_KEYS = [
	"tasks",
	"shortcut",
	"merge",
	"report",
	"questionnaire",
	"hidePlan",
	"planNudge",
	"anyPlan",
	"markers",
	"aliases",
	"chains",
	"$schema",
];

const taskProps = Object.keys(schema.$defs.task.properties);
const configProps = Object.keys(schema.$defs.configObject.properties);

test("the schema is a 2020-12 document with the two config forms", () => {
	assert.equal(schema.$schema, "https://json-schema.org/draft/2020-12/schema");
	assert.ok(schema.$id, "it carries an $id so editors can resolve $refs");
	assert.deepEqual(schema.oneOf, [{ $ref: "#/$defs/taskList" }, { $ref: "#/$defs/configObject" }]);
	assert.deepEqual(schema.$defs.configObject.required, ["tasks"], "the object form needs `tasks`");
	assert.equal(schema.$defs.task.additionalProperties, false, "a task typo is caught, not ignored");
	assert.equal(schema.$defs.configObject.additionalProperties, false);
});

test("the schema documents exactly the task fields the parser reads", () => {
	assert.deepEqual(
		[...taskProps].sort(),
		[...PARSED_TASK_FIELDS].sort(),
		"schema and parser disagree about the task fields",
	);
	assert.deepEqual(schema.$defs.task.required, ["name", "prompt"]);
});

test("the schema documents exactly the config keys the parser reads", () => {
	assert.deepEqual(
		[...configProps].sort(),
		[...PARSED_CONFIG_KEYS].sort(),
		"schema and parser disagree about the object-form keys",
	);
});

test("the schema's enums match the values the parser accepts", () => {
	assert.deepEqual(schema.$defs.task.properties.mode.enum, ["plan", "run", "fill"]);
	assert.deepEqual(schema.$defs.task.properties.browser.enum, ["commits"]);
	assert.deepEqual(schema.$defs.guard.properties.type.enum, [
		"requireDirty",
		"requireBranch",
		"requireRepo",
		"requireFilePattern",
	]);
	assert.deepEqual(schema.$defs.configObject.properties.merge.enum, ["override", "append"]);
	assert.deepEqual(schema.$defs.configObject.properties.markers.enum, ["unicode", "ascii"]);
	assert.deepEqual(schema.$defs.when.oneOf[0].enum, ["git", "!git"]);
	assert.deepEqual(Object.keys(schema.$defs.when.oneOf[1].properties).sort(), ["branch", "file", "git", "repo"]);
	assert.equal(schema.$defs.chainSteps.maxItems, 8, "the chain cap the parser enforces");
	assert.equal(schema.$defs.chainSteps.minItems, 1);
});

test("the shipped sample config only uses documented keys", () => {
	// The sample is what users copy, so it must be schema-clean.
	const entries = Array.isArray(sample) ? sample : sample.tasks;
	assert.ok(Array.isArray(entries), "the sample is one of the two config forms");
	if (!Array.isArray(sample)) {
		for (const key of Object.keys(sample)) {
			assert.ok(configProps.includes(key), `sample uses an undocumented config key "${key}"`);
		}
	}
	for (const task of entries) {
		for (const key of Object.keys(task)) {
			assert.ok(taskProps.includes(key), `sample task "${task.name}" uses an undocumented key "${key}"`);
		}
		assert.equal(typeof task.name, "string");
		assert.equal(typeof task.prompt, "string");
	}
});

test("a config using every documented field parses without a warning", () => {
	// The other direction: nothing the schema promises is rejected by the
	// parser (a documented-but-unreadable field would be a lie to the user).
	const warns: string[] = [];
	const cfg = {
		$schema: "./do-always.schema.json",
		shortcut: "f4",
		merge: "append",
		report: false,
		questionnaire: true,
		hidePlan: true,
		planNudge: false,
		anyPlan: true,
		markers: "ascii",
		aliases: { rc: "Review changes" },
		chains: { ship: ["Review changes", "Build"] },
		tasks: [
			{
				name: "Review changes",
				prompt: "Review {{branch}} ({{files_changed_count}} files).",
				description: "Review the current changes",
				category: "Plan",
				aliases: ["rc", "review"],
				mode: "plan",
				autoRun: true,
				questionnaire: true,
				hidePlan: false,
				hidden: false,
				notForCommits: true,
				requireDirty: true,
				guards: [
					{ type: "requireDirty" },
					{ type: "requireBranch", value: "main" },
					{ type: "requireRepo", value: "pi-do-always" },
					{ type: "requireFilePattern", value: "src/**/*.ts" },
				],
				when: { git: true, branch: "main", file: "package.json", repo: "pi-do-always" },
			},
			{ name: "Build", prompt: "Build it.", when: "git" },
			{ name: "Browse", prompt: "Pick commits.", browser: "commits" },
		],
	};
	const out = parseConfig(JSON.stringify(cfg), "test.json", (m) => warns.push(m));
	assert.deepEqual(warns, [], `every documented field must parse cleanly: ${warns.join(" | ")}`);
	assert.equal(out.tasks.length, 3);
	assert.equal(out.tasks[0].mode, "plan");
	assert.equal(out.tasks[0].guards?.length, 4);
	assert.deepEqual(out.tasks[0].when, cfg.tasks[0].when);
	assert.deepEqual(out.chains, { ship: ["Review changes", "Build"] });
	assert.deepEqual(out.aliases, { rc: "Review changes" });
	assert.equal(out.shortcut, "f4");
	assert.equal(out.merge, "append");
	assert.equal(out.report, false);
	assert.equal(out.planNudge, false);
	assert.equal(out.anyPlan, true);
	assert.equal(out.markers, "ascii");
});

test("an editor-only $schema key is accepted and ignored", () => {
	const warns: string[] = [];
	const out = parseConfig(
		JSON.stringify({ $schema: "https://example.invalid/do-always.schema.json", tasks: [{ name: "x", prompt: "p" }] }),
		"test.json",
		(m) => warns.push(m),
	);
	assert.deepEqual(warns, [], "$schema must not warn");
	assert.equal(out.tasks.length, 1);
});
