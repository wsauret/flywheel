# Reference answer: how a malformed tool-call argument travels

All line numbers refer to the fixture checkout, base commit `b6d62468`. The five requested files are under `src/orchestration/agent-runtime/llm/`. Lines in other files show where the path leaves the five files.

## 1. The adapter buffers the argument text and streams a preview

Each wire adapter collects the argument text of a tool call as the provider streams it. Each adapter also forwards every fragment as a `tool_input_delta` event, so the transcript shows the raw arguments while they arrive, before any parse.

- `anthropic.ts:357-361`: `content_block_start` of a `tool_use` block opens a buffer in `toolInputBuffers` (`anthropic.ts:320`) and yields `tool_input_start`.
- `anthropic.ts:649-655`: each `input_json_delta` appends `partial_json` to the buffer and yields `tool_input_delta`.
- `openai-completions.ts:248-278` (`handleToolCallDelta`): each `delta.tool_calls` entry (`openai-completions.ts:431-443`) appends to `argumentsBuffer` (`:269`), keyed by stream index with an id fallback. It yields `tool_input_start` once the name is known (`:271-274`) and `tool_input_delta` for each later fragment (`:276`).
- `openai-responses.ts:12-59` only prepares the Responses request. It parses no stream. It replays history through `buildOpenAIResponseInput` (`:25-31`). The Responses stream is parsed in `openai.ts`, which calls the same parser per `function_call` item in `finishOutputItem` (`openai.ts:276`).

## 2. The adapter parses the buffer and emits `tool_use`

The adapter calls `parseToolArguments` when it decides that the call is finished:

- Anthropic: at `content_block_stop` (`anthropic.ts:391-393`, `handleAnthropicBlockStop` at `anthropic.ts:659-680`, parse at `:668`). This happens before `message_delta` reports the stop reason.
- Chat completions: after the stream ends, for every buffered call (`openai-completions.ts:484-498`). This happens before the adapter checks `finishReason` (`:507-516`).
- Responses: at each output item's completion (`openai.ts:276`).

Each emitted `tool_use` carries `input` and, when the parser set one, `inputParseError` (`anthropic.ts:675`, `openai-completions.ts:495`).

## 3. The shared parser decides the outcome (`json-parse.ts`)

`parseToolArguments` (`json-parse.ts:133-143`) never throws and always returns an object `input`:

1. Empty or blank text returns `{ input: {} }` with no parse error (`:134`).
2. `salvageJson` (`:148-175`) builds candidates: the raw text and, when it differs, the text with a Markdown fence or surrounding prose removed (`stripJsonEnvelope`, `:99-109`).
3. Tier 1 and tier 2 (`:153-159`): `parseJsonWithRepair` (`:83-91`) tries strict `JSON.parse`, then `repairJson` (`:34-78`), which escapes raw control characters inside strings (`:74`), turns an invalid escape into a literal backslash (`:70`), and doubles a dangling final backslash (`:56`).
4. Tier 3 (`:160-173`): `partialParse` from `partial-json`, on the candidate and on its repaired form. It closes open strings, arrays, and objects, so a cut prefix such as `{"path":"a.ts","content":"hel` becomes the valid object `{"path":"a.ts","content":"hel"}`.
5. An object result returns as `input` (`:136-138`). Any other result, or total failure, returns `input: {}` and a `parseError` that says why and quotes up to 600 characters of the raw text (`:139-142`, `rawSnippet` at `:183-188`).

So the parser has three outcomes. Repairable text becomes the intended object. A cut prefix becomes a shorter object that looks valid, with no error. Unparseable text, or a value that is not an object, becomes `{}` with an error.

## 4. The loop dispatches the call at once

The turn attempt hands each `tool_use` to the loop as it arrives (`assistant-turn-attempt.ts:224-225`). The loop's `canonicalizeToolCall` calls `dispatcher.onToolUse` (`agent-loop.ts:533-537`). `onToolUse` (`agent-loop-tools.ts:404-427`) prepares the call and starts it immediately. Its comment (`agent-loop-tools.ts:418-421`) assumes that a `tool_use` event means the full JSON input parsed. A stop reason that arrives later cannot stop a call that already ran.

`prepareToolCall` (`tools/tool-dispatch.ts:212-259`) refuses a call with `inputParseError` (`:227-236`). It returns the error result `Tool '<name>' was not executed: failed to parse tool arguments: <parseError>. Re-send the call with well-formed JSON arguments.` Otherwise it coerces and validates the input against the tool's schema (`:239-252`), so `{}` from blank text is refused only when the schema requires a field.

## 5. The stop reason arrives after the call started

- Anthropic: `message_delta` with `stop_reason: max_tokens` (`anthropic.ts:401-409`, mapping at `anthropic.ts:607-610`) throws `OutputLengthExceededError`. The loop treats it as an output overflow: it persists the partial turn as `incomplete` (`assistant-message-settlement.ts:44-45`), logs a warning, appends a resume instruction, and continues (`agent-loop.ts:642-646`).
- Chat completions (OpenRouter, Copilot): `finish_reason: "length"` maps to an ordinary `max_tokens` stop (`openai-completions.ts:145`) and a normal `done` (`:522`). The loop does not send the resume instruction. It treats the response as finished: it returns the results of the calls that ran to the model as for any tool turn, and a cut response with no tool call ends the turn. A stream that closes with no `finish_reason` throws a transient error (`:507-509`) after the calls were already emitted and started.
- Responses: an incomplete response throws `OutputLengthExceededError` (`openai-helpers.ts:299-301`), after `finishOutputItem` already emitted the call.

## 6. History keeps the call as the adapter parsed it (`heal-messages.ts`)

Before each later request, every converter runs `healConversation` (`heal-messages.ts:72-118`). It keeps an `incomplete` turn even though its stop reason is an error (`:92`). It pairs each `tool_use` with its result (`:99-103`, `:120-135`) and adds `No result provided` (`:155`), or an interrupted tombstone for an aborted turn (`:154`, `:54-70`), for a call without a result. It replaces a blank error result with a non-empty one (`:137-146`). The stored input is the parsed input: `{}` for a refused call, or the shortened object for a completed prefix. The model later reads that as the call it made.

## What the user finally sees

- Repairable text (raw newline, bad escape, fenced JSON): the tool runs once with the repaired input. The transcript shows an ordinary call and result, with no sign of the repair.
- Unparseable text or a non-object: the transcript shows the call with an error result that quotes the raw text. The model reads the same error and usually re-sends the call.
- Text cut by the output limit: partial-json completes the prefix, so the tool runs with shortened input and reports success. A write can land a truncated file. On the Anthropic and Responses wires the turn then continues through the overflow resume. On chat completions (OpenRouter, Copilot) the loop treats the cut response as finished, so no resume follows. In both cases the user sees a successful call and a truncated result, and no error says that the arguments were cut.
- Blank text: the tool runs with `{}`, or the schema check refuses it with a validation error.
