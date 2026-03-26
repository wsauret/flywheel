import { describe, it, expect, afterEach } from "bun:test"
import { createServer } from "../src/server/index"

describe("GET /hello", () => {
  let server: ReturnType<typeof createServer>

  afterEach(() => {
    if (server && "stop" in server) {
      ;(server as any).stop()
    }
  })

  it("returns 200 with JSON greeting and timestamp", async () => {
    server = createServer({ port: 0 })
    expect(server).toBeDefined()

    const s = server as Exclude<typeof server, undefined>
    const res = await fetch(`http://${s.hostname}:${s.port}/hello`)

    expect(res.status).toBe(200)
    expect(res.headers.get("Content-Type")).toContain("application/json")

    const body = await res.json()
    expect(typeof body.greeting).toBe("string")
    expect(body.greeting).toBe("Hello, World!")

    // timestamp must be a valid ISO 8601 string
    expect(typeof body.timestamp).toBe("string")
    const parsed = new Date(body.timestamp)
    expect(parsed.toISOString()).toBe(body.timestamp)
  })
})

describe("unknown routes", () => {
  let server: ReturnType<typeof createServer>

  afterEach(() => {
    if (server && "stop" in server) {
      ;(server as any).stop()
    }
  })

  it("returns 404 with JSON error for non-/hello paths", async () => {
    server = createServer({ port: 0 })
    const s = server as Exclude<typeof server, undefined>

    const res = await fetch(`http://${s.hostname}:${s.port}/unknown`)
    expect(res.status).toBe(404)
    expect(res.headers.get("Content-Type")).toContain("application/json")

    const body = await res.json()
    expect(body).toEqual({ error: "Not Found" })
  })
})

describe("POST /hello", () => {
  let server: ReturnType<typeof createServer>

  afterEach(() => {
    if (server && "stop" in server) {
      ;(server as any).stop()
    }
  })

  it("returns 405 with JSON error for non-GET methods", async () => {
    server = createServer({ port: 0 })
    const s = server as Exclude<typeof server, undefined>

    const res = await fetch(`http://${s.hostname}:${s.port}/hello`, { method: "POST" })
    expect(res.status).toBe(405)
    expect(res.headers.get("Content-Type")).toContain("application/json")

    const body = await res.json()
    expect(body).toEqual({ error: "Method Not Allowed" })
  })
})
