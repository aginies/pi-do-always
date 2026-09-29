/**
 * do-always — pure task logic (no Pi dependencies).
 *
 * Kept separate from index.ts so it can be unit-tested without the Pi runtime.
 */

export interface DoAlwaysTask {
	/** Short unique name, usable as /do-always <name> */
	name: string;
	/** Group header the task is shown under in the selector (e.g. "Plan", "Do"). */
	category?: string;
	/** Short one-line description shown next to the task in the selector */
	description?: string;
	/** Prompt filled into the editor when the task is selected */
	prompt: string;
	/**
	 * Whether selecting the task sends its prompt immediately (auto-run) instead
	 * of filling the editor. When omitted, the default is derived from the
	 * category: "Plan" tasks auto-run, everything else fills the editor.
	 */
	autoRun?: boolean;
	/**
	 * Whether the task should be blocked when the working tree is clean
	 * (`files_changed_count === 0`). When set and unmet, the extension notifies
	 * instead of injecting, avoiding a no-op round-trip. Guards are evaluated
	 * against the current prompt context (see `evaluateGuards`).
	 */
	requireDirty?: boolean;
}

/**
 * A config file can be a bare array of tasks, or {"tasks": [...], "shortcut": ...}.
 * `shortcut` is a key id string (e.g. "f4", "ctrl+shift+p"), or null to disable
 * the keyboard shortcut.
 * `merge` controls how project tasks combine with global tasks:
 * `override` (default) replaces a global task with the same name;
 * `append` keeps globals and only adds new project task names (a cascade).
 */
export type DoAlwaysConfig =
	| DoAlwaysTask[]
	| {
			tasks: DoAlwaysTask[];
			shortcut?: string | null;
			merge?: "append" | "override";
		};

/** Shortcut used when neither config file specifies one. */
export const DEFAULT_SHORTCUT = "f4";

/** Result of parsing a config file. */
export interface ParsedDoAlwaysConfig {
	tasks: DoAlwaysTask[];
	/**
	 * The `shortcut` field, if present: a key id string, null when explicitly
	 * disabled, undefined when the file does not set one.
	 */
	shortcut: string | null | undefined;
	/**
	 * The `merge` field, if present: "append" or "override", undefined when the
	 * file does not set one.
	 */
	merge?: "append" | "override" | undefined;
}

/**
 * The set of context keys the extension can inject into prompts (see
 * `renderPrompt`). `index.ts` is responsible for supplying all of them (with
 * neutral fallbacks when a fact is unavailable); tests use this to check that
 * default prompts only reference known keys.
 */
export const PROMPT_CONTEXT_KEYS = [
	"cwd",
	"date",
	"branch",
	"last_commit",
	"files_changed",
	"files_changed_count",
	"user",
	"diff_stat", // NEW: "3 files changed, 41 insertions(+), 7 deletions(-)"
	"repo", // NEW: basename of cwd or git remote (disambiguates monorepos)
	"staged_files", // NEW: files staged for commit
	"unstaged_files", // NEW: modified-but-unstaged files
] as const;

/** A fully populated prompt context: one entry per PROMPT_CONTEXT_KEYS. */
export type PromptContext = Record<(typeof PROMPT_CONTEXT_KEYS)[number], string>;

/** Used when neither config file defines any task. */
export const DEFAULT_TASKS: DoAlwaysTask[] = [
	{
		name: "Review",
		category: "Plan",
		description: "Review code and double-check changes (Plan)",
		requireDirty: true,
		prompt:
			"Review the changes on branch {{branch}} ({{files_changed_count}} changed files: {{files_changed}}). " +
			"Change summary: {{diff_stat}}. Last commit: {{last_commit}}. " +
			"Check `git status` and `git diff` to see what changed, then double-check the changes for bugs, " +
			"edge cases, security issues, and consistency with the rest of the codebase. " +
			"Do a plan proposal for the fixes if needed. Do a summary of your findings",
	},
	{
		name: "Cleanup",
		category: "Plan",
		description: "Clean up dead code and duplicates (Plan)",
		prompt:
			"Scan the project for dead code, unused imports, commented-out blocks, and duplicated logic. Do a plan proposal for the removals and consolidations, keeping behavior unchanged. Do not make any changes yet.",
	},
	{
		name: "Readme",
		category: "Docs",
		description: "Update the README.md",
		prompt:
			"Update the README.md to match the current state of the project. Check the code, scripts, and configuration, then update the README.md sections that are now out of date (description, installation, usage, configuration). Keep it concise and accurate.",
	},
	{
		name: "Build",
		category: "Do",
		description: "Test build is ok and fix issues",
		prompt:
			"Build the project (run the build script, e.g. `npm run build`, plus type check if available). If the build fails, diagnose the errors and fix them, then re-build until it succeeds. Summarize what was broken and what you changed.",
	},
	{
		name: "Security",
		category: "Plan",
		description: "Security audit (Plan)",
		prompt:
			"Audit this project for security issues: hardcoded secrets or credentials, unsafe patterns (injection, path traversal, unsafe deserialization), and vulnerable or outdated dependencies. Do a plan proposal for the fixes. Do not make any changes yet.",
	},
	{
		name: "Performance",
		category: "Plan",
		description: "Performance review (Plan)",
		prompt:
			"Review this project for likely performance bottlenecks: inefficient algorithms, redundant I/O or computation, missing caching, and memory leaks. Do a plan proposal for the optimizations, prioritized by impact. Do not make any changes yet.",
	},
	{
		name: "Tests",
		category: "Do",
		description: "Run tests and fix failures",
		prompt:
			"Run the project's test suite (and type check / lint if available). If anything fails, diagnose and fix the failures, then re-run until green. Summarize the results.",
	},
	{
		name: "Release",
		category: "Ops",
		description: "Prepare a release (version, changelog, tag)",
		prompt:
			"Prepare a release for this project (branch {{branch}}): check `git log` since the last tag, update the version in package.json (or the equivalent location), add a changelog entry summarizing the changes, and create a git tag if git present. Do not push.",
	},
	{
		name: "Commit",
		category: "Ops",
		description: "Prepare a clean commit",
		requireDirty: true,
		prompt:
			"Prepare the working tree on branch {{branch}} ({{files_changed_count}} changed files: {{files_changed}}) for a clean commit: stage the relevant changes, and write a clear commit message describing what changed and why. Do not push.",
	},
	{
		name: "Propose features",
		category: "Plan",
		description: "Propose new features (Plan)",
		prompt:
			"Review this project and propose new features that would add value. For each idea, describe the problem it solves, the user benefit, and a rough implementation approach. Prioritize by impact and effort. Do not make any changes yet. Try to evaluate how many lines this will be in term of changes, if this will breaks API, compatibility issue.",
	},
];

/**
 * Parse and validate a config file's contents.
 * Accepts a bare array of tasks or {"tasks": [...], "shortcut": "f4" | null}.
 * Invalid entries are skipped with a warning.
 * Returns empty results when the JSON is malformed or the shape is wrong.
 */
export function parseConfig(
	raw: string,
	path: string,
	onError: (message: string) => void = () => {},
): ParsedDoAlwaysConfig {
	let data: DoAlwaysConfig;
	try {
		data = JSON.parse(raw);
	} catch (err) {
		onError(`do-always: invalid JSON in ${path}: ${err}`);
		return { tasks: [], shortcut: undefined };
	}

	const list = Array.isArray(data) ? data : data?.tasks;

	if (!Array.isArray(list)) {
		onError(`do-always: ${path} must be a JSON array of tasks or {"tasks": [...]}`);
		return { tasks: [], shortcut: undefined };
	}

	const tasks: DoAlwaysTask[] = [];
	for (const entry of list) {
		const t = entry as Partial<DoAlwaysTask> | null;
		if (t && typeof t.name === "string" && t.name.length > 0 && typeof t.prompt === "string" && t.prompt.length > 0) {
			const task: DoAlwaysTask = {
				name: t.name,
				prompt: t.prompt,
			};
			if (typeof t.description === "string") task.description = t.description;
			if (typeof t.category === "string" && t.category.trim() !== "") task.category = t.category.trim();
				if (typeof t.autoRun === "boolean") task.autoRun = t.autoRun;
				if (typeof t.requireDirty === "boolean") task.requireDirty = t.requireDirty;
				tasks.push(task);
		} else {
			onError(`do-always: skipping invalid task in ${path} (each task needs "name" and "prompt")`);
		}
	}

	let shortcut: string | null | undefined;
	let merge: "append" | "override" | undefined;
	if (!Array.isArray(data) && "shortcut" in data) {
		const s = data.shortcut;
		if (s === null) shortcut = null;
		else if (typeof s === "string") shortcut = s.trim() === "" ? null : s.trim();
		else onError(`do-always: ignoring invalid "shortcut" in ${path} (expected a key string or null)`);
	}
	if (!Array.isArray(data) && "merge" in data) {
		merge = parseMerge(data.merge, path, onError);
	}

	return { tasks, shortcut, merge };
}

const KEY_MODIFIERS = new Set(["ctrl", "shift", "alt", "super"]);
const KEY_SPECIALS = new Set([
	"escape", "esc", "enter", "return", "tab", "space", "backspace", "delete",
	"insert", "clear", "home", "end", "pageup", "pagedown", "up", "down",
	"left", "right", "f1", "f2", "f3", "f4", "f5", "f6", "f7", "f8", "f9",
	"f10", "f11", "f12",
]);

/**
 * Check whether a string is a valid key id (e.g. "f4", "ctrl+shift+p").
 * Mirrors the KeyId syntax: optional ctrl/shift/alt/super modifiers (each at
 * most once) followed by a base key (letter, digit, or special key).
 */
export function isValidKeyId(key: string): boolean {
	const parts = key.toLowerCase().split("+");
	const base = parts[parts.length - 1];
	if (!base) return false;
	if (!(/^[a-z0-9]$/.test(base) || KEY_SPECIALS.has(base))) return false;
	const mods = parts.slice(0, -1);
	return mods.every((m) => KEY_MODIFIERS.has(m)) && new Set(mods).size === mods.length;
}

/**
 * Resolve the shortcut from global and project config. A value present in the
 * project file wins (null disables); otherwise the global value; otherwise
 * DEFAULT_SHORTCUT.
 */
export function resolveShortcut(
	globalShortcut: string | null | undefined,
	projectShortcut: string | null | undefined,
): string | null {
	if (projectShortcut !== undefined) return projectShortcut;
	if (globalShortcut !== undefined) return globalShortcut;
	return DEFAULT_SHORTCUT;
}

/**
 * Parse the optional `merge` field: "append" or "override" (case-insensitive),
 * or undefined when absent. A non-string or unrecognized value is ignored with
 * a warning, so it never silently changes behavior.
 */
function parseMerge(
	raw: unknown,
	path: string,
	onError: (message: string) => void,
): "append" | "override" | undefined {
	if (raw === undefined) return undefined;
	if (typeof raw !== "string") {
		onError(`do-always: ignoring invalid "merge" in ${path} (expected "append" or "override")`);
		return undefined;
	}
	const v = raw.trim().toLowerCase();
	if (v === "append" || v === "override") return v;
	onError(`do-always: ignoring invalid "merge" in ${path} (expected "append" or "override")`);
	return undefined;
}

/**
 * Merge project-local tasks over global tasks.
 *
 * When `mode` is "override" (default), a project task with a name matching a
 * global task replaces it; new names are appended. When "append", globals are
 * kept as-is and only new (non-duplicate) project task names are appended.
 * Returns fallback when the merged result is empty.
 */
export function mergeTasks(
	globalTasks: DoAlwaysTask[],
	projectTasks: DoAlwaysTask[],
	fallback: DoAlwaysTask[],
	mode: "append" | "override" = "override",
): DoAlwaysTask[] {
	if (mode === "append") {
		const merged = [...globalTasks];
		const names = new Set(merged.map((t) => t.name));
		for (const task of projectTasks) {
			if (!names.has(task.name)) {
				merged.push(task);
				names.add(task.name);
			}
		}
		return merged.length > 0 ? merged : fallback;
	}

	const merged = [...globalTasks];
	for (const task of projectTasks) {
		const idx = merged.findIndex((t) => t.name === task.name);
		if (idx >= 0) merged[idx] = task;
		else merged.push(task);
	}
	return merged.length > 0 ? merged : fallback;
}

/** Default order for category headers in the selector. */
export const DEFAULT_CATEGORY_ORDER = ["Plan", "Do", "Docs", "Ops", "Other"];

/** A category group: a display name and the tasks that belong to it. */
export interface TaskGroup {
	name: string;
	items: DoAlwaysTask[];
}

/** Capitalize the first letter of each word ("my-category" -> "My-Category"). */
function titleCase(s: string): string {
	return s.replace(/\b[a-z]/g, (c) => c.toUpperCase());
}

/**
 * Group tasks by category, case-insensitively. Categories are ordered by
 * `order` (case-insensitive), then alphabetically; the original order within a
 * group is preserved. The group `name` is the title-cased category. Tasks
 * without a (non-empty) category fall under "Other".
 */
export function groupTasksByCategory(
	tasks: DoAlwaysTask[],
	order: string[] = DEFAULT_CATEGORY_ORDER,
): TaskGroup[] {
	const orderLower = order.map((o) => o.toLowerCase());
	const groups = new Map<string, DoAlwaysTask[]>();
	for (const t of tasks) {
		const key = (t.category ?? "").trim().toLowerCase() || "other";
		if (!groups.has(key)) groups.set(key, []);
		groups.get(key)!.push(t);
	}
	const keys = [...groups.keys()].sort((a, b) => {
		const na = orderLower.indexOf(a) === -1 ? order.length : orderLower.indexOf(a);
		const nb = orderLower.indexOf(b) === -1 ? order.length : orderLower.indexOf(b);
		return na - nb || a.localeCompare(b);
	});
	return keys.map((key) => ({ name: titleCase(key), items: groups.get(key)! }));
}

/**
 * Return tasks in display order: grouped by category (see
 * `groupTasksByCategory`), flattened. This is the canonical order the selector
 * numbers, digit-pick, `/do-always <n>`, and `list` all share.
 */
export function orderTasksByCategory(
	tasks: DoAlwaysTask[],
	order: string[] = DEFAULT_CATEGORY_ORDER,
): DoAlwaysTask[] {
	return groupTasksByCategory(tasks, order).flatMap((g) => g.items);
}

/**
 * Whether selecting a task should auto-run it (send its prompt immediately)
 * instead of filling the editor. An explicit `autoRun` flag wins; otherwise the
 * default is derived from the category — "Plan" tasks auto-run, everything else
 * fills the editor.
 */
export function shouldAutoRun(task: DoAlwaysTask): boolean {
	if (typeof task.autoRun === "boolean") return task.autoRun;
	return (task.category ?? "").trim().toLowerCase() === "plan";
}

/**
 * Evaluate a task's guards against the current prompt context. Returns a
 * notification message (caller should notify and abort) when a guard fails, or
 * null when every guard is met and the task may proceed.
 *
 * Guards keep low-value round-trips down: e.g. `requireDirty` blocks Review and
 * Commit on a clean tree so the agent is never asked to inspect nothing.
 */
export function evaluateGuards(task: DoAlwaysTask, ctx: PromptContext): string | null {
	if (task.requireDirty && ctx.files_changed_count === "0") {
		return "working tree is clean — nothing to review";
	}
	return null;
}

/**
 * Resolve a task from a command argument: by number (1-based) or by name (case-insensitive).
 */
export function resolveTask(tasks: DoAlwaysTask[], arg: string): DoAlwaysTask | undefined {
	const a = arg.trim();
	if (!a) return undefined;
	if (/^\d+$/.test(a)) {
		const n = Number(a);
		return n >= 1 && n <= tasks.length ? tasks[n - 1] : undefined;
	}
	return tasks.find((t) => t.name.toLowerCase() === a.toLowerCase());
}

/** Matches a `{{key}}` placeholder: key is [A-Za-z0-9_]+, optional inner whitespace. */
const PLACEHOLDER_RE = /\{\{\s*([A-Za-z0-9_]+)\s*\}\}/g;

/**
 * Substitute `{{key}}` placeholders in `template` with values from `ctx`.
 * A key that is not present in `ctx` is left as-is, so missing context stays
 * visible instead of silently blanking the sentence; a key present with an
 * empty-string value renders as empty. Templates without placeholders are
 * returned unchanged, so existing plain prompts keep working.
 */
export function renderPrompt(template: string, ctx: Record<string, string>): string {
	return template.replace(PLACEHOLDER_RE, (match, key: string) =>
		Object.prototype.hasOwnProperty.call(ctx, key) ? ctx[key] : match,
	);
}

/**
 * Render a numbered, one-line-per-task list. When tasks span more than one
 * category, a header line is emitted before each group (matching the selector).
 */
export function formatList(tasks: DoAlwaysTask[]): string {
	const groups = groupTasksByCategory(tasks);
	const lines: string[] = [];
	const showHeaders = groups.length > 1;
	let n = 0;
	for (const g of groups) {
		if (showHeaders) lines.push(g.name.toUpperCase());
		for (const t of g.items) {
			n++;
			lines.push(`${n}. ${t.name} — ${t.description ?? ""}`);
		}
	}
	return lines.join("\n");
}
