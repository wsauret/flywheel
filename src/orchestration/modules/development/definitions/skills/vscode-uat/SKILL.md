---
description: Use when verifying the packaged VS Code extension in an isolated editor through CDP.
dependencies:
  - uat
---

# VS Code UAT

Input: extension acceptance criteria, source revision, the universal package, and a session scratch directory.

Compose generic UAT. Build the required VSIX. Allocate unique profile, extension, workspace, log, screenshot, marker, and dynamically selected CDP-port resources under the supplied scratch directory. Never use a fixed `/tmp` path, shared port, or personal editor profile. Launch only the isolated instance, install the exact VSIX, and prove reload with a fresh marker. Connect through CDP after bounded readiness. Rediscover element references after navigation or reload. Exercise each criterion through packaged extension UI, capture screenshots and extension-host or webview diagnostics, and prove recovery for one load-bearing failure path. Close only the isolated instance and clean owned resources.

Launch the editor binary directly with `--user-data-dir`, `--extensions-dir`, and `--remote-debugging-port`; the `code` command and `open -a` reuse the person's own instance. Keep the isolated HOME short, because a unix socket path over 104 bytes fails the extension's runtime connection on macOS. A DevTools endpoint that never answers and a refused screen capture leave the render unobserved: `bun run --cwd vscode e2e` then proves the stack, not the appearance, and the report says so. Client behaviour that does not depend on the editor host is proven with `webview-uat` first.

Stop when every criterion has a generic UAT status or the editor cannot be driven safely. Return VSIX identity, isolated-instance details, interactions, screenshots and logs, criterion statuses, recovery evidence, and cleanup state. Package, launcher, port, CDP, CSP, or extension-host failure returns `blocked` with diagnostics.