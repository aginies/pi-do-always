/**
 * do-always — pure task logic (no Pi dependencies).
 *
 * Kept separate from index.ts so it can be unit-tested without the Pi runtime.
 */

export interface DoAlwaysTask {
	/** Short unique name, usable as /do-always <name> */
	name: string;
	/** Short one-line description shown next to the task in the selector */
	description?: string;
	/** Prompt filled into the editor when the task is selected */
	prompt: string;
}

/**
 * A config file can be a bare array of tasks, or {"tasks": [...], "shortcut": ...}.
 * `shortcut` is a key id string (e.g. "f4", "ctrl+shift+p"), or null to disable
 * the keyboard shortcut.
 */
export type DoAlwaysConfig = DoAlwaysTask[] | { tasks: DoAlwaysTask[]; shortcut?: string | null };

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
}

/** Used when neither config file defines any task. */
export const DEFAULT_TASKS: DoAlwaysTask[] = [
	{
		name: "review",
		description: "Review code and double-check changes",
		prompt:
			"Review the recent code changes in this project. Check `git status` and `git diff` to see what changed, then double-check the changes for bugs, edge cases, security issues, and consistency with the rest of the codebase. Do a plan proposal for the fixes.",
	},
	{
		name: "readme",
		description: "Update the README",
		prompt:
			"Update the README to match the current state of the project. Check the code, scripts, and configuration, then update the README sections that are now out of date (description, installation, usage, configuration). Keep it concise and accurate.",
	},
	{
		name: "tests",
		description: "Run tests and fix failures",
		prompt:
			"Run the project's test suite (and type check / lint if available). If anything fails, diagnose and fix the failures, then re-run until green. Summarize the results.",
	},
	{
		name: "commit",
		description: "Prepare a clean commit",
		prompt:
			"Prepare the working tree for a clean commit: review `git status` and `git diff`, stage the relevant changes, and write a clear commit message describing what changed and why. Do not push.",
	},
	{
		name: "cleanup",
		description: "Propose a plan to clean up dead code and duplicates",
		prompt:
			"Scan the project for dead code, unused imports, commented-out blocks, and duplicated logic. Do a plan proposal for the removals and consolidations, keeping behavior unchanged. Do not make any changes yet.",
	},
	{
		name: "release",
		description: "Prepare a release (version, changelog, tag)",
		prompt:
			"Prepare a release for this project: check `git log` since the last tag, update the version in package.json (or the equivalent location), add a changelog entry summarizing the changes, and create a git tag. Do not push.",
	},
	{
		name: "security",
		description: "Security audit — plan proposal",
		prompt:
			"Audit this project for security issues: hardcoded secrets or credentials, unsafe patterns (injection, path traversal, unsafe deserialization), and vulnerable or outdated dependencies. Do a plan proposal for the fixes. Do not make any changes yet.",
	},
	{
		name: "perf",
		description: "Performance review — plan proposal",
		prompt:
			"Review this project for likely performance bottlenecks: inefficient algorithms, redundant I/O or computation, missing caching, and memory leaks. Do a plan proposal for the optimizations, prioritized by impact. Do not make any changes yet.",
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
			tasks.push({
				name: t.name,
				description: typeof t.description === "string" ? t.description : undefined,
				prompt: t.prompt,
			});
		} else {
			onError(`do-always: skipping invalid task in ${path} (each task needs "name" and "prompt")`);
		}
	}

	let shortcut: string | null | undefined;
	if (!Array.isArray(data) && "shortcut" in data) {
		const s = data.shortcut;
		if (s === null) shortcut = null;
		else if (typeof s === "string") shortcut = s.trim() === "" ? null : s.trim();
		else onError(`do-always: ignoring invalid "shortcut" in ${path} (expected a key string or null)`);
	}

	return { tasks, shortcut };
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
 * Merge project-local tasks over global tasks.
 * A project task with a name matching a global task replaces it; new names are appended.
 * Returns fallback when the merged result is empty.
 */
export function mergeTasks(globalTasks: DoAlwaysTask[], projectTasks: DoAlwaysTask[], fallback: DoAlwaysTask[]): DoAlwaysTask[] {
	const merged = [...globalTasks];
	for (const task of projectTasks) {
		const idx = merged.findIndex((t) => t.name === task.name);
		if (idx >= 0) merged[idx] = task;
		else merged.push(task);
	}
	return merged.length > 0 ? merged : fallback;
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

/** Render a numbered, one-line-per-task list. */
export function formatList(tasks: DoAlwaysTask[]): string {
	return tasks.map((t, i) => `${i + 1}. ${t.name} — ${t.description ?? ""}`).join("\n");
}
