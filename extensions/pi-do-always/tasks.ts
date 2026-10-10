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
	 * Hide the task from the selector and the `list` commands. Hidden tasks
	 * are not standalone user-visible entries; they can still be resolved by
	 * name on the command line and are offered as candidates by the commit
	 * picker. The built-in "Review commits" uses this: it is a pick-after-
	 * browse option, not an entry point ("Browse commits" is the entry).
	 */
	hidden?: boolean;
	/**
	 * Exclude the task from the commit picker (the "run on the selected
	 * commits" list shown after a commit selection). For Plan tasks that
	 * operate on the working tree or the whole project rather than on a set
	 * of commits. The task is otherwise unaffected (selector, lists, CLI).
	 */
	notForCommits?: boolean;
	/**
	 * Extra selection-time guards, evaluated alongside the legacy `requireDirty`
	 * (see `evaluateGuards`). Each guard blocks the task (with a message, not a
	 * hide) when its condition is not met. `requireDirty` is kept for backward
	 * compatibility; new guards use this array so the set is extensible.
	 */
	guards?: Guard[];
	/**
	 * A browser to open on selection instead of injecting the prompt directly.
	 * Currently only "commits": opens the date-grouped commit browser, and the
	 * selected commits drive the review prompt (see `fillPrompt` in index.ts).
	 * The built-in "Review commits" task also triggers the browser by name, so
	 * configs that predate this field keep working.
	 */
	browser?: BrowserType;
	/**
	 * Whether the plan questionnaire is offered after this task's run: the
	 * reply's "plan" block (tiers + action items) becomes a selectable list
	 * the user confirms or withdraws. Default true (the global config
	 * "questionnaire" sets the fallback); set false to keep the plain summary
	 * notification. Only meaningful for auto-run tasks (Plan category by
	 * default).
	 */
	questionnaire?: boolean;
	/**
	 * Whether the raw "plan" block is hidden from the transcript after this
	 * task's run: the fenced block is stripped from the finalized reply in
	 * the TUI (the questionnaire still parses the captured raw text; in
	 * non-TUI modes the block is always kept). Default true (the global
	 * config "hidePlan" sets the fallback); set false to keep the block
	 * visible in the transcript. Only meaningful for auto-run tasks (Plan
	 * category by default).
	 */
	hidePlan?: boolean;
	/**
	 * Short names that resolve to this task on the command line. Each alias
	 * is case-insensitive and is tried before the task's own name. Aliases
	 * must be single words (no spaces) and must not collide with other
	 * tasks' aliases or names (a collision is silently resolved to the
	 * first-encountered task).
	 */
	aliases?: string[];
}

/** The set of known guard types (used for validation at parse time). */
export const GUARD_TYPES = [
	"requireDirty",
	"requireBranch",
	"requireRepo",
	"requireFilePattern",
] as const;

export type GuardType = (typeof GUARD_TYPES)[number];

/**
 * A selection-time guard that blocks a task when its condition is not met.
 * The task stays visible but selecting it notifies instead of injecting.
 * `requireDirty` needs no `value`; the others require a string `value`.
 */
export interface Guard {
	type: GuardType;
	value?: string;
}

/** The set of known browser types (used for validation at parse time). */
export const BROWSER_TYPES = [
	"commits",
] as const;

export type BrowserType = (typeof BROWSER_TYPES)[number];

/**
 * A config file can be a bare array of tasks, or {"tasks": [...], "shortcut": ...}.
 * `shortcut` is a key id string (e.g. "f4", "ctrl+shift+p"), or null to disable
 * the keyboard shortcut.
 * `merge` controls how project tasks combine with global tasks:
 * `override` (default) replaces a global task with the same name;
 * `append` keeps globals and only adds new project task names (a cascade).
 */
type DoAlwaysConfig =
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
			/**
			 * Whether completed auto-run tasks whose reply carries a "plan"
			 * block offer the selection questionnaire. Default true; set false
			 * to keep the plain summary notification.
			 */
			questionnaire?: boolean;
			/**
			 * Whether the raw "plan" block is stripped from the transcript
			 * after a completed auto-run task (TUI only — in non-TUI modes
			 * the block is always kept). Default true; set false to keep the
			 * block visible in the transcript.
			 */
			hidePlan?: boolean;
			/**
			 * Whether a completed auto-run Plan task whose reply has no usable
			 * plan block (none at all, or malformed JSON) triggers one follow-up
			 * asking the agent to emit the block before the plain-summary
			 * fallback. Default true; set false to keep the old behavior (warn
			 * and offer no questionnaire).
			 */
			planNudge?: boolean;
			/**
			 * A global alias map: `{ "rc": "Review changes" }` maps a short
			 * alias string to a task name. Aliases are case-insensitive and
			 * are tried before the task's own name. Invalid entries (non-string
			 * values, empty keys) are silently ignored.
			 */
			aliases?: Record<string, string>;
		};

/** Shortcut used when neither config file specifies one. */
export const DEFAULT_SHORTCUT = "f4";

/** Result of parsing a config file. */
interface ParsedDoAlwaysConfig {
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
	/**
	 * The `questionnaire` field, if present: whether completed auto-run
	 * tasks whose reply carries a plan block offer the selection
	 * questionnaire. undefined when the file does not set one (default: on).
	 */
	questionnaire: boolean | undefined;
	/**
	 * The `hidePlan` field, if present: whether the raw plan block is
	 * stripped from the transcript after a completed auto-run task.
	 * undefined when the file does not set one (default: on).
	 */
	hidePlan: boolean | undefined;
	/**
	 * The `planNudge` field, if present: whether a completed auto-run Plan
	 * task whose reply has no usable plan block triggers one follow-up asking
	 * the agent to emit it. undefined when the file does not set one
	 * (default: on).
	 */
	planNudge: boolean | undefined;
	/**
	 * A global alias map parsed from the config object: `{ "rc": "Review changes" }`.
	 * undefined when the file does not set one.
	 */
	aliases: Record<string, string> | undefined;
}

import { existsSync } from "node:fs";
import { join, resolve, sep } from "node:path";

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
	/**
	 * Commits selected in the commit browser, formatted for prompt injection
	 * (see `formatSelectedCommits`), or "none" when no selection is active.
	 * Context builds always set "none"; the browser flow overrides it at render.
	 */
	selectedCommits: string;
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
	"selected_commits",
] as const;

/** A fully populated prompt context: one entry per PROMPT_CONTEXT_KEYS. */
export type PromptContext = Record<(typeof PROMPT_CONTEXT_KEYS)[number], string>;

/** Max number of file paths listed in the `files_changed` string view (the count stays exact). Exported for tests. */
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
		selected_commits: ctx.selectedCommits,
	};
}

/** Max number of file paths listed in the `staged_files` / `unstaged_files` string views. Exported for tests. */
export const MAX_FILE_LINES = 50;

/** Comma-joined list, capped at MAX_FILES_LISTED entries; "none" when empty. */
function formatFileList(files: string[]): string {
	if (files.length === 0) return "none";
	if (files.length > MAX_FILES_LISTED) {
		return [...files.slice(0, MAX_FILES_LISTED), `… (+${files.length - MAX_FILES_LISTED} more)`].join(", ");
	}
	return files.join(", ");
}

/** Newline-joined list, capped at MAX_FILE_LINES entries; "none" when empty. */
function formatFileLines(files: string[]): string {
	if (files.length === 0) return "none";
	if (files.length > MAX_FILE_LINES) {
		const shown = files.slice(0, MAX_FILE_LINES);
		const remaining = files.length - MAX_FILE_LINES;
		return [...shown, `… (+${remaining} more)`].join("\n");
	}
	return files.join("\n");
}

/**
 * Extract and normalize a file path from a git status porcelain line (v1).
 * Handles rename targets (`old -> new`) and unquotes quoted paths (`"file with space"`).
 */
function extractPorcelainPath(line: string): string | null {
	if (line.length < 4) return null;
	let path = line.slice(3).trim();
	if (path.includes(" -> ")) {
		path = path.split(" -> ").pop()!.trim();
	}
	if (path.startsWith('"') && path.endsWith('"') && path.length >= 2) {
		path = path.slice(1, -1).replace(/\\"/g, '"');
	}
	return path || null;
}

/**
 * Parse `git status --porcelain` (v1) output into changed file paths. Lines
 * are "XY <path>" (X = index, Y = worktree); short lines are skipped,
 * duplicates removed, and the result sorted.
 */
export function parseStatusPorcelain(status: string): string[] {
	const files: string[] = [];
	const seen = new Set<string>();
	for (const line of status.split("\n")) {
		const path = extractPorcelainPath(line);
		if (path && !seen.has(path)) {
			seen.add(path);
			files.push(path);
		}
	}
	files.sort((a, b) => a.localeCompare(b));
	return files;
}

/**
 * Split `git status --porcelain` (v1) output into staged and unstaged file
 * lists. Lines are "XY <path>" (X = index, Y = worktree; the path starts at
 * index 3): a space in the X column means the change is unstaged (worktree
 * only), anything else is staged or untracked. Short lines are skipped and
 * paths are deduplicated across both lists.
 */
export function parseStatusStagedUnstaged(
	status: string,
): { staged: string[]; unstaged: string[] } {
	const staged: string[] = [];
	const unstaged: string[] = [];
	const seen = new Set<string>();
	for (const line of status.split("\n")) {
		const path = extractPorcelainPath(line);
		if (!path || seen.has(path)) continue;
		seen.add(path);
		if (line[0] === " ") unstaged.push(path);
		else staged.push(path);
	}
	return { staged, unstaged };
}

/**
 * Extract the commit subject from a `git log --format=%H %s` line
 * ("<hash> <subject>"). The subject may contain spaces, so everything after
 * the first space is the subject. Returns "unknown" when the line is missing
 * or carries no subject.
 */
export function parseCommitSubject(commitLine: string | undefined): string {
	if (!commitLine) return "unknown";
	const space = commitLine.indexOf(" ");
	return space > 0 ? commitLine.slice(space + 1) || "unknown" : "unknown";
}

/**
 * Extract one key's value from `git config --get-regexp` output (one
 * "key value" pair per line). The value may contain spaces (e.g.
 * user.name "John Doe"), so everything after the first space is the value.
 * Returns undefined when the key is absent or its value is empty.
 */
export function parseConfigRegexpValueForKey(
	raw: string | undefined,
	key: string,
): string | undefined {
	if (!raw) return undefined;
	for (const line of raw.split("\n")) {
		if (!line.startsWith(key + " ")) continue;
		const value = line.slice(key.length + 1);
		return value || undefined;
	}
	return undefined;
}

/** Used when neither config file defines any task. */
export const DEFAULT_TASKS: DoAlwaysTask[] = [
	{
		name: "Review changes",
		category: "Plan",
		description: "Review the current code changes (Plan)",
		requireDirty: true,
		notForCommits: true,
		prompt:
			"Review the changes on branch {{branch}} ({{files_changed_count}} changed files: {{files_changed}}). " +
			"Change summary: {{diff_stat}}. Last commit: {{last_commit}}. " +
			"Check `git status` and `git diff` to see what changed, then double-check the changes for bugs, " +
			"edge cases, security issues, and consistency with the rest of the codebase. " +
			"Do a plan proposal for the fixes if needed. Do a summary of your findings.",
	},
	{
		name: "Review code",
		category: "Plan",
		description: "Review the whole project's code quality (Plan)",
		notForCommits: true,
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
			"Update the project's README (e.g. README.md) to match the current state of the project. Check the code, scripts, and configuration, then update the README sections that are now out of date (description, installation, usage, configuration). Keep it concise and accurate.",
	},
	{
		name: "Build",
		category: "Do",
		description: "Test build is ok and fix issues",
		prompt:
			"Build the project (run the project's build command — e.g. `npm run build`, `cargo build`, `go build`, `make`, `mvn package`; find the build entry point — plus type check if available). If the build fails, diagnose the errors and fix them, then re-build until it succeeds. Summarize what was broken and what you changed.",
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
			"Prepare a release for this project (branch {{branch}}): check `git log` since the last tag, then bump the project's version to the next version in its version manifest (e.g. package.json, Cargo.toml, pyproject.toml, go.mod, pom.xml — find where the current version is declared), and add a changelog entry under that exact version summarizing the changes (in the project's changelog file, e.g. CHANGELOG.md). The changelog entry must use the same version number now set in the version manifest — never add a changelog section for a version the manifest does not yet contain, and never leave an 'Unreleased' or placeholder version heading. Create a git tag if git present. Do not push.",
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
		notForCommits: true,
		prompt:
			"Review this project and propose new features that would add value. For each idea, describe the problem it solves, the user benefit, and a rough implementation approach. Prioritize by impact and effort. Do not make any changes yet. Try to evaluate how many lines this will be in terms of changes, whether this will break APIs, or introduce compatibility issues.",
	},
	{
		name: "Review commits",
		category: "Plan",
		description: "Review the selected commits (Plan)",
		browser: "commits",
		hidden: true,
		prompt:
			"Review the selected commits: {{selected_commits}}. Inspect each with `git show <hash>`, " +
			"double-check the changes for bugs, edge cases, security issues, and consistency with the rest of the codebase. " +
			"Summarize your findings per commit and propose a plan for any fixes if needed. Do not make any changes yet.",
	},
	{
		name: "Browse commits",
		category: "Browse",
		description: "Browse and select commits, then pick a task to run on them",
		browser: "commits",
		when: "git",
		prompt: "Browse recent commits, select some, then pick a task to run on them.",
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
		return { tasks: [], shortcut: undefined, report: undefined, questionnaire: undefined, hidePlan: undefined, planNudge: undefined, aliases: undefined };
	}

	const list = Array.isArray(data) ? data : data?.tasks;

	if (!Array.isArray(list)) {
		onError(`do-always: ${path} must be a JSON array of tasks or {"tasks": [...]}`);
		return { tasks: [], shortcut: undefined, report: undefined, questionnaire: undefined, hidePlan: undefined, planNudge: undefined, aliases: undefined };
	}

	const tasks: DoAlwaysTask[] = [];
	for (const entry of list) {
		const t = entry as Partial<DoAlwaysTask> | null;
		if (t && typeof t.name === "string" && t.name.length > 0 && typeof t.prompt === "string" && (t.prompt.length > 0 || t.autoRun === true)) {
			const task: DoAlwaysTask = {
				name: t.name,
				prompt: t.prompt,
			};
				if (typeof t.description === "string") task.description = t.description;
				if (typeof t.category === "string" && t.category.trim() !== "") task.category = t.category.trim();
				if (typeof t.autoRun === "boolean") task.autoRun = t.autoRun;
				if (typeof t.requireDirty === "boolean") task.requireDirty = t.requireDirty;
				if (typeof t.hidden === "boolean") task.hidden = t.hidden;
				if (typeof t.notForCommits === "boolean") task.notForCommits = t.notForCommits;
				if (typeof t.questionnaire === "boolean") task.questionnaire = t.questionnaire;
				if (typeof t.hidePlan === "boolean") task.hidePlan = t.hidePlan;
				if (t.aliases !== undefined) {
					if (Array.isArray(t.aliases) && t.aliases.every((a) => typeof a === "string")) {
						task.aliases = t.aliases.filter((a) => a.trim() !== "");
					} else {
						onError(`do-always: ignoring invalid "aliases" in ${path} (expected an array of strings)`);
					}
				}
				if (t.browser !== undefined) {
					if (typeof t.browser === "string" && BROWSER_TYPES.includes(t.browser as BrowserType)) {
						task.browser = t.browser as BrowserType;
					} else {
						onError(`do-always: ignoring invalid "browser" in ${path} (expected one of: ${BROWSER_TYPES.join(", ")})`);
					}
				}
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
	let questionnaire: boolean | undefined;
	if (!Array.isArray(data) && "questionnaire" in data) {
		if (typeof data.questionnaire === "boolean") questionnaire = data.questionnaire;
		else onError(`do-always: ignoring invalid "questionnaire" in ${path} (expected true or false)`);
	}
	let hidePlan: boolean | undefined;
	if (!Array.isArray(data) && "hidePlan" in data) {
		if (typeof data.hidePlan === "boolean") hidePlan = data.hidePlan;
		else onError(`do-always: ignoring invalid "hidePlan" in ${path} (expected true or false)`);
	}
	let planNudge: boolean | undefined;
	if (!Array.isArray(data) && "planNudge" in data) {
		if (typeof data.planNudge === "boolean") planNudge = data.planNudge;
		else onError(`do-always: ignoring invalid "planNudge" in ${path} (expected true or false)`);
	}
	let aliases: Record<string, string> | undefined;
	if (!Array.isArray(data) && "aliases" in data) {
		if (typeof data.aliases === "object" && data.aliases !== null && !Array.isArray(data.aliases)) {
			const map: Record<string, string> = {};
			for (const [k, v] of Object.entries(data.aliases)) {
				if (typeof k === "string" && k.trim() !== "" && typeof v === "string") {
					map[k.trim()] = v.trim();
				}
			}
			if (Object.keys(map).length > 0) aliases = map;
		}
	}

	return { tasks, shortcut, merge, report, questionnaire, hidePlan, planNudge, aliases };
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
		const resolved = resolve(cwd, relativePath);
		// Containment check: reject paths that escape the project root.
		// `resolve` normalizes `..` sequences, so this catches
		// "../../.ssh/id_rsa" → "/home/user/.ssh/id_rsa" when cwd is "/home/user/project".
		if (!resolved.startsWith(cwd + sep) && resolved !== cwd) return false;
		return existsSync(resolved);
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

/**
 * Whether a task is visible in the selector and the lists: not `hidden` and
 * its `when` condition passes. Single source of truth so the TUI selector and
 * the `/do-always <n>` numbering can never diverge.
 */
export function isTaskVisible(task: DoAlwaysTask, ctx: TaskContext): boolean {
	return !task.hidden && evaluateWhen(task, ctx);
}

/** Default order for category headers in the selector. Exported for tests. */
export const DEFAULT_CATEGORY_ORDER = ["Plan", "Browse", "Do", "Docs", "Ops", "Other"];

/** A category group: a display name and the tasks that belong to it. */
interface TaskGroup {
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
 *
 * Not memoized: every caller passes a fresh array (selector open, config
 * load, list), so an identity-keyed cache would never hit — and would go
 * stale if a caller ever mutated its array in place. The input is small
 * (a dozen tasks), so recomputing is cheap.
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
	return isPlanTask(task);
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

/** Compiled regex cache: glob patterns are static config, so we memoize. */
const globRegexCache = new Map<string, RegExp>();

/** Convert a glob to an anchored RegExp (`**` -> `.*`, `*` -> `[^/]*`, `?` -> `[^/]`). */
function globToRegex(pattern: string): RegExp {
	let cached = globRegexCache.get(pattern);
	if (cached) return cached;
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
	cached = new RegExp(`^${out}$`);
	globRegexCache.set(pattern, cached);
	return cached;
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
	// Try aliases first (case-insensitive), then the task's own name.
	const lower = a.toLowerCase();
	const aliasMatch = tasks.find((t) => t.aliases?.some((alias) => alias.toLowerCase() === lower));
	if (aliasMatch) return aliasMatch;
	return tasks.find((t) => t.name.toLowerCase() === lower);
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
interface ChainState {
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
	// O(n) index map so find → O(1) lookup.
	const taskByName = new Map(tasks.map((t) => [t.name, t]));
	const parts = chain.items
		.map((name, i) => {
			const t = taskByName.get(name);
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

/** File name for one chain run's report, e.g. do-always-report-tasks-2025-01-15-1432.md. Exported for tests. */
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

/** Markdown footer for a chain that never reached a terminal path (e.g., the session ended mid-chain). */
export function reportAbandonedFooter(stepStatuses: string[], now: Date): string {
	const done = stepStatuses.filter((s) => s === "completed").length;
	const total = stepStatuses.length;
	const p = (n: number) => String(n).padStart(2, "0");
	const stamp = `${now.getFullYear()}-${p(now.getMonth() + 1)}-${p(now.getDate())} ${reportTime(now)}`;
	return `---\n\n**Chain abandoned:** ${stamp} — ${done}/${total} completed\n`;
}

/**
 * Whether a finished run's report file is worth keeping on disk: at least
 * one completed step, or some step section carried result text. A run that
 * produced neither (e.g. step 1 errored before any output, or the chain was
 * blocked before running) leaves no file behind — the failure is already
 * surfaced by the notification, and a quick same-minute retry would
 * otherwise get a `-N` sibling next to an empty report.
 */
export function reportWorthKeeping(stepStatuses: string[], hasContent: boolean): boolean {
	return hasContent || stepStatuses.some((s) => s === "completed");
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

// ── Chain step summary ───────────────────────────────────────────────────
//
// Compact per-step and chain-end summary strings for notifications.
// These are derived from the existing report data (outcome, timing, file count)
// and provide immediate, scannable feedback after each chain step.

/** Outcome of one chain step's run (see `sendAndWait`). */
export type ChainStepOutcome = "completed" | "aborted" | "error" | "failed-to-start";

/**
 * Generate a compact per-step summary string for notifications.
 * Examples:
 *   "✓ Build — 3 files changed — 2m14s"
 *   "✗ Tests — 45s"
 *   "⊘ Review changes"
 *
 * @param outcome      the step outcome
 * @param stepName     the task name
 * @param durationMs   how long the step took (0 if not timed)
 * @param fileCount    number of changed files after the step (0 if unknown)
 * @returns the summary string
 */
export function stepSummary(
	outcome: ChainStepOutcome,
	stepName: string,
	durationMs: number,
	fileCount: number,
): string {
	const marker = outcomeToMarker(outcome);
	const parts: string[] = [marker, stepName];
	if (fileCount > 0) {
		parts.push(`${fileCount} file${fileCount === 1 ? "" : "s"} changed`);
	}
	if (durationMs > 0) {
		parts.push(formatDuration(durationMs));
	}
	// Only add " — " separator when there are parts beyond marker+name.
	if (parts.length > 2) {
		return `${marker} ${stepName} — ${parts.slice(2).join(" — ")}`;
	}
	return `${marker} ${stepName}`;
}

/**
 * Generate a compact chain-end summary string, e.g.
 * "✅ 4/4 steps completed in 6m42s". Only reachable when every step
 * completed — the stop paths return early with their own per-step
 * notification, so `completed` always equals `total` here.
 */
export function chainSummary(completed: number, total: number, totalMs: number): string {
	const time = totalMs > 0 ? formatDuration(totalMs) : "";
	return `✅ ${completed}/${total} steps completed${time ? ` in ${time}` : ""}`;
}

/** Format milliseconds to a human-readable duration string. Exported for tests. */
export function formatDuration(ms: number): string {
	if (ms < 1000) return `${ms}ms`;
	const s = Math.floor(ms / 1000);
	if (s < 60) return `${s}s`;
	const m = Math.floor(s / 60);
	const rem = s % 60;
	return rem > 0 ? `${m}m${rem}s` : `${m}m`;
}

/** Map a step outcome to its display marker character. */
function outcomeToMarker(outcome: ChainStepOutcome): string {
	switch (outcome) {
		case "completed":
			return "✓";
		case "aborted":
			return "⊘";
		case "error":
			return "✗";
		case "failed-to-start":
			return "✗";
		default:
			// Exhaustive check: the type is a literal union, so this is unreachable.
			throw new Error(`unexpected outcome: ${outcome as string}`);
	}
}

// ── Commit browser types ─────────────────────────────────────────────────
//
// Types and constants for the date-grouped commit browser (used by
// the "Review commits" task in index.ts). Pure data — no Pi dependencies.

/** Maximum commits shown per page in the date-grouped browser. */
export const COMMIT_BROWSER_MAX = 20;

/** Maximum commits that can be selected for a review chain. */
export const COMMIT_SELECT_MAX = 20;

/** A single commit as returned by `git log --format`. */
export interface CommitInfo {
	/** Full 40-char SHA. */
	hash: string;
	/** Short 7-char SHA. */
	shortHash: string;
	/** Commit subject line. */
	subject: string;
	/** Commit date (YYYY-MM-DD). */
	date: string;
	/** Commit author name. */
	author: string;
	/** Number of files changed in this commit. */
	filesChanged: number;
	/** Insertions in this commit. */
	insertions: number;
	/** Deletions in this commit. */
	deletions: number;
}

/** A commit selected by the user for review. */
export interface SelectedCommit extends CommitInfo {
	/** 1-based position in the user's selection order. */
	selectionOrder: number;
}

/** Group of commits sharing the same date. */
export interface DateGroup {
	/** Date string (YYYY-MM-DD). */
	date: string;
	/** Number of commits in this group. */
	count: number;
	/** Commits in this group (newest first). */
	commits: CommitInfo[];
}

/**
 * Parse git log output formatted with:
 * `COMMIT%x09%H%x09%h%x09%s%x09%ad%x09%an` and optional `--shortstat`.
 */
export function parseGitLogOutput(output: string): CommitInfo[] {
	if (!output) return [];
	const commits: CommitInfo[] = [];
	let current: CommitInfo | null = null;
	for (const rawLine of output.split("\n")) {
		const line = rawLine.trim();
		if (line.startsWith("COMMIT\t")) {
			if (current) commits.push(current);
			const parts = line.split("\t");
			if (parts.length >= 6) {
				const hash = parts[1];
				const shortHash = parts[2];
				const date = parts[parts.length - 2];
				const author = parts[parts.length - 1];
				const subject = parts.slice(3, parts.length - 2).join("\t") || "(no subject)";
				current = {
					hash,
					shortHash,
					subject,
					date,
					author,
					filesChanged: 0,
					insertions: 0,
					deletions: 0,
				};
			} else {
				current = null;
			}
			continue;
		}
		if (current && line.includes("changed")) {
			const mFiles = line.match(/(\d+) file/);
			const mIns = line.match(/(\d+) insertion/);
			const mDel = line.match(/(\d+) deletion/);
			if (mFiles) current.filesChanged = Number(mFiles[1]);
			if (mIns) current.insertions = Number(mIns[1]);
			if (mDel) current.deletions = Number(mDel[1]);
		}
	}
	if (current) commits.push(current);
	return commits;
}

/** Group commits by date (preserving existing order within and between groups). */
export function groupCommitsByDate(commits: CommitInfo[]): DateGroup[] {
	const groups = new Map<string, CommitInfo[]>();
	for (const c of commits) {
		if (!groups.has(c.date)) groups.set(c.date, []);
		groups.get(c.date)!.push(c);
	}
	return [...groups.entries()].map(([date, groupCommits]) => ({
		date,
		count: groupCommits.length,
		commits: groupCommits,
	}));
}

/**
 * Format the selected commits as a numbered detail block (hash, subject,
 * author, date, stats per commit). Injected into task prompts via the
 * `{{selected_commits}}` placeholder; composed into the full review prompt by
 * `formatCommitReviewPrompt`.
 */
export function formatSelectedCommits(commits: SelectedCommit[]): string {
	const count = commits.length;
	return commits
		.map((c, i) => {
			const num = count > 1 ? `${i + 1}. ` : "";
			return (
				`${num}Commit ${c.shortHash} (${c.hash})\n` +
				`   Subject: ${c.subject}\n` +
				`   Author:  ${c.author} on ${c.date}\n` +
				`   Stats:   ${c.filesChanged} file${c.filesChanged !== 1 ? "s" : ""} changed, +${c.insertions}/-${c.deletions} lines`
			);
		})
		.join("\n\n");
}

/**
 * Build the review prompt for the selected commits to send to the agent.
 */
export function formatCommitReviewPrompt(commits: SelectedCommit[]): string {
	const count = commits.length;
	const commitDetails = formatSelectedCommits(commits);

	const showCmd = count === 1 ? `git show ${commits[0].hash}` : "git show <hash>";

	return (
		`Review the following git commit${count !== 1 ? "s" : ""}:\n\n` +
		`${commitDetails}\n\n` +
		`Please inspect the changes using \`${showCmd}\` (and any related files in the repository). ` +
		`Double-check the changes for:\n` +
		`1. Bugs, edge cases, potential regressions, and logic errors.\n` +
		`2. Code quality, security, and unintended side effects.\n` +
		`3. Consistency with surrounding project patterns and tests.\n\n` +
		`Summarize your findings for each commit and propose a plan for any fixes if needed. Do not make changes yet.`
	);
}

// ── Plan proposal ────────────────────────────────────────────────────────────
//
// Auto-run Plan tasks end their reply with a machine-readable plan block:
// a fenced code block tagged "plan" carrying the proposed action items as
// JSON (summary + tiers of items). PLAN_OUTPUT_INSTRUCTION is appended to
// Plan task prompts at render time so the agent emits the block; 
// parsePlanProposal extracts and normalizes it; the selection state machine
// and the execution prompt builder are pure so they can be unit-tested
// without the Pi runtime.

/**
 * Instruction appended to Plan-category task prompts at render time: it
 * requires the reply to end with a fenced "plan" code block containing the
 * proposed action items as JSON (summary + tiers of items). Kept in one
 * place so every Plan prompt shares the same contract.
 */
export const PLAN_OUTPUT_INSTRUCTION =
	"Plan block (required):\n" +
	"End your reply with a fenced code block tagged plan (\`\`\`plan) containing ONLY the JSON object — nothing else:\n" +
	'{"summary":"one-line summary","tiers":[{"id":"P0","label":"Critical","items":[{"title":"short action","detail":"where and why (file:line if known)"}]}]}\n' +
	"Rules:\n" +
	"- One tier per priority level, most urgent first (P0, P1, P2, …)\n" +
	"- Each item must be one concrete, independently doable action\n" +
	"- Use an empty \"tiers\" array when no action is needed\n" +
	"- The fenced block must contain ONLY the JSON — no explanation, no comments, no text after the closing }\n" +
	"- The plan block must be the very last thing in your reply\n";

/**
 * Follow-up sent when a completed auto-run Plan task's reply has no usable
 * plan block (none at all — the model wrote the plan as plain prose — or
 * malformed JSON the lenient parser could not recover). The agent has just
 * done the work, so asking it to format its findings into the block is a
 * short, reliable turn; the nudge run's reply goes through the same
 * capture → parse → questionnaire flow as the original run. Sent at most
 * once per auto-run (a second miss falls back to the plain summary).
 */
export const PLAN_NUDGE_PROMPT =
	"Your previous reply did not include the required plan block (or it was not valid JSON).\n" +
	"Based on your findings above, emit it now: end your reply with a fenced code block tagged plan (\`\`\`plan) containing ONLY the JSON object — nothing else:\n" +
	'{"summary":"one-line summary","tiers":[{"id":"P0","label":"Critical","items":[{"title":"short action","detail":"where and why (file:line if known)"}]}]}\n' +
	"Rules:\n" +
	"- One tier per priority level, most urgent first (P0, P1, P2, …)\n" +
	"- Each item must be one concrete, independently doable action\n" +
	"- Use an empty \"tiers\" array when no action is needed\n" +
	"- The fenced block must contain ONLY the JSON — no explanation, no comments, no text after the closing }\n" +
	"- The plan block must be the very last thing in your reply\n";

/**
 * Sample reply for `/do-always testplan`: a well-formed reply whose closed
 * "plan" block parses through the strict path. Lets the user dry-run the
 * plan questionnaire (parse → selection → execution prompt) without a real
 * Plan run or a model in the loop.
 */
export const TEST_PLAN_SAMPLE_OK =
	"Reviewed the changes. Two issues found: a race in the cache invalidation and a missing null check.\n\n" +
	"```plan\n" +
	'{"summary":"Fix cache race and null check in src/cache.ts","tiers":[{"id":"P0","label":"Critical","items":[{"title":"Fix cache invalidation race","detail":"src/cache.ts:42 — invalidate() can run between get() and set()"}]},{"id":"P1","label":"Important","items":[{"title":"Add null check for missing key","detail":"src/cache.ts:87 — throws when the key is absent"}]}]}\n' +
	"```\n";

/**
 * Sample reply for `/do-always testplan malformed`: the failure mode observed
 * in the wild — the fence is never closed, the JSON is cut off before the
 * root closing brace, and the reply ends with leaked tool-call XML tags.
 * Parses only through the lenient path (unclosed fence + auto-closed braces);
 * its unclosed fence is stripped from the transcript like a closed one.
 */
export const TEST_PLAN_SAMPLE_MALFORMED =
	"Review finished. The plan:\n\n" +
	"```plan\n" +
	'{"summary":"Fix 2 test failures and remove dead code","tiers":[{"id":"P0","label":"Critical","items":[{"title":"Fix stale timestamp test","detail":"test_mocap.py:619 — pass with_cap=False to restore the old phase boundaries"},{"title":"Align the 5 divergent version strings","detail":"mocap_core.py:55 says 1.2.0, fake_mocap_stream.py:41 says 1.4.0"}]},{"id":"P1","label":"High","items":[{"title":"Remove unused CaptorPlacement class","detail":"mocap_core.py:290-300 — built at import but never consumed"}]}]\n' +
	"</parameter>\n" +
	"</function>\n" +
	"</tool_call>";

/** One concrete action item proposed by a Plan run. */
export interface PlanItem {
	/** Short action description. */
	title: string;
	/** Where and why — file:line, rationale (optional). */
	detail?: string;
}

/** A priority tier grouping action items (most urgent tier first). */
export interface PlanTier {
	/** Tier id as emitted by the agent (e.g. "P0"); defaulted by position when absent. */
	id: string;
	/** Human label (e.g. "Critical"); defaults to the id when absent. */
	label: string;
	/** The tier's action items, in the order the agent emitted them. */
	items: PlanItem[];
}

/** A parsed plan proposal: the agent's reply, normalized for selection. */
export interface PlanProposal {
	/** One-line summary from the block (undefined when absent or blank). */
	summary?: string;
	/** Tiers in the order the agent emitted them (most urgent first). */
	tiers: PlanTier[];
}

/** True when the task belongs to the Plan category (case-insensitive). */
export function isPlanTask(task: DoAlwaysTask): boolean {
	return (task.category ?? "").trim().toLowerCase() === "plan";
}

/**
 * Matches a closed fenced code block whose info string starts with "plan"
 * (case-insensitive, optional whitespace before "plan", e.g. ```plan, ```plan json, ```plan:json).
 */
const PLAN_CLOSED_FENCE_RE = /(?:```+|~~~+)[^\S\n]*plan\b[^\n]*\r?\n([\s\S]*?)[^\S\n]*(?:```+|~~~+)/gi;

/**
 * Extract all plan code block bodies from text. Handles closed fences as well as
 * unclosed fences at the end of the text (e.g. when an LLM truncates or emits tool tags).
 */
export function extractPlanFences(text: string): { body: string; closed: boolean }[] {
	if (typeof text !== "string" || text === "") return [];
	const results: { body: string; closed: boolean }[] = [];
	const closedRe = new RegExp(PLAN_CLOSED_FENCE_RE.source, "gi");
	let lastEnd = 0;
	let match: RegExpExecArray | null;
	while ((match = closedRe.exec(text)) !== null) {
		results.push({ body: match[1], closed: true });
		lastEnd = match.index + match[0].length;
	}
	// Check for an unclosed fence after the last closed fence (or anywhere if no closed fences).
	const remainder = text.slice(lastEnd);
	const unclosedMatch = remainder.match(/(?:```+|~~~+)[^\S\n]*plan\b[^\n]*\r?\n([\s\S]*)$/i);
	if (unclosedMatch) {
		results.push({ body: unclosedMatch[1], closed: false });
	}
	return results;
}

/**
 * Matches a plan fence the reply never closed: the opening fence line plus
 * everything to the end of the text (the body is captured). After the closed
 * fences are removed, at most one such opening can remain, and its body runs
 * to the end of the text by construction.
 */
const PLAN_UNCLOSED_FENCE_RE = /(?:```+|~~~+)[^\S\n]*plan\b[^\n]*\r?\n([\s\S]*)$/i;

/**
 * Remove every fenced plan block from `text`, collapsing the blank lines
 * they leave behind and trimming the ends. The stripped text is what the
 * transcript shows (the message_end handler in index.ts replaces the
 * finalized message with it); the raw text is captured separately for the
 * questionnaire parser. A plan fence the reply never closed (the model
 * truncated the block or leaked tool-call XML into it) is removed through
 * the end of the text as well — the lenient parser reads it as the plan
 * block, so the transcript must not keep it — but only when its region
 * carries a parseable JSON object, so a prose mention of "```plan" mid-reply
 * cannot delete the rest of the text. `removed` is false when no plan fence
 * was present (the text is returned unchanged).
 */
export function stripPlanBlocks(text: string): { text: string; removed: boolean } {
	if (typeof text !== "string" || text === "") return { text, removed: false };
	if (!/(?:```+|~~~+)[^\S\n]*plan\b/i.test(text)) return { text, removed: false };
	const closedRe = new RegExp(PLAN_CLOSED_FENCE_RE.source, "gi");
	const matches = [...text.matchAll(closedRe)];
	let stripped = text;
	let removed = false;
	if (matches.length > 0) {
		stripped = stripped.replace(closedRe, "");
		removed = true;
	}
	const unclosed = stripped.match(PLAN_UNCLOSED_FENCE_RE);
	if (unclosed && parseLenientJson(unclosed[1]).error === null) {
		stripped = stripped.slice(0, unclosed.index);
		removed = true;
	}
	if (!removed) return { text, removed: false };
	const collapsed = stripped
		.replace(/\n{3,}/g, "\n\n")
		.replace(/^\s+/, "")
		.replace(/\s+$/, "");
	return { text: collapsed, removed: true };
}

/**
 * Escape literal newlines, carriage returns, and tabs that appear inside JSON
 * string literals (common when LLMs word-wrap long strings in output).
 */
function sanitizeJsonStrings(str: string): string {
	let inString = false;
	let escaped = false;
	let out = "";
	for (let i = 0; i < str.length; i++) {
		const ch = str[i];
		if (inString) {
			if (escaped) {
				out += ch;
				escaped = false;
			} else if (ch === "\\") {
				out += ch;
				escaped = true;
			} else if (ch === '"') {
				out += ch;
				inString = false;
			} else if (ch === "\n") {
				out += "\\n";
			} else if (ch === "\r") {
				out += "\\r";
			} else if (ch === "\t") {
				out += "\\t";
			} else {
				out += ch;
			}
		} else {
			if (ch === '"') {
				inString = true;
			}
			out += ch;
		}
	}
	return out;
}

/**
 * Extract a balanced JSON object from `str`, stripping leading/trailing non-JSON
 * text (such as XML tags `</parameter>` or explanatory notes). Auto-closes
 * missing root brackets/braces if the JSON was cut off at the end.
 */
function extractJsonObject(str: string): string | null {
	const start = str.indexOf("{");
	if (start === -1) return null;
	let inString = false;
	let escaped = false;
	const stack: string[] = [];
	let end = -1;

	for (let i = start; i < str.length; i++) {
		const ch = str[i];
		if (inString) {
			if (escaped) {
				escaped = false;
			} else if (ch === "\\") {
				escaped = true;
			} else if (ch === '"') {
				inString = false;
			}
		} else {
			if (ch === '"') {
				inString = true;
			} else if (ch === "{" || ch === "[") {
				stack.push(ch === "{" ? "}" : "]");
			} else if (ch === "}" || ch === "]") {
				if (stack.length > 0 && stack[stack.length - 1] === ch) {
					stack.pop();
				}
				if (stack.length === 0) {
					end = i;
					break;
				}
			}
		}
	}

	if (end !== -1) {
		return str.slice(start, end + 1);
	}
	if (stack.length > 0) {
		let candidate = str.slice(start);
		const tagMatch = candidate.search(/<\/?[a-zA-Z_-]+/);
		if (tagMatch !== -1) {
			candidate = candidate.slice(0, tagMatch);
		}
		candidate = candidate.trim();
		const subStack: string[] = [];
		inString = false;
		escaped = false;
		for (let i = 0; i < candidate.length; i++) {
			const ch = candidate[i];
			if (inString) {
				if (escaped) escaped = false;
				else if (ch === "\\") escaped = true;
				else if (ch === '"') inString = false;
			} else {
				if (ch === '"') inString = true;
				else if (ch === "{" || ch === "[") subStack.push(ch === "{" ? "}" : "]");
				else if (ch === "}" || ch === "]") {
					if (subStack.length > 0 && subStack[subStack.length - 1] === ch) subStack.pop();
				}
			}
		}
		if (inString) candidate += '"';
		return candidate + subStack.reverse().join("");
	}
	return null;
}

/**
 * Parse JSON with fallbacks for common LLM quirks:
 * 1. Direct JSON.parse
 * 2. Extracting { ... } ignoring trailing tags/prose and auto-closing missing braces
 * 3. Sanitizing literal newlines inside string literals
 */
function parseLenientJson(raw: string): { data: unknown; error: string | null } {
	try {
		return { data: JSON.parse(raw.trim()), error: null };
	} catch (err1) {
		const extracted = extractJsonObject(raw);
		if (extracted) {
			try {
				return { data: JSON.parse(extracted), error: null };
			} catch (err2) {
				try {
					const sanitized = sanitizeJsonStrings(extracted);
					return { data: JSON.parse(sanitized), error: null };
				} catch (err3) {
					const rawErr = err3 instanceof Error ? err3.message : String(err3);
					return { data: null, error: rawErr };
				}
			}
		}
		const rawErr = err1 instanceof Error ? err1.message : String(err1);
		return { data: null, error: rawErr };
	}
}

/**
 * Parse a plan proposal from a Plan run's reply text. Finds the fenced
 * "plan" code blocks, tries them from last to first (the agent may emit an
 * early malformed one and correct it), and returns the first that yields at
 * least one valid item. Returns null when there is no plan block, the JSON
 * is malformed, or nothing valid survives normalization — callers then fall
 * back to the plain summary notification.
 */
export function parsePlanProposal(text: string): PlanProposal | null {
	if (typeof text !== "string" || text === "") return null;
	const fences = extractPlanFences(text);
	for (let i = fences.length - 1; i >= 0; i--) {
		const proposal = normalizePlanJson(fences[i].body);
		if (proposal) return proposal;
	}
	return null;
}

/**
 * Why (or why not) a reply's plan block is usable for the questionnaire.
 * Mirrors parsePlanProposal's block precedence (last to first), so the
 * reported reason matches what the parser decided: "ok" is exactly the case
 * where parsePlanProposal returns a proposal.
 */
export type PlanBlockDiagnostic =
	| { kind: "none" } // no fenced plan block at all
	| { kind: "malformed"; detail: string } // the last block's JSON does not parse (detail: the parse error)
	| { kind: "empty" } // JSON parsed, but no valid items survived normalization
	| { kind: "ok"; itemCount: number };

export function planBlockDiagnostics(text: string): PlanBlockDiagnostic {
	if (typeof text !== "string" || text === "") return { kind: "none" };
	const fences = extractPlanFences(text);
	if (fences.length === 0) return { kind: "none" };
	let lastError: string | null = null;
	let parsedButEmpty = false;
	for (let i = fences.length - 1; i >= 0; i--) {
		const parsed = parseLenientJson(fences[i].body);
		if (parsed.error !== null) {
			// The loop runs last-to-first, so the first error seen is the
			// last block's — the agent's final answer, which is the one to
			// report. Strip the position suffix from JSON.parse errors
			// ("at position N (line L column C)") so the message is readable
			// in a large plan block where the position number is meaningless.
			if (lastError === null) {
				lastError = parsed.error.replace(/\s+at\s+position\s+\d+(?:\s*\(line\s+\d+\s+column\s+\d+\))?/, "");
			}
			continue;
		}
		const proposal = normalizePlanData(parsed.data);
		if (proposal) {
			const count = proposal.tiers.reduce((n, t) => n + t.items.length, 0);
			if (count > 0) return { kind: "ok", itemCount: count };
		}
		parsedButEmpty = true;
	}
	if (lastError !== null) return { kind: "malformed", detail: lastError };
	if (parsedButEmpty) return { kind: "empty" };
	return { kind: "malformed", detail: "invalid JSON" };
}

/**
 * Normalize one plan block's JSON body. Accepts the tiered shape
 * ({tiers: [{id, label, items: [...]}]}) and a lenient flat shape
 * ({items: [{tier, title, ...}]}, grouped preserving first-seen tier
 * order). Invalid entries are dropped; a result with no valid items is
 * null.
 */
function normalizePlanJson(raw: string): PlanProposal | null {
	const { data } = parseLenientJson(raw);
	return normalizePlanData(data);
}

function normalizePlanData(data: unknown): PlanProposal | null {
	if (typeof data !== "object" || data === null || Array.isArray(data)) return null;
	const obj = data as Record<string, unknown>;
	const summary =
		typeof obj.summary === "string" && obj.summary.trim() !== "" ? obj.summary.trim() : undefined;
	const tiers: PlanTier[] = [];
	if (Array.isArray(obj.tiers)) {
		obj.tiers.forEach((t, i) => {
			const tier = normalizePlanTier(t, i);
			if (tier) tiers.push(tier);
		});
	} else if (Array.isArray(obj.items)) {
		const byTier = new Map<string, PlanTier>();
		for (const entry of obj.items) {
			const item = normalizePlanItem(entry);
			if (!item) continue;
			const tierField =
				typeof entry === "object" && entry !== null
					? (entry as Record<string, unknown>).tier
					: undefined;
			const id = typeof tierField === "string" && tierField.trim() !== "" ? tierField.trim() : "P0";
			if (!byTier.has(id)) byTier.set(id, { id, label: id, items: [] });
			byTier.get(id)!.items.push(item);
		}
		for (const tier of byTier.values()) tiers.push(tier);
	}
	if (tiers.length === 0) return null;
	return { summary, tiers };
}

/** Normalize one tier entry; null when it carries no valid items. */
function normalizePlanTier(raw: unknown, index: number): PlanTier | null {
	if (typeof raw !== "object" || raw === null) return null;
	const obj = raw as Record<string, unknown>;
	const items: PlanItem[] = [];
	if (Array.isArray(obj.items)) {
		for (const entry of obj.items) {
			const item = normalizePlanItem(entry);
			if (item) items.push(item);
		}
	}
	if (items.length === 0) return null;
	const id = typeof obj.id === "string" && obj.id.trim() !== "" ? obj.id.trim() : `P${index}`;
	const label = typeof obj.label === "string" && obj.label.trim() !== "" ? obj.label.trim() : id;
	return { id, label, items };
}

/**
 * Normalize one item entry: a plain string is a title-only item; an object
 * needs a non-blank string "title" ("detail" is optional). Null otherwise.
 */
function normalizePlanItem(raw: unknown): PlanItem | null {
	if (typeof raw === "string") {
		const title = raw.trim();
		return title === "" ? null : { title };
	}
	if (typeof raw !== "object" || raw === null) return null;
	const obj = raw as Record<string, unknown>;
	const title = typeof obj.title === "string" ? obj.title.trim() : "";
	if (title === "") return null;
	const item: PlanItem = { title };
	const detail = typeof obj.detail === "string" ? obj.detail.trim() : "";
	if (detail !== "") item.detail = detail;
	return item;
}

// ── Plan questionnaire selection ─────────────────────────────────────────────
//
// The user's selection in the plan questionnaire: which item keys are
// checked. A key is "tierIndex:itemIndex" (0-based positions in the
// normalized proposal). Pure state — every operation returns a new Set,
// never mutating the input (same style as the chain state).

/** The checked item keys of one questionnaire. */
export type PlanSelection = Set<string>;

/** An empty selection. */
export function planSelectionClear(): PlanSelection {
	return new Set();
}

/** The selection key of one item (0-based tier and item positions). */
export function planItemKey(tierIndex: number, itemIndex: number): string {
	return `${tierIndex}:${itemIndex}`;
}

/** Toggle one item's membership. */
export function planToggleItem(selection: PlanSelection, key: string): PlanSelection {
	const next = new Set(selection);
	if (next.has(key)) next.delete(key);
	else next.add(key);
	return next;
}

/**
 * Toggle a whole tier: fully selected → clear all its items; none or
 * partial → select all of them. Returns the new selection and whether the
 * tier ended up selected. Unknown tier index: the selection is unchanged.
 */
export function planToggleTier(
	proposal: PlanProposal,
	tierIndex: number,
	selection: PlanSelection,
): { selection: PlanSelection; selected: boolean } {
	const tier = proposal.tiers[tierIndex];
	if (!tier) return { selection, selected: false };
	const keys = tier.items.map((_, i) => planItemKey(tierIndex, i));
	const allSelected = keys.every((k) => selection.has(k));
	const next = new Set(selection);
	if (allSelected) for (const k of keys) next.delete(k);
	else for (const k of keys) next.add(k);
	return { selection: next, selected: !allSelected };
}

/** Select every item in the proposal. */
export function planSelectAll(proposal: PlanProposal, selection: PlanSelection): PlanSelection {
	const next = new Set(selection);
	proposal.tiers.forEach((tier, ti) => {
		tier.items.forEach((_, ii) => next.add(planItemKey(ti, ii)));
	});
	return next;
}

/** One tier's aggregate state: no items, some, or all items selected. */
export function planTierState(
	proposal: PlanProposal,
	tierIndex: number,
	selection: PlanSelection,
): "none" | "partial" | "all" {
	const tier = proposal.tiers[tierIndex];
	if (!tier) return "none";
	let count = 0;
	tier.items.forEach((_, ii) => {
		if (selection.has(planItemKey(tierIndex, ii))) count++;
	});
	if (count === 0) return "none";
	if (count === tier.items.length) return "all";
	return "partial";
}

/** A selected item with its tier, for display and the execution prompt. */
export interface PlanSelectionEntry {
	tier: PlanTier;
	item: PlanItem;
	/** A user note added in the questionnaire for this item, if any. */
	note?: string;
}

/**
 * The selected items in execution order: tier order, item order within a
 * tier. Empty when nothing is selected. When `notes` is given, a non-empty
 * note for a selected item (keyed by planItemKey) is carried on the entry.
 */
export function planSelectedItems(
	proposal: PlanProposal,
	selection: PlanSelection,
	notes?: ReadonlyMap<string, string>,
): PlanSelectionEntry[] {
	const out: PlanSelectionEntry[] = [];
	proposal.tiers.forEach((tier, ti) => {
		tier.items.forEach((item, ii) => {
			const key = planItemKey(ti, ii);
			if (!selection.has(key)) return;
			const note = notes?.get(key)?.trim();
			out.push(note ? { tier, item, note } : { tier, item });
		});
	});
	return out;
}

/**
 * Build the follow-up prompt sent when the user confirms a questionnaire
 * selection. The proposal itself is already in the conversation (the Plan
 * run's reply), so the prompt references it and lists only the selected
 * items, in execution order.
 */
export function formatPlanExecutionPrompt(selected: PlanSelectionEntry[], taskName: string): string {
	const lines: string[] = [
		`Execute the following action items from the "${taskName}" plan proposal, in exactly this order. ` +
			"Do ONLY these items — skip every other item from the proposal, and do not start anything else. " +
			"When done, summarize what you changed.",
		"",
	];
	selected.forEach(({ tier, item, note }, i) => {
		lines.push(
			`${i + 1}. [${tier.id}] ${item.title}${item.detail ? ` — ${item.detail}` : ""}${note ? ` [note: ${note}]` : ""}`,
		);
	});
	return lines.join("\n");
}
