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
	/**
	 * Environment condition controlling whether the task is shown in the
	 * selector and lists. A string is a single condition ("git" | "!git"); an
	 * object is a set of conditions that must all hold (logical AND):
	 *   "git": boolean   — inside a git repo (true) or not (false)
	 *   "branch": string — current branch equals the given name (exact match)
	 *   "file": string   — a path that must exist in the working tree
	 *   "repo": string   — equals the git-remote basename context value
	 * Omitted/undefined always shows the task. Evaluated by `evaluateWhen`.
	 */
	when?: string | Record<string, unknown>;
	/**
	 * Extra selection-time guards, evaluated alongside the legacy `requireDirty`
	 * (see `evaluateGuards`). Each guard blocks the task (with a message, not a
	 * hide) when its condition is not met. `requireDirty` is kept for backward
	 * compatibility; new guards use this array so the set is extensible.
	 */
	guards?: Guard[];
}

/**
 * A selection-time guard that blocks a task when its condition is not met.
 * The task stays visible but selecting it notifies instead of injecting.
 * `requireDirty` needs no `value`; the others require a string `value`.
 */
export interface Guard {
	type: "requireDirty" | "requireBranch" | "requireRepo" | "requireFilePattern";
	value?: string;
}

/** The set of known guard types (used for validation at parse time). */
export const GUARD_TYPES = [
	"requireDirty",
	"requireBranch",
	"requireRepo",
	"requireFilePattern",
] as const;

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
			/**
			 * Whether chain runs write a Markdown report file (one per run, in
			 * the project root). Default true; set false to disable.
			 */
			report?: boolean;
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
	/**
	 * The `report` field, if present: whether chain runs write a Markdown
	 * report file. undefined when the file does not set one (default: on).
	 */
	report: boolean | undefined;
}

import { existsSync } from "node:fs";
import { join } from "node:path";

/**
 * Structured facts about the working tree and git state, gathered once per
 * use (see `buildContext` in index.ts). `when` conditions and guards are
 * evaluated against this; `renderPrompt` consumes the derived string view
 * from `toPromptContext`.
 *
 * Keeping the structured form here (instead of re-parsing the rendered
 * strings) means guards see the complete file list — `files_changed` in the
 * string view is capped for display, but `files` is never truncated.
 */
export interface TaskContext {
	/** Absolute path of the working directory. */
	cwd: string;
	/** Local date, YYYY-MM-DD. */
	date: string;
	/** Current git branch, or "unknown" when unavailable. */
	branch: string;
	/** Subject of the latest commit, or "unknown" when unavailable. */
	lastCommit: string;
	/** All changed files (staged, unstaged, untracked), deduplicated and sorted. */
	files: string[];
	/** `git config user.name`, or "unknown" when unset. */
	user: string;
	/** Output of `git diff --shortstat`, or "none" when unavailable. */
	diffStat: string;
	/** Basename of the git remote (or cwd), to disambiguate monorepo work. */
	repo: string;
	/** Files staged for commit. */
	stagedFiles: string[];
	/** Modified-but-unstaged files. */
	unstagedFiles: string[];
	/** True when cwd is inside a git working tree (authoritative, not inferred from the branch name). */
	isGitRepo: boolean;
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
	"diff_stat",
	"repo",
	"staged_files",
	"unstaged_files",
] as const;

/** A fully populated prompt context: one entry per PROMPT_CONTEXT_KEYS. */
export type PromptContext = Record<(typeof PROMPT_CONTEXT_KEYS)[number], string>;

/** Max number of file paths listed in the `files_changed` string view (the count stays exact). */
export const MAX_FILES_LISTED = 20;

/**
 * Derive the string view consumed by `renderPrompt` from a structured context.
 * `files_changed` lists at most MAX_FILES_LISTED paths (with a "… (+N more)"
 * suffix) and `files_changed_count` stays exact; `staged_files` and
 * `unstaged_files` are newline-separated. Empty lists render as "none".
 */
export function toPromptContext(ctx: TaskContext): PromptContext {
	return {
		cwd: ctx.cwd,
		date: ctx.date,
		branch: ctx.branch,
		last_commit: ctx.lastCommit,
		files_changed: formatFileList(ctx.files),
		files_changed_count: String(ctx.files.length),
		user: ctx.user,
		diff_stat: ctx.diffStat,
		repo: ctx.repo,
		staged_files: formatFileLines(ctx.stagedFiles),
		unstaged_files: formatFileLines(ctx.unstagedFiles),
	};
}

/** Comma-joined list, capped at MAX_FILES_LISTED entries; "none" when empty. */
function formatFileList(files: string[]): string {
	if (files.length === 0) return "none";
	if (files.length > MAX_FILES_LISTED) {
		return [...files.slice(0, MAX_FILES_LISTED), `… (+${files.length - MAX_FILES_LISTED} more)`].join(", ");
	}
	return files.join(", ");
}

/** Newline-joined list; "none" when empty. */
function formatFileLines(files: string[]): string {
	return files.length === 0 ? "none" : files.join("\n");
}

/**
 * Parse `git status --porcelain` (v1) output into changed file paths. Lines
 * are "XY <path>" (X = index, Y = worktree); short lines are skipped,
 * duplicates removed, and the result sorted.
 */
export function parseStatusPorcelain(status: string): string[] {
	const files: string[] = [];
	for (const line of status.split("\n")) {
		if (line.length < 4) continue;
		const path = line.slice(3);
		if (path && !files.includes(path)) files.push(path);
	}
	files.sort();
	return files;
}

/** Split raw `git diff --name-only` output into file paths (trimmed, non-empty lines). */
export function splitFileLines(raw: string | undefined): string[] {
	if (!raw) return [];
	return raw.split("\n").map((line) => line.trim()).filter(Boolean);
}

/** Used when neither config file defines any task. */
export const DEFAULT_TASKS: DoAlwaysTask[] = [
	{
		name: "Review changes",
		category: "Plan",
		description: "Review the current code changes (Plan)",
		requireDirty: true,
		prompt:
			"Review the changes on branch {{branch}} ({{files_changed_count}} changed files: {{files_changed}}). " +
			"Change summary: {{diff_stat}}. Last commit: {{last_commit}}. " +
			"Check `git status` and `git diff` to see what changed, then double-check the changes for bugs, " +
			"edge cases, security issues, and consistency with the rest of the codebase. " +
			"Do a plan proposal for the fixes if needed. Do a summary of your findings",
	},
	{
		name: "Review code",
		category: "Plan",
		description: "Review the whole project's code quality (Plan)",
		prompt:
			"Review this project's code holistically: identify code smells, dead code, duplication, awkward architecture or patterns, maintainability issues, inconsistencies, and missing or unclear documentation. " +
			"Prioritize by impact, propose a plan for the fixes, and summarize your findings. Do not make any changes yet.",
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
		when: "git",
		prompt:
			"Prepare a release for this project (branch {{branch}}): check `git log` since the last tag, update the version in package.json (or the equivalent location), add a changelog entry summarizing the changes, and create a git tag if git present. Do not push.",
	},
	{
		name: "Commit",
		category: "Ops",
		description: "Prepare a clean commit",
		requireDirty: true,
		when: "git",
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
		return { tasks: [], shortcut: undefined, report: undefined };
	}

	const list = Array.isArray(data) ? data : data?.tasks;

	if (!Array.isArray(list)) {
		onError(`do-always: ${path} must be a JSON array of tasks or {"tasks": [...]}`);
		return { tasks: [], shortcut: undefined, report: undefined };
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
				if (t.guards !== undefined) {
					if (Array.isArray(t.guards)) {
						const guards: Guard[] = [];
						for (const g of t.guards) {
							const parsed = parseGuard(g, path, onError);
							if (parsed) guards.push(parsed);
						}
						if (guards.length > 0) task.guards = guards;
					} else {
						onError(`do-always: ignoring invalid "guards" in ${path} (expected an array of guards)`);
					}
				}
				if (t.when !== undefined) {
				if (isValidWhen(t.when)) {
					task.when = t.when;
				} else {
					onError(`do-always: ignoring invalid "when" in ${path} (expected "git"/"!git" or an object of git|branch|file|repo conditions)`);
				}
			}
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
	let report: boolean | undefined;
	if (!Array.isArray(data) && "report" in data) {
		if (typeof data.report === "boolean") report = data.report;
		else onError(`do-always: ignoring invalid "report" in ${path} (expected true or false)`);
	}

	return { tasks, shortcut, merge, report };
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

/**
 * Validate the shape of a `when` condition: the string "git" or "!git", or an
 * object whose entries are all known condition keys with matching value types
 * (`git` -> boolean; `branch`/`file`/`repo` -> string). Used by `parseConfig`
 * to reject malformed conditions with a warning instead of silently changing
 * behavior.
 */
export function isValidWhen(when: unknown): boolean {
	if (typeof when === "string") {
		return when === "git" || when === "!git";
	}
	if (typeof when !== "object" || when === null || Array.isArray(when)) {
		return false;
	}
	for (const [key, value] of Object.entries(when as Record<string, unknown>)) {
		switch (key) {
			case "git":
				if (typeof value !== "boolean") return false;
				break;
			case "branch":
			case "file":
			case "repo":
				if (typeof value !== "string") return false;
				break;
			default:
				return false; // unknown condition key
		}
	}
	return true;
}

/** True when `relativePath` exists (as file or directory) under `cwd`. */
function pathExists(cwd: string, relativePath: string): boolean {
	try {
		return existsSync(join(cwd, relativePath));
	} catch {
		return false;
	}
}

/**
 * Evaluate a single `when` object entry against the current context.
 * Unknown keys are treated as no-ops (permissive) so a typo never hides a task
 * at runtime (parse time rejects them with a warning instead).
 */
function evaluateWhenEntry(key: string, value: unknown, ctx: TaskContext): boolean {
	switch (key) {
		case "git":
			return typeof value === "boolean" ? ctx.isGitRepo === value : false;
		case "branch":
			return typeof value === "string" && ctx.branch === value;
		case "file":
			return typeof value === "string" && pathExists(ctx.cwd, value);
		case "repo":
			return typeof value === "string" && ctx.repo === value;
		default:
			return true;
	}
}

/**
 * Evaluate a task's `when` condition against the current prompt context.
 * Returns true when the task should be shown, false when its condition is not
 * met. An omitted/undefined condition always shows the task.
 *
 * The string form is a single condition ("git" | "!git"). The object form is a
 * set of conditions that must all hold (logical AND): `git`, `branch`, `file`,
 * or `repo` (see the `DoAlwaysTask.when` field).
 */
export function evaluateWhen(task: DoAlwaysTask, ctx: TaskContext): boolean {
	const when = task.when;
	if (when === undefined || when === null) return true;
	if (typeof when === "string") {
		const negated = when.startsWith("!");
		const key = negated ? when.slice(1) : when;
		if (key === "git") return negated ? !ctx.isGitRepo : ctx.isGitRepo;
		return true; // an invalid string condition is rejected at parse time
	}
	if (typeof when === "object") {
		for (const [key, value] of Object.entries(when as Record<string, unknown>)) {
			if (!evaluateWhenEntry(key, value, ctx)) return false;
		}
		return true;
	}
	return true;
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
export function evaluateGuards(task: DoAlwaysTask, ctx: TaskContext): string | null {
	// Legacy `requireDirty` is folded into the guard table so the set of guards
	// is extensible without touching this function's callers.
	const guards: Guard[] = [];
	if (task.requireDirty) guards.push({ type: "requireDirty" });
	guards.push(...(task.guards ?? []));
	for (const g of guards) {
		const message = guardFailureMessage(g, ctx);
		if (message) return message;
	}
	return null;
}

/**
 * The blocking message a guard produces when its condition is unmet, or null
 * when the guard passes. All guards are evaluated against the current prompt
 * context, so a task is only injected when every guard is met.
 */
function guardFailureMessage(g: Guard, ctx: TaskContext): string | null {
	switch (g.type) {
		case "requireDirty":
			return ctx.files.length === 0 ? "working tree is clean — nothing to review" : null;
		case "requireBranch":
			return ctx.branch === g.value ? null : `not on branch "${g.value}" (currently ${ctx.branch})`;
		case "requireRepo":
			return ctx.repo === g.value ? null : `not in repo "${g.value}" (currently ${ctx.repo})`;
		case "requireFilePattern":
			return filesMatchPattern(ctx.files, g.value!) ? null : `no changed files match "${g.value}"`;
		default:
			return null; // an unknown type is rejected at parse time
	}
}

/**
 * Whether any changed file matches `pattern`, treated as a glob: `*` matches
 * within a path segment, `**` crosses segments, `?` matches one non-separator
 * character, and other regex metacharacters are literal. Matches against the
 * complete file list (never the capped display string), so files beyond
 * MAX_FILES_LISTED are still considered.
 */
function filesMatchPattern(files: string[], pattern: string): boolean {
	const re = globToRegex(pattern);
	return files.some((f) => re.test(f));
}

/** Regex metacharacters that must be escaped when matching a literal path char. */
const METACHARACTERS = ".+^${}()|[]";

/** Convert a glob to an anchored RegExp (`**` -> `.*`, `*` -> `[^/]*`, `?` -> `[^/]`). */
function globToRegex(pattern: string): RegExp {
	let out = "";
	let i = 0;
	while (i < pattern.length) {
		const c = pattern[i];
		if (c === "*") {
			let stars = 0;
			while (i < pattern.length && pattern[i] === "*") {
				stars++;
				i++;
			}
			out += stars >= 2 ? ".*" : "[^/]*"; // `**` crosses path separators
		} else if (c === "?") {
			out += "[^/]";
			i++;
		} else {
			out += METACHARACTERS.includes(c) ? "\\" + c : c;
			i++;
		}
	}
	return new RegExp(`^${out}$`);
}

/**
 * Validate and normalize a single `guards` entry. Returns undefined (after
 * warning) for an invalid entry so it is skipped rather than changing behavior.
 */
export function parseGuard(
	raw: unknown,
	path: string,
	onError: (message: string) => void = () => {},
): Guard | undefined {
	if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
		onError(`do-always: ignoring invalid guard in ${path} (expected an object)`);
		return undefined;
	}
	const { type } = raw as Record<string, unknown>;
	if (typeof type !== "string" || !GUARD_TYPES.includes(type as Guard["type"])) {
		const known = GUARD_TYPES.join(", ");
		onError(
			`do-always: ignoring invalid "type" in guard ${path} (expected one of: ${known})`,
		);
		return undefined;
	}
	const guard: Guard = { type: type as Guard["type"] };
	if (type !== "requireDirty") {
		const { value } = raw as Record<string, unknown>;
		if (typeof value !== "string") {
			onError(`do-always: guard "${type}" in ${path} requires a string "value"`);
			return undefined;
		}
		guard.value = value;
	}
	return guard;
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

// ---------------------------------------------------------------------------
// Chains
//
// A chain is an ordered, duplicate-free list of tasks the user builds in the
// selector table (ORDER column) and runs from the pinned Run row. All
// operations are pure: they return new states, never mutate.
// ---------------------------------------------------------------------------

/** Maximum number of tasks in a chain. */
export const CHAIN_MAX = 8;

/**
 * A task chain: ordered task names plus a LIFO history of adds (for undo).
 * Pure state — every operation returns a new state.
 */
export interface ChainState {
	/** Task names in execution order (duplicate-free). */
	items: string[];
	/** LIFO history of added names, consumed by `chainUndo`. */
	history: string[];
}

/** An empty chain. */
export function chainClear(): ChainState {
	return { items: [], history: [] };
}

/**
 * Add a task to the chain. A name already in the chain is moved to the end
 * (`movedToEnd`); when the chain is at CHAIN_MAX the state is returned
 * unchanged (`full`).
 */
export function chainAdd(
	state: ChainState,
	name: string,
): { state: ChainState; result: "added" | "movedToEnd" | "full" } {
	if (state.items.includes(name)) {
		return {
			state: {
				items: [...state.items.filter((n) => n !== name), name],
				history: [...state.history, name],
			},
			result: "movedToEnd",
		};
	}
	if (state.items.length >= CHAIN_MAX) {
		return { state, result: "full" };
	}
	return {
		state: { items: [...state.items, name], history: [...state.history, name] },
		result: "added",
	};
}

/** Remove a task from the chain (no-op when absent). History is untouched. */
export function chainRemove(state: ChainState, name: string): ChainState {
	if (!state.items.includes(name)) return state;
	return { ...state, items: state.items.filter((n) => n !== name) };
}

/**
 * Undo the most recent add that is still in the chain, skipping names that
 * were removed in the meantime. Returns `removed: null` when there is
 * nothing left to undo.
 */
export function chainUndo(state: ChainState): { state: ChainState; removed: string | null } {
	for (let i = state.history.length - 1; i >= 0; i--) {
		const name = state.history[i];
		if (state.items.includes(name)) {
			return {
				state: {
					items: state.items.filter((n) => n !== name),
					history: state.history.slice(0, i),
				},
				removed: name,
			};
		}
	}
	return { state, removed: null };
}

/**
 * Move a task one position up (-1) or down (1) in the chain. No-op at the
 * ends or when the name is not in the chain.
 */
export function chainMove(state: ChainState, name: string, dir: -1 | 1): ChainState {
	const idx = state.items.indexOf(name);
	const target = idx + dir;
	if (idx < 0 || target < 0 || target >= state.items.length) return state;
	const items = [...state.items];
	items[idx] = items[target];
	items[target] = name;
	return { ...state, items };
}

/**
 * Where the cursor lands when pressing → from task row `fromRow`: the ORDER
 * cell of the nearest chained row — the same row when it is chained, else the
 * nearest chained row upward, then downward (wrapping). Null when the chain
 * is empty (or when no visible row is chained, e.g. a stale chain).
 */
export function landOnOrderColumn(
	rows: DoAlwaysTask[],
	chain: ChainState,
	fromRow: number,
): number | null {
	if (chain.items.length === 0 || rows.length === 0) return null;
	const isChained = (i: number): boolean => chain.items.includes(rows[i]?.name ?? "");
	if (isChained(fromRow)) return fromRow;
	const n = rows.length;
	for (let d = 1; d < n; d++) {
		if (isChained((fromRow - d + n) % n)) return (fromRow - d + n) % n;
		if (isChained((fromRow + d) % n)) return (fromRow + d) % n;
	}
	return null;
}

/**
 * Label for the pinned Run row: a dimmed placeholder for an empty chain,
 * singular for one task, plural with the count otherwise.
 */
export function chainRunLabel(count: number): string {
	if (count === 0) return "run the chain (0)";
	if (count === 1) return "Run the task";
	return `Run the chain (${count})`;
}

/** One row of the task table (see `buildTableRows`). */
export interface TableRow {
	kind: "header" | "task" | "run";
	/** Header text (kind=header) or the run label (kind=run). */
	name?: string;
	/** The task (kind=task). */
	task?: DoAlwaysTask;
	/** 1-based chain position (kind=task, only when the task is chained). */
	order?: number;
}

/**
 * Build the table rows: a header row per non-empty category, a task row per
 * task carrying its ORDER position, and the pinned Run row last (label from
 * `chainRunLabel`).
 */
export function buildTableRows(groups: TaskGroup[], chain: ChainState): TableRow[] {
	const rows: TableRow[] = [];
	for (const g of groups) {
		if (g.items.length === 0) continue;
		rows.push({ kind: "header", name: g.name });
		for (const t of g.items) {
			const pos = chain.items.indexOf(t.name);
			rows.push({
				kind: "task",
				task: t,
				...(pos >= 0 ? { order: pos + 1 } : {}),
			});
		}
	}
	rows.push({ kind: "run", name: chainRunLabel(chain.items.length) });
	return rows;
}

/**
 * Footer preview of the chain: "1.⚡ Review changes → 2.Build". Tasks are
 * looked up in `tasks`; unknown names (a stale chain) are skipped.
 */
export function formatChainSequence(tasks: DoAlwaysTask[], chain: ChainState): string {
	const parts = chain.items
		.map((name, i) => {
			const t = tasks.find((x) => x.name === name);
			if (!t) return null;
			const marker = shouldAutoRun(t) ? "⚡" : "";
			return `${i + 1}.${marker}${t.name}`;
		})
		.filter((p): p is string => p !== null);
	return parts.join(" → ");
}

/**
 * Validate a chain against the context: every task must pass its guards.
 * Returns the first failing step (1-based) with the guard message, or null
 * when the whole chain may run. Stale names (not found in `tasks`) are
 * skipped — the runner drops them.
 */
export function validateChain(
	tasks: DoAlwaysTask[],
	chain: ChainState,
	ctx: TaskContext,
): { step: number; task: DoAlwaysTask; message: string } | null {
	for (let i = 0; i < chain.items.length; i++) {
		const task = tasks.find((t) => t.name === chain.items[i]);
		if (!task) continue;
		const message = evaluateGuards(task, ctx);
		if (message) return { step: i + 1, task, message };
	}
	return null;
}

// ── Chain report ─────────────────────────────────────────────────────────
//
// A chain run's results are appended to a Markdown report file (one file
// per run, in the project root) as each step finishes, so earlier steps'
// results survive later steps' output scrolling them off screen. The file
// is written incrementally: even if the session dies mid-chain, the
// finished steps' results are on disk.

/** HH:MM in the local timezone. */
function reportTime(d: Date): string {
	return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

/** File name for one chain run's report, e.g. do-always-report-tasks-2025-01-15-1432.md. */
export function reportFileName(now: Date): string {
	const p = (n: number) => String(n).padStart(2, "0");
	return `do-always-report-tasks-${now.getFullYear()}-${p(now.getMonth() + 1)}-${p(now.getDate())}-${p(now.getHours())}${p(now.getMinutes())}.md`;
}

/**
 * Resolve the report file path in `cwd`, appending -2, -3, … when a file
 * with the same name already exists (two runs within the same minute).
 */
export function resolveReportPath(
	cwd: string,
	now: Date,
	exists: (path: string) => boolean = existsSync,
): string {
	const base = reportFileName(now);
	const first = join(cwd, base);
	if (!exists(first)) return first;
	const stem = base.slice(0, -3); // drop ".md"
	for (let i = 2; ; i++) {
		const candidate = join(cwd, `${stem}-${i}.md`);
		if (!exists(candidate)) return candidate;
	}
}

/** Markdown header for a new report file. */
export function reportHeader(projectPath: string, stepNames: string[], now: Date): string {
	const p = (n: number) => String(n).padStart(2, "0");
	const stamp = `${now.getFullYear()}-${p(now.getMonth() + 1)}-${p(now.getDate())} ${reportTime(now)}`;
	return [
		`# do-always chain report — ${stamp}`,
		"",
		`- Project: ${projectPath}`,
		`- Steps: ${stepNames.join(" → ")}`,
		"",
		"",
	].join("\n");
}

/**
 * Markdown section for one finished step: its number, name, outcome, run
 * time, and the final assistant message (the step's result). `startedAt`
 * is null when the run never started (failed-to-start).
 */
export function reportStepSection(
	index: number,
	name: string,
	status: string,
	startedAt: Date | null,
	endedAt: Date,
	text: string,
): string {
	const times = startedAt ? `${reportTime(startedAt)} → ${reportTime(endedAt)}` : reportTime(endedAt);
	const lines = [`## ${index + 1}. ${name} — ${status} (${times})`, ""];
	const trimmed = text.trim();
	lines.push(trimmed === "" ? "_(no result text)_" : trimmed, "", "");
	return lines.join("\n");
}

/** Markdown footer summarizing the whole run. */
export function reportFooter(stepStatuses: string[], now: Date): string {
	const done = stepStatuses.filter((s) => s === "completed").length;
	const total = stepStatuses.length;
	const p = (n: number) => String(n).padStart(2, "0");
	const stamp = `${now.getFullYear()}-${p(now.getMonth() + 1)}-${p(now.getDate())} ${reportTime(now)}`;
	const summary =
		done === total ? `${done}/${total} completed` : `${done}/${total} completed — chain stopped early`;
	return `---\n\n**Chain finished:** ${stamp} — ${summary}\n`;
}

/**
 * Extract an assistant message's text: string content as-is, or the text
 * parts of a content array joined with newlines (tool-call parts are not
 * text and are skipped). Same shape pi's own runtime uses. Null/undefined
 * content (a run that produced no assistant text) yields "".
 */
export function assistantText(
	content: string | Array<{ type?: string; text?: string }> | null | undefined,
): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.flatMap((part) => (part && part.type === "text" && typeof part.text === "string" ? [part.text] : []))
		.join("\n");
}
