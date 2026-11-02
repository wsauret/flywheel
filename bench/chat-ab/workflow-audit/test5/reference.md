# Reference criteria: a safer tool-call argument repair

All line numbers refer to the fixture checkout, base commit `b6d62468`. The five requested files are under `src/orchestration/agent-runtime/llm/`. This is not one required design. It lists the real risks that a strong answer finds and the behavior that a good design keeps. More than one design meets these criteria: a guard in the shared parser and a holdback in each adapter can both be correct.

## Real risks in the current repair

A strong answer names the first three risks with file:line evidence. The others are real but smaller.

1. The partial tier turns a cut prefix into a valid, shorter input. `salvageJson` tries `partialParse` on each candidate and on its repaired form (`json-parse.ts:160-173`). `partial-json` closes open strings and objects, so `{"path":"a.ts","content":"hel` becomes `{"path":"a.ts","content":"hel"}`, `{"path":"a.ts",` becomes `{"path":"a.ts"}`, and even `{"pa` becomes `{}`. `parseToolArguments` returns that object as `input` with no `parseError` (`json-parse.ts:136-138`), so the dispatcher runs the tool. A write or an edit can land truncated content. The later fix `f77cd52b3` repaired this bug.
2. Every adapter emits the call before it knows the stop reason, and the loop starts the call at once. Anthropic parses and emits at `content_block_stop` (`anthropic.ts:659-678`), before `message_delta` reports `max_tokens` (`anthropic.ts:401-409`). Chat completions emits every call after the stream ends (`openai-completions.ts:484-498`), before it checks `finishReason` (`:507-516`). The loop dispatches each `tool_use` on arrival (`agent-loop.ts:533-537`, `agent-loop-tools.ts:404-427`), and its comment assumes that the input is complete (`agent-loop-tools.ts:418-421`). So a cut is known only after the tool has run.
3. Chat completions maps `finish_reason: "length"` to an ordinary `max_tokens` stop (`openai-completions.ts:145`). The Anthropic adapter (`anthropic.ts:607-610`, `:406-408`) and the Responses path (`openai-helpers.ts:299-301`) raise `OutputLengthExceededError`, which the loop resumes (`agent-loop.ts:642-646`). On OpenRouter and Copilot a cut response is treated as finished.
4. Blank argument text returns `{ input: {} }` with no parse error (`json-parse.ts:134`). A call whose arguments never arrived runs with no input unless the tool's schema requires a field.
5. Repair changes content with no record. `repairJson` turns an invalid escape into a literal backslash (`json-parse.ts:70`) and doubles a dangling final backslash (`json-parse.ts:56`), and `ParsedToolArguments` (`json-parse.ts:120-123`) has no field that says a repair happened. A dangling final backslash is itself a sign of a cut.
6. Envelope stripping takes the first `{` or `[` through the last matching closer (`json-parse.ts:99-109`). Prose around the JSON that contains a brace can select the wrong span.
7. History keeps the shortened input as the call the model made. `healConversation` replays an `incomplete` turn (`heal-messages.ts:92`) and pairs its calls with their results (`heal-messages.ts:99-103`), so after a resume the model reads its own cut call with a successful result.

`openai-responses.ts` only prepares the Responses request (`openai-responses.ts:12-59`). It holds no repair code. An answer that proposes a parser change there has misread the file. The Responses stream calls the same parser in `openai.ts:276`.

## What a good design must keep

1. Complete calls run once, and run at once. A design that holds every call until the stop reason must not delay or drop a complete call, and it must still release the call when the stop reason is `tool_use`.
2. The repair tier for raw control characters and bad escapes (`json-parse.ts:34-91`). A complete call whose string carries an unescaped newline must still run once with that content.
3. Envelope stripping for fenced or wrapped JSON (`json-parse.ts:99-109`), unless the design gives a reason and a replacement.
4. The refusal path. `parseToolArguments` never throws, returns `{}` with a model-ready `parseError` and a bounded raw snippet (`json-parse.ts:139-142`, `:183-188`), and the dispatcher turns it into an error result that tells the model to re-send (`tools/tool-dispatch.ts:227-236`). A cut call must reach the model as that kind of error, not as a silent drop.
5. The overflow resume on every wire: an output-length cut is an `OutputLengthExceededError` that the loop resumes (`agent-loop.ts:642-646`), and the chat-completions wire behaves the same as the others.
6. The history invariants in `heal-messages.ts`: every `tool_use` keeps exactly one result, so no provider rejects the next request.

## How to judge the size and the risk of a design

- The smallest correct design classifies a buffer that only `partial-json` accepts as incomplete and refuses it with a parse error, and maps `length` to `OutputLengthExceededError`. It changes two source files and about 40 added lines, and it fixes all three wires at once because they share the parser.
- An adapter holdback (keep each call until the stop reason shows no cut) is also correct. It touches every adapter and the release path, so it is larger and has more ways to delay or lose a complete call.
- A design that removes repair for complete input, adds a second parser for one wire, or fixes only the chat-completions adapter is worse. The last one leaves the direct Anthropic path running cut calls.
- A strong answer states how to test the design: a cut write on the Anthropic wire and on chat completions never runs with shortened content, and a complete write, including one with an unescaped newline, still runs once.
