# User Testing

Testing surface, required testing skills/tools, and resource cost classification.

**What belongs here:** How to validate the mission output through its real user surface.

---

## Validation Surface

### Primary: verify-dispatcher script
- Path: `scripts/verify-dispatcher.ts`
- Run: `bun run scripts/verify-dispatcher.ts [--engine=claude|opencode] [--transport=sdk|cli] [--verbose]`
- Validates: dispatcher response, schema conformance, timing
- Saves artifacts to `.flywheel/verify-dispatcher/`

### Secondary: Unit tests
- Run: `bun test`
- Validates: command construction, config flow, parsing, error handling

### Tertiary: TUI via tmux
- The full TUI can be tested via tmux to verify end-to-end dispatcher flow
- Start: `tmux new-session -d -s flywheel -x 120 -y 40 'cd /Users/wsauret/Documents/GitHub/flywheel/flywheel-tui && bin/flywheel'`
- Test: `/start <description>` triggers the dispatcher as part of the pipeline
- Note: TUI testing requires real API calls and takes several minutes

## Validation Concurrency

### verify-dispatcher script
- Resource cost: minimal (one subprocess at a time)
- Max concurrent: 5 (limited by API rate limits, not local resources)

### bun test
- Resource cost: ~2GB RAM for full test suite
- Max concurrent: 1 (single bun test process)

### TUI via tmux
- Resource cost: ~500MB (TUI + spawned engine process)
- Max concurrent: 2 (but typically 1 for focused testing)
