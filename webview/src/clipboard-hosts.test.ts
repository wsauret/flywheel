import assert from "node:assert/strict"
import { test } from "node:test"
import { fileURLToPath } from "node:url"

const repositoryRoot = fileURLToPath(new URL("../../", import.meta.url))

test("every production web client host owns clipboard writing", async () => {
  const hosts: string[] = []
  const files = new Bun.Glob("{webview,relay,vscode}/**/*.tsx").scan({
    cwd: repositoryRoot,
    onlyFiles: true,
  })
  for await (const file of files) {
    const path = file.replaceAll("\\", "/")
    if (path.includes("/node_modules/") || path.includes("/dist/")) continue
    const source = await Bun.file(`${repositoryRoot}/${path}`).text()
    if (!source.includes("mountClient(")) continue
    hosts.push(path)
    assert.match(source, /writeClipboardText:\s*\(text\)\s*=>/)
  }
  assert.deepEqual(hosts.sort(), [
    "webview/editor/main.tsx",
    "webview/local/main.tsx",
    "webview/phone/main.tsx",
  ])
})
