import { describe, it, expect, afterEach } from "bun:test"
import { createServer } from "../src/server/index"

describe("GET /hello", () => {
  let server: ReturnType<typeof createServer>

  afterEach(() => {
    if (server && "stop" in server) {
      ;(server as any).stop()
    }
  })

  it("returns 200 with JSON containing greeting and timestamp", async () => {
    server = createServer({ port: 0 })
    expect(server).toBeDefined()

    const s = server as Exclude<typeof server, undefined>
    const res = await fetch(`http://${s.hostname}:${s.port}/hello`)

    expect(res.status).toBe(200)
    expect(res.headers.get("Content-Type")).toContain("application/json")

    const body = await res.json()
    expect(body.greeting).toBe("Hello, World!")
    expect(typeof body.timestamp).toBe("string")
    expect(new Date(body.timestamp).toISOString()).toBe(body.timestamp)
  })

  it("returns correct body shape with greeting and timestamp fields", async () => {
    server = createServer({ port: 0 })
    const s = server as Exclude<typeof server, undefined>
    const res = await fetch(`http://${s.hostname}:${s.port}/hello`)
    const body = await res.json()

    expect(Object.keys(body).sort()).toEqual(["greeting", "timestamp"])
    expect(typeof body.greeting).toBe("string")
    expect(typeof body.timestamp).toBe("string")
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

describe("GET /healthz", () => {
  let server: ReturnType<typeof createServer>

  afterEach(() => {
    if (server && "stop" in server) {
      ;(server as any).stop()
    }
  })

  it("returns 200 with JSON { status: 'ok' }", async () => {
    server = createServer({ port: 0 })
    const s = server as Exclude<typeof server, undefined>

    const res = await fetch(`http://${s.hostname}:${s.port}/healthz`)
    expect(res.status).toBe(200)
    expect(res.headers.get("Content-Type")).toContain("application/json")

    const body = await res.json()
    expect(body).toEqual({ status: "ok" })
  })

  it("returns 405 for non-GET methods", async () => {
    server = createServer({ port: 0 })
    const s = server as Exclude<typeof server, undefined>

    const res = await fetch(`http://${s.hostname}:${s.port}/healthz`, { method: "POST" })
    expect(res.status).toBe(405)

    const body = await res.json()
    expect(body).toEqual({ error: "Method Not Allowed" })
  })
})

describe("server failure", () => {
  it("returns undefined when createServer fails (non-fatal)", () => {
    // Attempt to create two servers on the same port to trigger a failure
    const first = createServer({ port: 0 })
    expect(first).toBeDefined()

    const s = first as Exclude<typeof first, undefined>
    const second = createServer({ port: s.port })
    expect(second).toBeUndefined()

    ;(first as any).stop()
  })
})
