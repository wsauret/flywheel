Review this completed change.

CHANGE: uncommitted edits in `src/orchestration/chat/session.ts` (new `titleText(input)`, used by `markFirstMessageSent`), `src/orchestration/agent-runtime/tools/skill.ts` (one sentence added to `SCAN_THEN_LOAD_GUIDANCE`), and `tests/unit/orchestration/chat/chat-session.test.ts` (the "chat title from a command's turn" test). Diff them with `git diff HEAD -- <path>`. Other chats have uncommitted work in this tree, so look only at these three files.

PROJECT CONTEXT PATHS: AGENTS.md, docs/product-intent/interaction.md (PI-INTERACTION-041 on tab titles), docs/product-intent/agent-methods.md (PI-AGENT-038).

DESIGN CONTEXT:
- Intent: built-in commands such as `/experiment design <goal>` start a skill method by committing the rendered skill body as the turn's text, with `invocation {label, args}` (see `startMethod` in `src/orchestration/app-service/command-invoke-service.ts`). Live runs showed two defects. (1) The chat title came from the skill body: the tab showed "# Skill:", and the title model summarized about 8 KB of method text. (2) The model loaded the skill again although the turn already held it.
- Implementation: a turn with an invocation is now titled from what the person typed: the label, plus the args when present. The skill tool guidance now says that a skill whose `# Skill: <id>` block already appears in the conversation is loaded.
- Recorded deviation: the rule also applies to prompt-path commands such as `/papercuts`, which were titled from their prompt text ("Run the project papercut campaign."). They are now titled "/papercuts". The owning test was changed to cover a method turn.

Check the change against the intent and for defects. Classify the deviation as consistent or drift, with evidence. Confirm that every producer of `invocation` reaches this title path sensibly: built-in prompts, methods, and any other producer you find. Check that `titleText` is the simplest correct shape. Use `path:line` locations. Do not write files. Return prose findings, each with Title, Severity, Location, Failure, and Fix, or state No findings.