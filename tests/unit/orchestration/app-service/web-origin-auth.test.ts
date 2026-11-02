import { describe, expect, spyOn, test } from "bun:test"
import { readdirSync, readFileSync, statSync, writeFileSync } from "node:fs"
import * as asyncFs from "node:fs/promises"
import { dirname, join } from "node:path"
import { authorizeHubMutation, createHubMutationCredential, isServedOrigin } from "../../../../src/orchestration/app-service/web-serving/origin-check"
import {
  authorizeToken,
  generateToken,
  loadOrCreateToken,
} from "../../../../src/orchestration/app-service/web-serving/token-auth"
import { temporaryDirectories } from "../../../helpers/directories"

const served = "http://127.0.0.1:43110"

describe("local browser origin admission", () => {
  test("admits only the page the runtime served", () => {
    expect(isServedOrigin("http://127.0.0.1:43110", served)).toBe(true)
    expect(isServedOrigin(" HTTP://127.0.0.1:43110/ ", served)).toBe(true)
  })

  test("refuses a loopback page on any other port, whatever its host spelling", () => {
    // Another program on this machine is another origin: a dev server, an
    // editor's preview, or a second Flywheel runtime.
    expect(isServedOrigin("http://127.0.0.1:3000", served)).toBe(false)
    expect(isServedOrigin("http://localhost:43110", served)).toBe(false)
    expect(isServedOrigin("http://[::1]:43110", served)).toBe(false)
  })

  test("refuses a page from another site and a request with no Origin", () => {
    expect(isServedOrigin("https://example.com", served)).toBe(false)
    expect(isServedOrigin("http://192.168.1.20:43110", served)).toBe(false)
    expect(isServedOrigin("null", served)).toBe(false)
    expect(isServedOrigin("", served)).toBe(false)
    expect(isServedOrigin(null, served)).toBe(false)
    expect(isServedOrigin("not a url", served)).toBe(false)
  })

  test("requires the exact hub origin and an independently timing-safe cookie", () => {
    const credential = createHubMutationCredential()
    const headers = new Headers({
      Origin: "http://127.0.0.1:41000",
      Cookie: `flywheel_hub=${credential}`,
    })
    expect(authorizeHubMutation(headers, "http://127.0.0.1:41000", credential)).toBe(true)
    headers.set("Origin", "http://127.0.0.1:43110")
    expect(authorizeHubMutation(headers, "http://127.0.0.1:41000", credential)).toBe(false)
    headers.set("Origin", "http://127.0.0.1:41000")
    headers.set("Cookie", `flywheel_hub=${"0".repeat(48)}`)
    expect(authorizeHubMutation(headers, "http://127.0.0.1:41000", credential)).toBe(false)
    headers.delete("Origin")
    expect(authorizeHubMutation(headers, "http://127.0.0.1:41000", credential)).toBe(false)
  })
})

describe("local browser token authorization", () => {
  const temporaryDirectory = temporaryDirectories()

  test("generates a per-process 192-bit hex token", () => {
    const first = generateToken()
    const second = generateToken()

    expect(first).toMatch(/^[0-9a-f]{48}$/)
    expect(second).toMatch(/^[0-9a-f]{48}$/)
    expect(second).not.toBe(first)
  })

  test("accepts only the exact token, never an absent or empty one", () => {
    const expected = "a".repeat(48)

    expect(authorizeToken(expected, expected)).toBe(true)
    expect(authorizeToken(undefined, expected)).toBe(false)
    expect(authorizeToken("", expected)).toBe(false)
    expect(authorizeToken("b".repeat(48), expected)).toBe(false)
    expect(authorizeToken("a".repeat(47), expected)).toBe(false)
  })

  test("token acquisition remains pending without blocking its caller while the file read is pending", async () => {
    const file = join(temporaryDirectory("fw-web-token-pending-"), "p.web-token")
    const expected = generateToken()
    writeFileSync(file, `${expected}\n`)
    const release = Promise.withResolvers<string>()
    const read = spyOn(asyncFs, "readFile").mockReturnValueOnce(release.promise)
    try {
      let settled = false
      const pending = Promise.resolve(loadOrCreateToken(file)).then((token) => { settled = true; return token })
      await Promise.resolve()
      expect(read).toHaveBeenCalledWith(file, "utf8")
      expect(settled).toBe(false)
      release.resolve(`${expected}\n`)
      expect(await pending).toBe(expected)
    } finally {
      release.resolve(`${expected}\n`)
      read.mockRestore()
    }
  })

  test("a project's token is created once, owner-only, and reused on every later start", async () => {
    const file = join(temporaryDirectory("fw-web-token-"), "p.web-token")

    const first = await loadOrCreateToken(file)
    expect(first).toMatch(/^[0-9a-f]{48}$/)
    expect(readFileSync(file, "utf8")).toBe(`${first}\n`)
    if (process.platform !== "win32") expect(statSync(file).mode & 0o777).toBe(0o600)
    expect(await loadOrCreateToken(file)).toBe(first)

    // A file that does not hold a token is replaced, not trusted.
    writeFileSync(file, "not a token\n")
    const replaced = await loadOrCreateToken(file)
    expect(replaced).toMatch(/^[0-9a-f]{48}$/)
    expect(replaced).not.toBe(first)
    expect(await loadOrCreateToken(file)).toBe(replaced)
  })

  test("a token another start published first is adopted, and no staging file is left", async () => {
    const file = join(temporaryDirectory("fw-web-token-"), "p.web-token")
    const other = generateToken()
    writeFileSync(file, `${other}\n`)
    expect(await loadOrCreateToken(file)).toBe(other)
    expect(readdirSync(dirname(file))).toEqual(["p.web-token"])
  })

  test("two starts that repair a file holding no token at once agree on one token, and leave no staging file", async () => {
    // Each round gives the two repairs a fresh chance to interleave; a repair
    // that renamed over the file let each start keep its own token.
    const directory = temporaryDirectory("fw-web-token-")
    for (let round = 0; round < 20; round += 1) {
      const file = join(directory, `p${round}.web-token`)
      writeFileSync(file, "not a token\n")
      const [first, second] = await Promise.all([loadOrCreateToken(file), loadOrCreateToken(file)])
      const published = readFileSync(file, "utf8").trim()
      expect([first, second]).toEqual([published, published])
    }
    expect(readdirSync(directory)).toHaveLength(20)
  })

  test("a start that read a file holding no token adopts the token another start published before it repaired", async () => {
    const file = join(temporaryDirectory("fw-web-token-"), "p.web-token")
    writeFileSync(file, "not a token\n")
    const firstRead = Promise.withResolvers<string>()
    const read = spyOn(asyncFs, "readFile").mockReturnValueOnce(firstRead.promise)
    try {
      const pending = loadOrCreateToken(file)
      read.mockRestore()
      const other = await loadOrCreateToken(file)
      firstRead.resolve("not a token\n")
      expect(await pending).toBe(other)
      expect(readFileSync(file, "utf8")).toBe(`${other}\n`)
    } finally {
      firstRead.resolve("not a token\n")
      read.mockRestore()
    }
  })

  test("a repair removes the staging files a start that ended mid-write left, and no other project's", async () => {
    const directory = temporaryDirectory("fw-web-token-")
    const file = join(directory, "p.web-token")
    writeFileSync(file, "not a token\n")
    writeFileSync(`${file}.${crypto.randomUUID()}.tmp`, `${generateToken()}\n`)
    const otherStaging = `q.web-token.${crypto.randomUUID()}.tmp`
    writeFileSync(join(directory, otherStaging), `${generateToken()}\n`)
    const token = await loadOrCreateToken(file)
    expect(readFileSync(file, "utf8")).toBe(`${token}\n`)
    expect(readdirSync(directory).sort()).toEqual(["p.web-token", otherStaging])
  })

  test("the first token for a project creates its owner-only directory", async () => {
    // The dev lane's serve creates only its own rendezvous directory, while
    // the project's token lives in the installed lane's; the writer owns the
    // directory it writes into.
    const directory = join(temporaryDirectory("fw-web-token-"), "serve")
    const file = join(directory, "p.web-token")
    const token = await loadOrCreateToken(file)
    expect(readFileSync(file, "utf8")).toBe(`${token}\n`)
    if (process.platform !== "win32") expect(statSync(directory).mode & 0o777).toBe(0o700)
  })
})
