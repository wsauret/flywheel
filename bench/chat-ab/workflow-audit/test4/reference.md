# Reference answer: how a malformed tool-call argument travels

All line numbers refer to the fixture checkout: the public base commit `85c69871d` with the task's `sandbox.patch` applied. The five requested files are under `src/orchestration/agent-runtime/llm/`. Lines in other files show where the path leaves the five files.

## 1. The adapter buffers the argument text and streams a preview

Each wire adapter collects the argument text of a tool call as the provider streams it. Each adapter also forwards every fragment as a `tool_input_delta` event, so the transcript shows the raw arguments while they arrive, before any parse.

- `anthropic.ts:480-485`: `content_block_start` of a `tool_use` block opens a buffer in `toolInputBuffers` (`anthropic.ts:437`) and yields `tool_input_start`.
- `anthropic.ts:729-735`: each `input_json_delta` appends `partial_json` to the buffer and yields `tool_input_delta`.
- `openai-completions.ts:271-307` (`handleToolCallDelta`): each `delta.tool_calls` entry (`openai-completions.ts:458-470`) appends to `argumentsBuffer` (`:294`), keyed by stream index with an id fallback. It yields `tool_input_start` once the name is known (`:298-303`) and `tool_input_delta` for each later fragment (`:305`).
- `openai-responses.ts:12-61` only prepares the Responses request. It parses no stream. It replays history through `buildOpenAIResponseInput` (`:27-33`). The Responses stream is parsed in `openai.ts`, which calls the same parser per `function_call` item in `finishOutputItem` (`openai.ts:279`).

## 2. The adapter parses the buffer and emits `tool_use`

The adapter calls the shared parser when it decides that the call is finished:

- Anthropic: at `content_block_stop` (`anthropic.ts:511-513`, `handleAnthropicBlockStop` at `anthropic.ts:739-760`, parse at `:748`). This happens before `message_delta` reports the stop reason. The parse goes through `parseAnthropicToolInput` (`anthropic-tool-input.ts:50-58`), which calls `parseToolArguments` (`:51`) and returns its result unchanged unless the parser reported an error or a declared parameter repeats.
- Chat completions: after the stream ends, for every buffered call (`openai-completions.ts:512-526`, parse at `:513`). This happens before the adapter checks `finishReason` (`:535-544`).
- Responses: at each output item's completion (`openai.ts:279`).

Each emitted `tool_use` carries `input` and, when the parser set one, `inputParseError` (`anthropic.ts:756`, `openai-completions.ts:523`).

## 3. The shared parser decides the outcome (`json-parse.ts`)

`parseToolArguments` (`json-parse.ts:155-162`) never throws and always returns an object `input`:

1. Empty or blank text returns `{ input: {} }` with no parse error (`:156`).
2. `salvageJson` (`:177-196`) builds candidates: the raw text and, when it differs, the text with a Markdown fence or surrounding prose removed (`stripJsonEnvelope`, `:105-115`).
3. Tier 1 and tier 2 (`:181-187`): `parseJsonWithRepair` (`:89-97`) tries strict `JSON.parse`, then `repairJson` (`:40-84`), which escapes raw control characters inside strings (`:80`), turns an invalid escape into a literal backslash (`:76`), and doubles a dangling final backslash (`:62`).
4. When neither tier accepts the text, the syntax scanner `findJsonSyntaxFault` (`:225-310`) classifies it. A text that ends with no syntax error before its end is `unfinished`, and it goes to tier 3 (`:188-189`, `:193-194`): `tolerantParse` (`:199-209`) runs `partialParse` from `partial-json` on the text and on its repaired form. It closes open strings, arrays, and objects, so a cut prefix such as `{"path":"a.ts","content":"hel` becomes the valid object `{"path":"a.ts","content":"hel"}`.
5. An object result returns as `input` (`:158-160`). Any other result returns `input: {}` and a `parseError` from `describeRejectedArguments` (`:161`, `:352-369`): a non-object value quotes up to 600 characters of the raw text (`rawSnippet` at `:377-380`), invalid JSON names the character where the syntax fails and shows the text around it, and an unfinished text that even the tolerant tier rejects shows its end.

So the parser has three outcomes. Repairable text becomes the intended object. A cut prefix becomes a shorter object that looks valid, with no error. Invalid text, or a value that is not an object, becomes `{}` with an error.

## 4. The loop dispatches the call at once

The turn attempt hands each `tool_use` to the loop as it arrives (`assistant-turn-attempt.ts:111-123`, `:120-121`). The loop's `canonicalizeToolCall` calls `dispatcher.onToolUse` (`agent-loop.ts:538-543`, `:540`). `onToolUse` (`agent-loop-tools.ts:416-445`) prepares the call and starts it immediately. Its comment (`agent-loop-tools.ts:436-441`) assumes that a `tool_use` event means the full JSON input parsed. A stop reason that arrives later cannot stop a call that already ran.

`prepareToolCall` (`tools/tool-dispatch.ts:226-262`) refuses a call with `inputParseError` (`:241-251`). It returns the error result `Tool '<name>' was not executed: failed to parse tool arguments: <parseError>. Re-send the call with well-formed JSON arguments.` Otherwise it coerces and validates the input against the tool's schema (`:252-261`), so `{}` from blank text is refused only when the schema requires a field.

## 5. The stop reason arrives after the call started

- Anthropic: `message_delta` with `stop_reason: max_tokens` (`anthropic.ts:514-528`, mapping at `anthropic.ts:687-690`) throws `OutputLengthExceededError`. The loop treats it as an output overflow: it persists the partial turn as `incomplete` (`assistant-message-settlement.ts:54-56`), logs a warning, appends a resume instruction, and continues (`agent-loop.ts:670-681`).
- Chat completions (OpenRouter, Copilot): `finish_reason: "length"` maps to an ordinary `end_turn` stop (`openai-completions.ts:155`) and a normal `done` (`:547`). The loop does not send the resume instruction. It treats the response as finished: it returns the results of the calls that ran to the model as for any tool turn, and a cut response with no tool call ends the turn. A stream that closes with no `finish_reason` throws a transient error (`:535-537`) after the calls were already emitted and started.
- Responses: an incomplete response throws `OutputLengthExceededError` (`openai-helpers.ts:311-325`), after `finishOutputItem` already emitted the call.

## 6. History keeps the call as the adapter parsed it (`heal-messages.ts`)

Before each later request, every converter runs `healConversation` (`heal-messages.ts:72-118`). It keeps an `incomplete` turn even though its stop reason is an error (`:92`). It pairs each `tool_use` with its result (`:99-103`, `:120-135`) and adds `No result provided` (`:155`), or an interrupted tombstone for an aborted turn (`:154`, `:54-70`), for a call without a result. It replaces a blank error result with a non-empty one (`:137-146`). The stored input is the parsed input: `{}` for a refused call, or the shortened object for a completed prefix. The model later reads that as the call it made.

## What the user finally sees

- Repairable text (raw newline, bad escape, fenced JSON): the tool runs once with the repaired input. The transcript shows an ordinary call and result, with no sign of the repair.
- Invalid text or a non-object: the transcript shows the call with an error result that describes the fault and quotes the raw text around it. The model reads the same error and usually re-sends the call.
- Text cut by the output limit: partial-json completes the prefix, so the tool runs with shortened input and reports success. A write can land a truncated file. On the Anthropic and Responses wires the turn then continues through the overflow resume. On chat completions (OpenRouter, Copilot) the loop treats the cut response as finished, so no resume follows. In both cases the user sees a successful call and a truncated result, and no error says that the arguments were cut.
- Blank text: the tool runs with `{}`, or the schema check refuses it with a validation error.
