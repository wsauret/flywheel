import { Log } from "../utils/log"

const log = Log.create({ service: "server" })

export function createServer(opts: { port: number }): ReturnType<typeof Bun.serve> | undefined {
  try {
    return Bun.serve({
      port: opts.port,
      fetch(req) {
        const url = new URL(req.url)

        if (url.pathname === "/hello") {
          if (req.method !== "GET") {
            return Response.json({ error: "Method Not Allowed" }, { status: 405 })
          }
          return Response.json({
            greeting: "Hello, World!",
            timestamp: new Date().toISOString(),
          })
        }

        if (url.pathname === "/healthz") {
          if (req.method !== "GET") {
            return Response.json({ error: "Method Not Allowed" }, { status: 405 })
          }
          return Response.json({ status: "ok" })
        }

        return Response.json({ error: "Not Found" }, { status: 404 })
      },
    })
  } catch (err) {
    log.warn("failed to start server", { error: err instanceof Error ? err.message : String(err) })
    return undefined
  }
}
