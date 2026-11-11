Review this completed change for user-facing copy and presentation.

CHANGE (uncommitted; review with `git diff -- <path>`):
src/infra/llm/provider-error-copy.ts (adds a sentence to the all-candidates-exhausted `message`: "<Provider> has a banked reset. Open Usage (/usage) to apply it.", appended after the existing recheck sentence, for providers refused for quota whose account holds an available banked reset)
tests/unit/infra/llm/provider-error-copy.test.ts
tests/unit/orchestration/agent-runtime/llm/failover-client-failover.test.ts

PROJECT CONTEXT PATHS:
docs/product-intent/model-access.md (PI-MODEL-006 Banked subscription usage resets; the new last sentence)
docs/product-intent/interaction.md (if it governs notices or command naming)

ASSIGNED CLAIMS:
1. "Existing copy names the place 'Usage' and the command '/usage'." Verify the slash command spelling and the Usage surface name in the TUI (src/tui/modules/subscription-usage/), the web client (webview/src/modules/subscription-usage/sheet.tsx), and the protocol (src/protocol/modules/subscription-usage.ts:382-411). Is '/usage' meaningful on web and phone, where the copy's other commands (/model, /auth) are already used?
2. "The sentence reads clearly after the existing message", e.g. "The eligible provider accounts for this model are out of quota or credits. A request after <time> can recheck provider availability. ChatGPT has a banked reset. Open Usage (/usage) to apply it." Judge clarity per ASD-STE100 Simplified Technical English and consistency with the existing copy's terms ("banked reset", "Apply reset").

DESIGN CONTEXT:
- Design intent (fixed): carried in your request context (approved unit B). The title stays "Out of credits"; no prediction whether the reset helps; interactive clients only.
- constraints: one sentence per provider; in `message` so all registers show it.
- recorded deviations: none for copy.

Check the change against the Design intent and the authorities as well as for defects; classify discrepancies as consistent or drift with evidence.

Use code-scope locations. Do not write files. Return prose findings, one block each with Title, Severity, Location, Failure (`<Principle name>. <Intent>. <Observation>. <Reasoning>.`), and Fix, or state No findings. The Design intent binds you; do not propose changing the title.