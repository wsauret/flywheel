# Flywheel web client

The web client is one SolidJS bundle that shows Flywheel sessions in a browser. It talks to the runtime only through the published client contract in `src/protocol/`, and it imports nothing else from `src/`. The client code is in `webview/src/`.

Three host shells mount the same bundle:

- `webview/local/`: the page that the runtime serves to a desktop browser.
- `webview/editor/`: the shell that the VS Code extension loads from the runtime's build.
- `webview/phone/`: the shell that the phone app loads from the machine through the relay.

`webview/build.ts` builds every shell into `webview/dist/<host>/`. `AGENTS.md` section 7 gives the module boundaries of the client, and the section "Where New Code Lives" in [docs/architecture.md](../docs/architecture.md#where-new-code-lives) tells you where each kind of client code goes.

## Check a change

Run these from the repository root:

```bash
bun run lint:webview   # the client's types, lint gates, and stylesheet rules
bun run test           # the unit suite, which includes the client's tests
```

The client keeps its unit tests beside the code, in `webview/src/`, `webview/local/`, and `webview/phone/`. The stylesheet gate allows colours, font sizes, z-indexes, and container widths only from `webview/src/styles/tokens.css` and its container-width ladder.

Before you change a client surface, read [the `webview-rendering` development skill](../src/orchestration/modules/development/definitions/skills/webview-rendering/SKILL.md). It tells you how to write UI that never flickers and never moves the reader.
