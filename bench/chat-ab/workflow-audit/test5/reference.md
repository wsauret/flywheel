# Reference criteria: a safer tool-call argument repair

All line numbers refer to the fixture checkout: the public base commit `85c69871d` with the task's `sandbox.patch` applied. The five requested files are under `src/orchestration/agent-runtime/llm/`. This is not one required design. It lists the real risks that a strong answer finds and the behavior that a good design keeps. More than one design meets these criteria: a guard in the shared parser and a holdback in each adapter can both be correct.

## Real risks in the current repair

A strong answer names the first three risks with file:line evidence. The others are real but smaller.

1. The partial tier turns a cut prefix into a valid, shorter input. When the syntax scanner classifies a text as unfinished, `salvageJson` hands it to `tolerantParse`, which tries `partialParse` on the text and on its repaired form (`json-parse.ts:188-194`, `:199-209`). `partial-json` closes open strings and objects, so `{"path":"a.ts","content":"hel` becomes `{"path":"a.ts","content":"hel"}`, `{"path":"a.ts",` becomes `{"path":"a.ts"}`, and even `{"pa` becomes `{}`. `parseToolArguments` returns that object as `input` with no `parseError` (`json-parse.ts:158-160`), so the dispatcher runs the tool. A write or an edit can land truncated content. The task's `reference.patch` repairs this bug.
2. Every adapter emits the call before it knows the stop reason, and the loop starts the call at once. Anthropic parses and emits at `content_block_stop` (`anthropic.ts:739-760`), before `message_delta` reports `max_tokens` (`anthropic.ts:514-528`). Chat completions emits every call after the stream ends (`openai-completions.ts:512-526`), before it checks `finishReason` (`:535-544`). The loop dispatches each `tool_use` on arrival (`agent-loop.ts:538-543`, `agent-loop-tools.ts:416-445`), and its comment assumes that the input is complete (`agent-loop-tools.ts:436-441`). So a cut is known only after the tool has run.
3. Chat completions maps `finish_reason: "length"` to an ordinary `end_turn` stop (`openai-completions.ts:155`). The Anthropic adapter (`anthropic.ts:687-690`, `:525-528`) and the Responses path (`openai-helpers.ts:311-325`) raise `OutputLengthExceededError`, which the loop resumes (`agent-loop.ts:670-681`). On OpenRouter and Copilot a cut response is treated as finished.
4. Blank argument text returns `{ input: {} }` with no parse error (`json-parse.ts:156`). A call whose arguments never arrived runs with no input unless the tool's schema requires a field.
5. Repair changes content with no record. `repairJson` turns an invalid escape into a literal backslash (`json-parse.ts:76`) and doubles a dangling final backslash (`json-parse.ts:62`), and `ParsedToolArguments` (`json-parse.ts:126-129`) has no field that says a repair happened. A dangling final backslash is itself a sign of a cut.
6. Envelope stripping takes the first `{` or `[` through the last matching closer (`json-parse.ts:105-115`). Prose around the JSON that contains a brace can select the wrong span.
7. History keeps the shortened input as the call the model made. `healConversation` replays an `incomplete` turn (`heal-messages.ts:92`) and pairs its calls with their results (`heal-messages.ts:99-103`), so after a resume the model reads its own cut call with a successful result.

`openai-responses.ts` only prepares the Responses request (`openai-responses.ts:12-61`). It holds no repair code. An answer that proposes a parser change there has misread the file. The Responses stream calls the same parser in `openai.ts:279`.

## What a good design must keep

1. Complete calls run once, and run at once. A design that holds every call until the stop reason must not delay or drop a complete call, and it must still release the call when the stop reason is `tool_use`.
2. The repair tier for raw control characters and bad escapes (`json-parse.ts:40-97`). A complete call whose string carries an unescaped newline must still run once with that content.
3. Envelope stripping for fenced or wrapped JSON (`json-parse.ts:105-115`), unless the design gives a reason and a replacement.
4. The refusal path. `parseToolArguments` never throws, returns `{}` with a model-ready `parseError` that shows a bounded part of the raw text (`json-parse.ts:161`, `:352-380`), and the dispatcher turns it into an error result that tells the model to re-send (`tools/tool-dispatch.ts:241-251`). A cut call must reach the model as that kind of error, not as a silent drop.
5. The overflow resume on every wire: an output-length cut is an `OutputLengthExceededError` that the loop resumes (`agent-loop.ts:670-681`), and the chat-completions wire behaves the same as the others.
6. The history invariants in `heal-messages.ts`: every `tool_use` keeps exactly one result, so no provider rejects the next request.

## How to judge the size and the risk of a design

- The smallest correct design removes the tolerant tier, so the unfinished text that the syntax scanner already finds is refused with a parse error, and maps `length` to `OutputLengthExceededError`. It changes two source files, removes about 30 lines, and adds a few, and it fixes all three wires at once because they share the parser.
- An adapter holdback (keep each call until the stop reason shows no cut) is also correct. It touches every adapter and the release path, so it is larger and has more ways to delay or lose a complete call.
- A design that removes repair for complete input, adds a second parser for one wire, or fixes only the chat-completions adapter is worse. The last one leaves the direct Anthropic path running cut calls.
- A strong answer states how to test the design: a cut write on the Anthropic wire and on chat completions never runs with shortened content, and a complete write, including one with an unescaped newline, still runs once.
