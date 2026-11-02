import { afterEach, describe, expect, test } from "bun:test"

import { keepProjectAddresses, type ProjectAddresses, type ProjectAddressReading } from "../../../../src/orchestration/app-service/web-serving/project-addresses.js"

const ROOT = "/scratch/flywheel-addresses/app"
const HUB = "http://127.0.0.1:41000"

const kept: ProjectAddresses[] = []
afterEach(() => { for (const addresses of kept.splice(0)) addresses.stop() })

/** One known project whose reading the test sets, an address on an
 *  ephemeral port, and a record of every wake. */
function harness(initial: ProjectAddressReading = { kind: "asleep" }) {
  let reading = initial
  const listeners = new Set<(projectRoot: string) => void>()
  const wakes: string[] = []
  const addresses = keepProjectAddresses({
    listProjects: async () => [{ projectRoot: ROOT, label: "app <one>" }],
    reading: () => reading,
    watch: (listener) => {
      listeners.add(listener)
      return () => { listeners.delete(listener) }
    },
    wake: (projectRoot) => { wakes.push(projectRoot) },
    hubOrigin: HUB,
    port: () => 0,
  })
  kept.push(addresses)
  return {
    addresses,
    wakes,
    set(next: ProjectAddressReading) {
      reading = next
      for (const listener of listeners) listener(ROOT)
    },
    async origin(): Promise<string> {
      for (let attempt = 0; attempt < 50; attempt += 1) {
        const origin = addresses.origin(ROOT)
        if (origin !== undefined) return origin
        await Bun.sleep(1)
      }
      throw new Error("the address was never held")
    },
  }
}

const page = (origin: string, path = "/session/abc", site?: string) =>
  fetch(`${origin}${path}`, { headers: { Accept: "text/html", ...(site === undefined ? {} : { "Sec-Fetch-Site": site }) } })

describe("a known project's address while the project is not open", () => {
  test("a bookmark of an asleep project starts it and keeps reloading in the theme", async () => {
    const project = harness()
    const origin = await project.origin()
    const response = await page(origin)
    const body = await response.text()
    expect(response.status).toBe(503)
    expect(response.headers.get("Retry-After")).toBe("1")
    expect(body).toContain(`<meta http-equiv="refresh" content="1">`)
    expect(body).toContain("Starting app &lt;one&gt;.")
    expect(project.wakes).toEqual([ROOT])
  })

  test("the page's own client knocking at the socket starts the project, and another origin does not", async () => {
    const project = harness()
    const origin = await project.origin()
    expect((await fetch(`${origin}/socket`, { method: "POST", headers: { Origin: "http://127.0.0.1:1" } })).status).toBe(503)
    expect((await fetch(`${origin}/client/x/app.js`)).status).toBe(503)
    expect(project.wakes).toEqual([])
    expect((await fetch(`${origin}/socket`, { method: "POST", headers: { Origin: origin } })).status).toBe(503)
    expect(project.wakes).toEqual([ROOT])
  })

  test("another site cannot start a project by pointing at its address", async () => {
    const project = harness()
    const origin = await project.origin()
    expect((await page(origin, "/", "cross-site")).status).toBe(403)
    expect(project.wakes).toEqual([])
  })

  test("a project that failed to open says why and links to the list, without starting again", async () => {
    const project = harness({ kind: "failed", error: "The executor <exited>." })
    const origin = await project.origin()
    const body = await (await page(origin)).text()
    expect(body).toContain("The executor &lt;exited&gt;.")
    expect(body).toContain(`<a href="${HUB}/">Open the project list to retry.</a>`)
    expect(body).not.toContain("http-equiv")
    expect(project.wakes).toEqual([])
  })

  test("the project's endpoint takes the address over, and the address answers again once the project closes", async () => {
    const project = harness()
    const origin = await project.origin()
    project.set({ kind: "held" })
    expect(project.addresses.origin(ROOT)).toBe(origin)
    project.addresses.release(ROOT)
    expect(project.addresses.origin(ROOT)).toBeUndefined()
    await expect(fetch(origin)).rejects.toThrow()
    project.set({ kind: "asleep" })
    expect(await project.origin()).toStartWith("http://127.0.0.1:")
  })

  test("a project that is open is never given an address, and stop lets every address go", async () => {
    const open = harness({ kind: "held" })
    await Bun.sleep(5)
    expect(open.addresses.origin(ROOT)).toBeUndefined()
    const asleep = harness()
    const origin = await asleep.origin()
    asleep.addresses.stop()
    asleep.set({ kind: "asleep" })
    await Bun.sleep(5)
    expect(asleep.addresses.origin(ROOT)).toBeUndefined()
    await expect(fetch(origin)).rejects.toThrow()
  })
})
