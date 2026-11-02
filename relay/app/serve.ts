/**
 * Serves the built hosted phone page on loopback for development and
 * verification: build once, then serve app/dist as a single-page app the way
 * the assets Worker does. Pair against a local relay with
 * `flywheel remote pair --relay ws://127.0.0.1:8787`.
 *
 * The page loads the client from the relay it pairs against, at
 * `http://127.0.0.1:8787/client/<runtimeId>/<identity>/phone/...`, which the
 * local relay serves from the development lane's own build. Nothing here
 * builds or serves a client, and phone development publishes nothing.
 */

import { join } from "node:path"

import { buildApp, DIST } from "./build.js"

await buildApp({ version: "dev" })

const server = Bun.serve({
  hostname: "127.0.0.1",
  port: Number(process.env.PORT ?? 8788),
  async fetch(request) {
    const url = new URL(request.url)
    const file = Bun.file(join(DIST, url.pathname === "/" ? "index.html" : url.pathname.slice(1)))
    if (await file.exists()) return new Response(file)
    return new Response(Bun.file(join(DIST, "index.html")))
  },
})

process.stdout.write(`Flywheel phone host: http://127.0.0.1:${server.port}\n`)
