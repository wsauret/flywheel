---
type: research
feature: hello world endpoint
date: 2026-03-26
status: complete
---

## Codebase Map

Flywheel-tui is a **terminal UI application** built with Bun, OpenTUI + SolidJS. It has **no existing HTTP server infrastructure**.

```
src/
├── cli/index.ts       # Entry point — launches TUI only
├── cli/args.ts        # Always returns { command: "tui" }
├── config/loader.ts   # TOML config loader (flywheel.toml)
├── config/paths.ts    # .flywheel/ directory constants
├── tui/launcher.ts    # TUI startup
└── tui/app.tsx        # Root TUI component
```

```
bin/flywheel           # Shell wrapper: bun --conditions=browser
package.json           # Runtime: Bun, no HTTP deps
```

## Relevant Code

- `src/cli/index.ts:17-28` — `main()` initializes logger, then calls `runTUI()`. Only execution path.
- `src/cli/index.ts:34-43` — `runTUI()` calls `startTUI()` and blocks until shell exits.
- `src/cli/args.ts:24-28` — `parseArgs()` always returns `{ command: "tui" }`. No subcommands exist.
- `src/config/loader.ts:22-29` — `BoundariesSchema` includes `port_ranges` field — relevant for endpoint port selection.
- `src/config/loader.ts:52-80` — `FlywheelConfigSchema` defines all config options. No server/port config exists yet.
- `package.json:10-11` — `dev` and `start` scripts both launch the TUI.
- `src/utils/log.ts` — File-based logger used via `Log.create({ service: "name" })`.

## Patterns to Follow

1. **Bun runtime** — Use `Bun.serve()` for HTTP, not Express/Hono. Zero dependencies needed.
2. **Entry point pattern** — `src/cli/index.ts:main()` is the single entry. New server code should integrate here or alongside.
3. **Config via Zod** — All config is defined in `FlywheelConfigSchema` (`src/config/loader.ts:52`). New fields (port, host) should follow this pattern.
4. **TOML config** — Runtime settings go in `flywheel.toml` with env var overrides.
5. **File logger** — Use `Log` from `src/utils/log` for logging, not console.
6. **Module structure** — Each concern has its own directory under `src/`. A new server should live in `src/server/`.
7. **Testing** — Tests live in `tests/*.test.ts`, run with `bun test`.

## Constraints

- **Bun-only** — No Node-specific APIs. Use Bun built-ins (`Bun.serve`, `Bun.file`, etc.).
- **SolidJS condition** — The TUI requires `--conditions=browser`. HTTP server code must not depend on SolidJS and should work regardless of this flag.
- **No existing HTTP deps** — `package.json` has no HTTP framework. `Bun.serve()` is the zero-dep path.
- **TUI blocks** — `runTUI()` blocks until exit (`src/cli/index.ts:39`). A server must start before or alongside the TUI (non-blocking), or be a separate command.
- **Port boundaries** — Config already has `boundaries.port_ranges` which could inform port selection.

## Open Questions

1. **Standalone or alongside TUI?** — Should the endpoint run as a separate `flywheel serve` command, or start automatically when the TUI launches?
2. **Port configuration** — Should port/host be configurable via `flywheel.toml` and env vars?
3. **Scope** — Is this literally a `GET /hello` → `"Hello, World!"` endpoint, or a foundation for a broader API?
