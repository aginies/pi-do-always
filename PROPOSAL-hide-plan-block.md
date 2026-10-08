# Proposal: hide the raw ```plan block from the visible transcript

**Status:** implemented (Option A) — see the `[Unreleased]` CHANGELOG entry
**Scope:** `extensions/pi-do-always/index.ts`, `extensions/pi-do-always/tasks.ts`

## Problem

Plan-category tasks (auto-run) get `PLAN_OUTPUT_INSTRUCTION` appended, which makes
the agent end its reply with a machine-readable fenced block:

````text
```plan
{"summary":"Feature roadmap for the next quarter...","tiers":[{"id":"P0",...}]}
```
````

The extension parses that block after the run to drive the selection
questionnaire — but the raw JSON blob stays in the visible transcript (and in the
persisted session file). It is pure machine noise for the user: long, ugly, and
redundant with the questionnaire that follows it.

Goal: keep the contract (the agent still emits the block, the extension still
parses it) but make it invisible in the transcript.

## Verified SDK mechanisms (pi 0.16)

Two relevant capabilities were checked against the installed
`@earendil-works/pi-coding-agent`:

1. **`message_end` replacement.** A `pi.on("message_end", …)` handler may return
   `{ message }` to replace the finalized message (the role must be preserved —
   the runner rejects anything else). In `agent-session.js`,
   `_replaceMessageInPlace` mutates the stored message object, so the
   replacement is visible to:
   - the in-memory transcript (what the model sees in later turns),
   - later `turn_end` / `agent_end` events,
   - session persistence (`SessionManager.appendMessage(event.message)`),
   - HTML exports.

   In other words: stripping at `message_end` is permanent and consistent
   everywhere.

2. **Custom tools with `renderCall` / `renderResult`.** A model-callable tool
   (see `examples/extensions/todo.ts`) renders its calls as a compact line in
   the transcript instead of raw text.

## Options

### Option A — strip the plan block at `message_end` (recommended)

The extension strips the fenced `plan` block(s) from the assistant message as it
finalizes, after first capturing the raw text for its own parsing.

- New pure helper in `tasks.ts`:

  ```ts
  /** Remove all fenced plan blocks; collapse the blank lines they leave behind. */
  export function stripPlanBlocks(text: string): { text: string; removed: boolean }
  ```

  Reuses the existing `PLAN_FENCE_RE`; removes every match (the parser already
  prefers last-to-first, so the agent may have emitted an early malformed block
  it corrected — all of it is noise); collapses 2+ consecutive blank lines.

- New handler in `index.ts`:

  ```ts
  pi.on("message_end", (event) => {
    if (event.message.role !== "assistant") return;
    const text = assistantText(event.message.content);
    if (!text.includes("```plan") || !pendingSummaryTask) return; // see scoping below
    pendingPlanRaw = text; // capture for the questionnaire (raw, unstripped)
    return { message: { ...event.message, content: stripContent(event.message.content) } };
  });
  ```

- **Capture move.** Today the reply is captured at `agent_end` from
  `lastAssistantMessage(event.messages)`. After the `message_end` replacement,
  those messages are already stripped (in-place mutation, verified above) — so
  the plan text must be captured at `message_end` instead. The `agent_end`
  handler then uses `pendingPlanRaw ?? assistantText(lastAssistant.content)`
  (the fallback keeps behavior safe if the capture is ever missed).

- **Scoping: only strip when the contract is in force.** Strip only while a
  single auto-run Plan task is pending (`pendingSummaryTask` set) *and* the
  task is a Plan task with the questionnaire enabled — the same gate as
  `renderTaskPrompt`, i.e. exactly the runs whose prompt carried
  `PLAN_OUTPUT_INSTRUCTION`. Chain-step prompts never carry the instruction, a
  non-Plan auto-run task's reply is never touched, and a user who asks the
  model to show a `plan`-tagged JSON block in a normal conversation keeps
  seeing it.
- **TUI-only strip.** The capture (raw text for the questionnaire) happens in
  every mode, but the message replacement is TUI-only: in non-TUI modes the
  block stays in the transcript so the model can resolve the item-number
  replies the notification offers.

- **Config.** New `hidePlan` flag, mirroring the existing `questionnaire`
  pattern: per-task `hidePlan` first, then global config `hidePlan`, default
  `true`. (`false` keeps today's behavior — useful for inspecting the JSON or
  piping the session file to other tooling.)

- **Execution prompt wording.** `formatPlanExecutionPrompt` currently says
  "from the \“task\” plan proposal **above**". After stripping, the proposal is
  no longer in the transcript. This is already safe — the prompt enumerates
  every selected item with title, detail, and note — but drop "above" so the
  model isn't told to look for something that isn't there.

#### Limitations (accepted)

- **Streaming:** the JSON still streams live into the view while the model
  generates it (`message_update` is not replaceable via the public API). Only
  the final transcript, scrollback, resume, and exports are clean. This is the
  main visible remnant; it is acceptable because the block is short-lived and
  the questionnaire replaces it immediately after.
- The block is gone from the persisted session file too. That is the point, but
  it means the raw JSON is no longer recoverable from the session after the run
  (the questionnaire + report file already carry the useful content).

### Option B — `submit_plan` custom tool (alternative contract)

Register a `submit_plan` tool (TypeBox schema: `summary?`,
`tiers: [{id?, label?, items: [{title, detail?}]}]`). The instruction becomes
"call `submit_plan` with the plan JSON"; the tool's `execute` stores the
proposal in memory and the questionnaire reads it from there. A custom
`renderCall` draws one compact dim line, e.g.
`📋 submit_plan — 5 items (P0: 2, P1: 3)`.

- **Pros:** the JSON never appears as text; schema-validated at the call
  boundary; the model can still reference its own tool call in history, so the
  "proposal above" reference stays valid; no message surgery.
- **Cons:** depends on the model reliably calling the tool — a real risk with
  the small local models this project targets (llama.cpp), which would silently
  break the questionnaire; the text-fence fallback would have to stay anyway
  (two parallel code paths); the tool call is still a visible transcript entry
  (albeit compact); more code (registration, schema, renderers).

### Option C — agent writes the plan to a file (rejected)

Have the agent write `.pi/do-always-plan.json` via the write tool; the
extension reads it after `agent_end`. Extra tool call, file clutter, same model
reliability risk as B, and the write call is visible too. Strictly worse.

## Recommendation

**Implement Option A now.** It is small, deterministic, model-agnostic (works
with any backend, including local llama.cpp models that are poor tool callers),
and touches only this extension. Option B remains a possible future
enhancement; the two are compatible — if a `submit_plan` tool is added later,
the text-fence strip simply becomes a no-op for runs that used the tool.

## Implementation sketch (Option A)

1. **`tasks.ts`**
   - `stripPlanBlocks(text)` as above (pure, exported for tests).
   - `PLAN_OUTPUT_INSTRUCTION`: unchanged (the agent still emits the block;
     hiding is post-hoc).
   - `formatPlanExecutionPrompt`: drop "above".
2. **`index.ts`**
   - Import `MessageEndEvent` from `@earendil-works/pi-coding-agent`.
   - `pendingPlanRaw: string | null` state; set in the new `message_end`
     handler, consumed in `agent_end` (single auto-run branch), cleared in
     `resetPendingSummary()` and at the end of `offerPlanProposal`'s flow.
   - `hidePlan` config: parse in `parseConfig` (per-task + global), resolve in
     `loadConfig` with the same project→global→default precedence as
     `questionnaire`; gate the strip on it (per-task value wins).
   - Strip only text parts of the content array (string content: strip the
     string).
3. **Tests (`test/tasks.test.ts`)**
   - `stripPlanBlocks`: no block → unchanged, `removed: false`; one block at
     the end / middle / start; multiple blocks (all removed); trailing prose
     after the block preserved; no double blank lines left behind; non-plan
     fences (```json, ```) untouched.
   - `parseConfig`: `hidePlan` per-task and global parsing + invalid-value
     warning.
   - `formatPlanExecutionPrompt`: no "above" in the output.

## Risks / open questions

| Risk | Assessment |
| --- | --- |
| Model emits the fence mid-message with prose after it | Only the fenced span is removed; prose survives. |
| Agent emits the block across two assistant messages (continuation) | Capture keeps the last fence-bearing message, matching today's "last assistant message" parse scope. |
| `message_end` handler error | Handler errors are reported by pi and the run continues; the strip is best-effort and the questionnaire still works (it parses the raw capture). |
| User wants the raw JSON for auditing | `hidePlan: false` restores today's behavior; the report file keeps the full step text for chains. |
| Streaming visibility | Accepted limitation (see Option A). |

**Effort:** small — roughly 60–100 lines of code plus tests, no SDK changes.
