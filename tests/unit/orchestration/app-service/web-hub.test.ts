import { describe, expect, spyOn, test } from "bun:test"

import {
  createAccountHubHandler,
  hubBindFailure,
  startAccountHub,
  type AccountHubProject,
} from "../../../../src/orchestration/app-service/web-serving/hub"
import { brandTileSvg } from "../../../../src/protocol/client/brand"
import { ServeStartupFailure } from "../../../../src/protocol/serve-handshake"

const request = (headers: HeadersInit = {}, path = "/") => new Request(`http://127.0.0.1:41000${path}`, { headers })

describe("the machine's project hub", () => {
  test("keeps reads nonmutating and admits only authenticated same-origin POST starts", async () => {
    let project: AccountHubProject = { id: "opaque-a", label: "alpha", projectRoot: "/work/alpha", state: "asleep" }
    let opens = 0
    const firstOpen = Promise.withResolvers<void>()
    const handler = createAccountHubHandler({
      lane: "installed",
      listProjects: async () => [project],
      openProject: async () => {
        opens += 1
        if (opens === 1) await firstOpen.promise
        const link = `http://127.0.0.1:43110/#token=${"c".repeat(48)}`
        project = { ...project, state: "open", link }
        return link
      },
      forgetProject: async () => {},
      credential: "a".repeat(48),
    }, "http://127.0.0.1:41000")
    const page = await handler(request())
    expect(page.status).toBe(200)
    expect(page.headers.get("Set-Cookie")).toContain("HttpOnly")
    expect(page.headers.get("Set-Cookie")).toContain("SameSite=Strict")
    expect(opens).toBe(0)
    expect((await handler(new Request("http://127.0.0.1:41000/", { method: "HEAD" }))).status).toBe(200)
    expect(opens).toBe(0)

    const rejected = await handler(new Request("http://127.0.0.1:41000/projects/opaque-a/open", {
      method: "POST",
      headers: { Origin: "http://127.0.0.1:41000", Cookie: `flywheel_hub=${"b".repeat(48)}` },
    }))
    // A stale page's post lands on a fresh list, so the browser's own Reload
    // reads the list again instead of re-posting the stale form.
    expect(rejected.status).toBe(303)
    expect(rejected.headers.get("Location")).toBe("/?notice=stale")
    expect(opens).toBe(0)
    const fresh = await handler(request({}, "/?notice=stale"))
    expect(fresh.headers.get("Set-Cookie")).toContain(`flywheel_hub=${"a".repeat(48)}`)
    const freshHtml = await fresh.text()
    expect(freshHtml).toContain("The project list was out of date")
    // The notice page starts nothing by itself, even for one asleep project.
    expect(freshHtml).not.toContain('src="/hub.js"')
    expect(await (await handler(request())).text()).toContain('src="/hub.js"')

    const accepted = await handler(new Request("http://127.0.0.1:41000/projects/opaque-a/open", {
      method: "POST",
      headers: { Origin: "http://127.0.0.1:41000", Cookie: `flywheel_hub=${"a".repeat(48)}` },
    }))
    expect(accepted.status).toBe(303)
    expect(accepted.headers.get("Location")).toBe("/projects/opaque-a/status")
    expect(opens).toBe(1)
    await handler(new Request("http://127.0.0.1:41000/projects/opaque-a/open", {
      method: "POST",
      headers: { Origin: "http://127.0.0.1:41000", Cookie: `flywheel_hub=${"a".repeat(48)}` },
    }))
    expect(opens).toBe(1)
    firstOpen.resolve()
    await firstOpen.promise
    await Promise.resolve()
    const ready = await handler(request({}, "/projects/opaque-a/status"))
    expect(ready.status).toBe(302)
    expect(ready.headers.get("Location")).toContain("#token=")
    expect((await handler(request())).headers.get("Location")).toContain("#token=")
    expect((await handler(new Request("http://127.0.0.1:41000/", { method: "HEAD" }))).headers.get("Location")).toContain("#token=")

    project = { id: "opaque-a", label: "alpha", projectRoot: "/work/alpha", state: "asleep" }
    const asleep = await handler(request())
    expect(asleep.status).toBe(200)
    expect(await asleep.text()).not.toContain("43110")
    await handler(new Request("http://127.0.0.1:41000/projects/opaque-a/open", {
      method: "POST",
      headers: { Origin: "http://127.0.0.1:41000", Cookie: `flywheel_hub=${"a".repeat(48)}` },
    }))
    expect(opens).toBe(2)
  })

  test.each(["failed", "unavailable"] as const)("uses canonical %s and later open state instead of retaining a failed hub attempt", async (state) => {
    let project: AccountHubProject = { id: "opaque-a", label: "alpha", projectRoot: "/work/alpha", state: "asleep" }
    const handler = createAccountHubHandler({
      lane: "installed",
      listProjects: async () => [project],
      openProject: async () => {
        project = { ...project, state, error: "could not start" }
        throw new Error("could not start")
      },
      forgetProject: async () => {},
      credential: "a".repeat(48),
    }, "http://127.0.0.1:41000")
    await handler(new Request("http://127.0.0.1:41000/projects/opaque-a/open", {
      method: "POST",
      headers: { Origin: "http://127.0.0.1:41000", Cookie: `flywheel_hub=${"a".repeat(48)}` },
    }))
    await Promise.resolve()
    expect(await (await handler(request({}, "/projects/opaque-a/status"))).text()).toContain("could not start")

    project = { ...project, state: "open", link: "http://127.0.0.1:43111/#token=fresh" }
    const attachedElsewhere = await handler(request({}, "/projects/opaque-a/status"))
    expect(attachedElsewhere.status).toBe(302)
    expect(attachedElsewhere.headers.get("Location")).toContain("fresh")
  })

  test("the address retries the one known project once when it failed to start, and a second failure shows the list", async () => {
    const project: AccountHubProject = { id: "opaque-a", label: "alpha", projectRoot: "/work/alpha", state: "failed", error: "could not start" }
    const handler = createAccountHubHandler({
      lane: "installed",
      listProjects: async () => [project],
      openProject: async () => { throw new Error("could not start") },
      forgetProject: async () => {},
      credential: "a".repeat(48),
    }, "http://127.0.0.1:41000")
    expect(await (await handler(request())).text()).toContain('src="/hub.js"')
    const failure = await (await handler(request({}, "/projects/opaque-a/status"))).text()
    expect(failure).toContain("could not start")
    const list = await (await handler(request({}, "/?notice=failed"))).text()
    expect(list).not.toContain('src="/hub.js"')
    expect(list).toContain("could not start")
    expect(list).toContain('aria-label="Retry alpha"')
  })

  test("renders duplicate labels and a branded script-free starting page", async () => {
    const projects: AccountHubProject[] = [
      { id: "a", label: "app", projectRoot: "/one/app", state: "starting" },
      { id: "b", label: "app", projectRoot: "/two/app", state: "failed", error: "release failed" },
      { id: "c", label: "closing", projectRoot: "/three/closing", state: "closing" },
    ]
    const handler = createAccountHubHandler({
      lane: "installed",
      listProjects: async () => projects,
      openProject: async () => "",
      forgetProject: async () => {},
      credential: "a".repeat(48),
    }, "http://127.0.0.1:41000")
    const html = await (await handler(request())).text()
    expect(html).toContain("/one/app")
    expect(html).toContain("/two/app")
    expect(html).toContain('http-equiv="refresh"')
    expect(html).not.toContain('src="/hub.js"')
    const starting = await (await handler(request({}, "/projects/a/status"))).text()
    expect(starting).toContain('http-equiv="refresh"')
    expect(starting).not.toContain("<script")
    expect(starting).toContain(brandTileSvg(96, { corners: "rounded", markClass: "brand-mark" }))
    expect(starting).toContain("<strong>Flywheel</strong>")
    expect(starting).toContain("Opening app.")
    expect(starting).toContain("--fw-bg:#1c1b19")
    expect(starting).toMatch(/--spin-offset:-\d+ms/)
    expect(starting).toContain("@media(prefers-reduced-motion:reduce)")
    expect(starting).toContain('<main><div class="loading" role="status"')
    // One state cue per row: the state names starting or closing, and the
    // control that is not available yet keeps its name.
    expect(html).not.toContain(">Starting</button>")
    expect(html).not.toContain(">Closing</button>")
    expect(html).toContain('aria-label="Open app (/one/app)" disabled aria-disabled="true"')
    expect(html).toContain('aria-label="Retry app (/two/app)"')
    expect(html).toContain('aria-label="Remove app (/two/app) from this list"')
    expect(html).toContain('aria-label="Open closing" disabled aria-disabled="true"')
    // Every row keeps a cell for Remove, so Open stays in one column.
    expect(html.match(/<span class="remove"><\/span>/g)?.length).toBe(2)
    const closing = await (await handler(request({}, "/projects/c/status"))).text()
    expect(closing).toContain('aria-label="Closing Flywheel"')
    expect(closing).toContain("Closing closing.")
  })

})

describe("removing a project from the list", () => {
  test("forgets an asleep or failed project through an authenticated same-origin post and returns to the list", async () => {
    let projects: AccountHubProject[] = [
      { id: "asleep-a", label: "alpha", projectRoot: "/work/alpha", state: "asleep" },
      { id: "open-b", label: "beta", projectRoot: "/work/beta", state: "open", link: "http://127.0.0.1:43110/#token=b" },
      { id: "failed-c", label: "gamma", projectRoot: "/work/gamma", state: "failed", error: "could not start" },
      { id: "unavailable-d", label: "delta", projectRoot: "/work/delta", state: "unavailable", error: "browser could not start" },
    ]
    const forgotten: string[] = []
    const handler = createAccountHubHandler({
      lane: "installed",
      listProjects: async () => projects,
      openProject: async () => "",
      forgetProject: async (id) => {
        forgotten.push(id)
        projects = projects.filter((project) => project.id !== id)
      },
      credential: "a".repeat(48),
    }, "http://127.0.0.1:41000")
    const post = (id: string, headers: HeadersInit = { Origin: "http://127.0.0.1:41000", Cookie: `flywheel_hub=${"a".repeat(48)}` }) =>
      handler(new Request(`http://127.0.0.1:41000/projects/${id}/forget`, { method: "POST", headers }))

    const html = await (await handler(request())).text()
    expect(html).toContain('action="/projects/asleep-a/forget"')
    expect(html).toContain('action="/projects/failed-c/forget"')
    expect(html).not.toContain('action="/projects/open-b/forget"')
    expect(html).not.toContain('action="/projects/unavailable-d/forget"')

    expect((await post("asleep-a", { Cookie: `flywheel_hub=${"a".repeat(48)}` })).headers.get("Location")).toBe("/?notice=stale")
    expect(forgotten).toEqual([])
    expect((await post("open-b")).status).toBe(409)
    expect((await post("unavailable-d")).status).toBe(409)
    expect(forgotten).toEqual([])
    expect((await post("missing")).headers.get("Location")).toBe("/?notice=gone")

    const removed = await post("asleep-a")
    expect(removed.status).toBe(303)
    expect(removed.headers.get("Location")).toBe("/?notice=removed")
    expect(forgotten).toEqual(["asleep-a"])
    expect(await (await handler(request())).text()).not.toContain("alpha")
    expect((await post("failed-c")).status).toBe(303)
    expect(forgotten).toEqual(["asleep-a", "failed-c"])
  })

  test("returns to the list without starting the one project that remains", async () => {
    let projects: AccountHubProject[] = [
      { id: "p1", label: "one", projectRoot: "/work/one", state: "asleep" },
      { id: "p2", label: "two", projectRoot: "/work/two", state: "asleep" },
    ]
    const handler = createAccountHubHandler({
      lane: "installed",
      listProjects: async () => projects,
      openProject: async () => "",
      forgetProject: async (id) => { projects = projects.filter((project) => project.id !== id) },
      credential: "a".repeat(48),
    }, "http://127.0.0.1:41000")
    const removed = await handler(new Request("http://127.0.0.1:41000/projects/p1/forget", {
      method: "POST",
      headers: { Origin: "http://127.0.0.1:41000", Cookie: `flywheel_hub=${"a".repeat(48)}` },
    }))
    const list = await (await handler(request({}, removed.headers.get("Location") ?? ""))).text()
    expect(list).toContain("Removed the project from this list.")
    expect(list).toContain("<strong>two</strong>")
    expect(list).not.toContain('src="/hub.js"')
    expect(list).not.toContain("data-auto-open")
  })
})

describe("the hub's browser posture", () => {
  test("keeps the browser's Origin on its own form posts and refuses an anonymous one", async () => {
    const handler = createAccountHubHandler({
      lane: "installed",
      listProjects: async () => [{ id: "opaque-a", label: "alpha", projectRoot: "/work/alpha", state: "asleep" }],
      openProject: async () => "",
      forgetProject: async () => {},
      credential: "a".repeat(48),
    }, "http://127.0.0.1:41000")
    // A `no-referrer` policy makes browsers send `Origin: null` on the page's
    // own same-origin form post, which the mutation check must refuse, so the
    // page that hosts the form must state a policy that keeps the origin.
    expect((await handler(request())).headers.get("Referrer-Policy")).toBe("same-origin")
    expect((await handler(request({}, "/projects/opaque-a/status"))).headers.get("Referrer-Policy")).toBe("same-origin")
    const anonymous = await handler(new Request("http://127.0.0.1:41000/projects/opaque-a/open", {
      method: "POST",
      headers: { Origin: "null", Cookie: `flywheel_hub=${"a".repeat(48)}` },
    }))
    expect(anonymous.headers.get("Location")).toBe("/?notice=stale")
  })

  test("carries the web client's tile as its icon so a bookmark shows it", async () => {
    const handler = createAccountHubHandler({
      lane: "installed",
      listProjects: async () => [{ id: "opaque-a", label: "alpha", projectRoot: "/work/alpha", state: "starting" }],
      openProject: async () => "",
      forgetProject: async () => {},
      credential: "a".repeat(48),
    }, "http://127.0.0.1:41000")
    const link = '<link rel="icon" href="/icon.svg" type="image/svg+xml">'
    expect(await (await handler(request())).text()).toContain(link)
    expect(await (await handler(request({}, "/projects/opaque-a/status"))).text()).toContain(link)
    const icon = await handler(request({}, "/icon.svg"))
    expect(icon.status).toBe(200)
    expect(icon.headers.get("Content-Type")).toBe("image/svg+xml")
    expect(await icon.text()).toBe(brandTileSvg(512, { corners: "rounded" }))
    expect((await handler(new Request("http://127.0.0.1:41000/icon.svg", { method: "POST" }))).status).toBe(405)
    // Over the wire, HEAD states the length GET sends.
    const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: handler })
    try {
      for (const path of ["/icon.svg", "/hub.js", "/"]) {
        const got = await fetch(`http://127.0.0.1:${server.port}${path}`)
        const head = await fetch(`http://127.0.0.1:${server.port}${path}`, { method: "HEAD" })
        expect(head.status).toBe(200)
        expect(head.headers.get("Content-Length")).toBe(String(new TextEncoder().encode(await got.text()).byteLength))
      }
    } finally {
      server.stop(true)
    }
  })

  test("keeps one theme, light or dark as the browser asks, from the list through a failed start", async () => {
    const handler = createAccountHubHandler({
      lane: "installed",
      listProjects: async () => [
        { id: "a", label: "alpha", projectRoot: "/work/alpha", state: "failed", error: "store unreadable" },
        { id: "b", label: "beta", projectRoot: "/work/beta", state: "asleep" },
      ],
      openProject: async () => "",
      forgetProject: async () => {},
      credential: "a".repeat(48),
    }, "http://127.0.0.1:41000")
    const list = await (await handler(request())).text()
    const failed = await (await handler(request({}, "/projects/a/status"))).text()
    for (const page of [list, failed]) {
      expect(page).toContain("@media(prefers-color-scheme:light){:root{--fw-bg:#f7f7f5")
      expect(page).toContain("background:var(--fw-bg)")
    }
    expect(failed).toContain('<p role="alert">store unreadable</p>')
    expect(failed).toContain('<a href="/?notice=failed">Return to projects.</a>')
  })
})

describe("the hub's fixed port", () => {
  // Bun.serve reports a port that another program holds with this error.
  test("names a port that another program holds as the start's refusal, and no other bind error", () => {
    const held = Object.assign(new Error("Failed to start server. Is port 41000 in use?"), { code: "EADDRINUSE", syscall: "listen" })
    const failure = hubBindFailure(held, 41000)
    expect(failure).toBeInstanceOf(ServeStartupFailure)
    expect(failure).toMatchObject({ message: held.message, refusal: { kind: "port-in-use", port: 41000 } })
    expect(hubBindFailure(Object.assign(new Error("Failed to start server"), { code: "EACCES" }), 41000)).toBeUndefined()
    expect(hubBindFailure(new Error("Failed to start server"), 41000)).toBeUndefined()
    expect(hubBindFailure("EADDRINUSE", 41000)).toBeUndefined()
  })

  // Bun.serve stands in for the bind, because the lanes' fixed ports belong
  // to the services that run on this machine.
  test.each([["installed", 41000], ["dev", 40999]] as const)("the %s lane's hub fails with its own port as the refusal when another program holds that port", (lane, port) => {
    const bind = spyOn(Bun, "serve").mockImplementation(() => { throw Object.assign(new Error(`Failed to start server. Is port ${port} in use?`), { code: "EADDRINUSE" }) })
    try {
      expect(() => startAccountHub({ lane, listProjects: async () => [], openProject: async () => "", forgetProject: async () => {}, credential: "a".repeat(48) }))
        .toThrow(expect.objectContaining({ name: "ServeStartupFailure", refusal: { kind: "port-in-use", port } }))
    } finally {
      bind.mockRestore()
    }
  })
})
