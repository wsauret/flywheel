import assert from "node:assert/strict"
import { fileURLToPath } from "node:url"

import type { RuntimeConnection } from "../../../src/protocol/client/connection.js"
import type { ClientHandle, ClientHost } from "../host.js"
import { importBuiltModule } from "../test-support/import-built-module.js"
import type { RuntimeSession } from "./session.js"

// Only transport and rendering are replaced. The mount, reading place, and
// session owner run unchanged, so tests exercise the host-to-owner boundary.
// The stand-in app reads the reader's place as the transcript does, from the
// open session, following the tail with no rows opened.
const entrypoint = fileURLToPath(new URL("../index.ts", import.meta.url))
const build = await Bun.build({
  entrypoints: [entrypoint],
  target: "bun",
  conditions: ["browser"],
  plugins: [{
    name: "headless-client-host",
    setup(builder) {
      builder.onResolve({ filter: /^test-host$/ }, () => ({ path: "test-host", namespace: "fixture" }))
      builder.onLoad({ filter: /.*/, namespace: "fixture" }, () => ({
        contents: `
          export let connection;
          export let session;
          let onMismatch;
          export function registerMismatch(callback) { onMismatch = callback }
          export function mismatch() { onMismatch() }
          export function setConnection(value) { connection = value }
          export function App(props) {
            session = props.session
            props.readingPlace.track(() => props.session.sessionId === undefined ? undefined : { sessionId: props.session.sessionId, following: true, open: [] })
          }
        `, loader: "js",
      }))
      builder.onLoad({ filter: /[\\/]index\.ts$/ }, async ({ path }) => ({
        contents: `${await Bun.file(path).text()}\nexport { setConnection, session, mismatch } from "test-host";\nexport function mountForTest(host) { return mountClient({ ownerDocument: document, isConnected: false, addEventListener() {}, removeEventListener() {} }, { inputScope: "headless", inputStorage: { load: async () => undefined, save: async () => {}, consume: async () => {} }, ...host }) }`,
        loader: "ts",
      }))
      builder.onResolve({ filter: /\/connection\.js$/ }, ({ importer }) =>
        importer === entrypoint ? { path: "connection", namespace: "transport" } : undefined)
      builder.onLoad({ filter: /.*/, namespace: "transport" }, () => ({
        contents: 'import { connection, registerMismatch } from "test-host"; export function createRuntimeConnection(options) { registerMismatch(options.onClientMismatch); return connection }', loader: "js",
      }))
      builder.onLoad({ filter: /[\\/]app\.tsx$/ }, () => ({
        contents: 'export { App } from "test-host"', loader: "js",
      }))
      builder.onLoad({ filter: /[\\/]changes-content\.tsx$/ }, () => ({
        contents: 'export function ChangesContent() {}', loader: "js",
      }))
      builder.onLoad({ filter: /[\\/]actions\.ts$/ }, () => ({
        contents: 'export function createClientActions() { return { dispose() {} } }', loader: "js",
      }))
      builder.onResolve({ filter: /^solid-js\/web$/ }, () => ({ path: "render", namespace: "render" }))
      builder.onLoad({ filter: /.*/, namespace: "render" }, () => ({
        contents: 'export function render(view) { view(); return () => {} }', loader: "js",
      }))
    },
  }],
})
assert.equal(build.success, true, build.logs.map(String).join("\n"))
const artifact = build.outputs[0]
assert.ok(artifact)
export const headlessClient: {
  setConnection(connection: RuntimeConnection): void
  mismatch(): void
  mountForTest(host: ClientHost): ClientHandle
  readonly session: RuntimeSession
} = await importBuiltModule(artifact)
