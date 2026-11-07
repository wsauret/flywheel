import { afterEach, describe, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

const KNIP = fileURLToPath(new URL("../../../node_modules/.bin/knip", import.meta.url))
const KNIP_CONFIG = fileURLToPath(new URL("../../../knip.production.jsonc", import.meta.url))
const fixtures: string[] = []

function write(root: string, path: string, content: string): void {
  const file = join(root, path)
  mkdirSync(dirname(file), { recursive: true })
  writeFileSync(file, content)
}

function fixture(includeTestOnlyExport: boolean): string {
  const root = mkdtempSync(join(tmpdir(), "flywheel-knip-production-"))
  fixtures.push(root)
  write(root, "package.json", JSON.stringify({ name: "fixture", type: "module", main: "src/main.ts", workspaces: ["vscode"] }))
  write(root, "src/main.ts", "void import('./lazy.js'); import { registry } from './registry.js'; import { productionValue } from './test-only.js'; void registry; void productionValue\n")
  write(root, "src/lazy.ts", "export const lazyCommand = 'lazy'\n")
  write(root, "src/registry-entry.ts", "export const commandEntries = { run: () => 'run' }\n")
  write(root, "src/registry.ts", "import { commandEntries } from './registry-entry.js'; export const registry = { ...commandEntries }\n")
  write(root, "src/orchestration/app-service/worker-entry.ts", "globalThis.postMessage?.('ready')\n")
  write(root, "vscode/package.json", JSON.stringify({ name: "fixture-vscode", type: "module" }))
  write(root, "vscode/src/extension.ts", "/** @externalHost */ export function activate(): void {}\n")
  write(root, "vscode/webview/src/main.tsx", "document.body.textContent = 'ready'\n")
  write(root, "src/test-only.ts", `export const productionValue = true\n${includeTestOnlyExport ? "export const testOnly = true\n" : ""}`)
  if (includeTestOnlyExport) write(root, "tests/test-only.test.ts", "import { testOnly } from '../src/test-only.js'; void testOnly\n")
  return root
}

function sameFileExportFixture(): string {
  const root = fixture(false)
  write(root, "src/test-only.ts", "export const productionValue = true\nexport const internallyUsed = true\nvoid internallyUsed\n")
  return root
}

function entryExportFixture(): string {
  const root = fixture(false)
  write(root, "src/main.ts", "void import('./lazy.js'); import { registry } from './registry.js'; import { productionValue } from './test-only.js'; void registry; void productionValue\nexport const deadEntryExport = true\n")
  return root
}

async function runKnip(root: string): Promise<{ exitCode: number; output: string }> {
  const process = Bun.spawn([KNIP, "--config", KNIP_CONFIG, "--no-gitignore", "--no-config-hints"], { cwd: root, stdout: "pipe", stderr: "pipe", windowsHide: true })
  const [stdout, stderr, exitCode] = await Promise.all([new Response(process.stdout).text(), new Response(process.stderr).text(), process.exited])
  return { exitCode, output: stdout + stderr }
}

afterEach(() => {
  for (const root of fixtures.splice(0)) rmSync(root, { recursive: true, force: true })
})

describe("production Knip reachability", () => {
  test("rejects exports reached only by tests", async () => {
    const result = await runKnip(fixture(true))
    expect(result.exitCode).toBe(1)
    expect(result.output).toContain("testOnly")
  })

  test("rejects exports used only inside their defining production file", async () => {
    const result = await runKnip(sameFileExportFixture())
    expect(result.exitCode).toBe(1)
    expect(result.output).toContain("internallyUsed")
  })

  test("rejects exports declared by a production entry without a production consumer", async () => {
    const result = await runKnip(entryExportFixture())
    expect(result.exitCode).toBe(1)
    expect(result.output).toContain("deadEntryExport")
  })

  test("keeps lazy commands, registry spreads, worker, extension, and webview roots reachable", async () => {
    const result = await runKnip(fixture(false))
    expect(result).toEqual({ exitCode: 0, output: "" })
  })
})
