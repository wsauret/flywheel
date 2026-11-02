import { describe, expect, test } from "bun:test"
import { mkdir, symlink, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { buildControlUiCspHeader } from "../../../../src/orchestration/app-service/web-serving/control-ui-csp"
import { classifyControlUiRequest } from "../../../../src/orchestration/app-service/web-serving/control-ui-routing"
import { serveControlUiStatic as serveProjectPage } from "../../../../src/orchestration/app-service/web-serving/control-ui-static"
import { temporaryDirectories } from "../../../helpers/directories"

const identity = "e".repeat(64)
const other = "f".repeat(64)

const temporaryDirectory = temporaryDirectories()
const serveControlUiStatic = (input: Request, state: Parameters<typeof serveProjectPage>[1]) => serveProjectPage(input, state, "/project")

/** A built client as the runtime finds it: the page and bundles under
 *  `local/`, the root files beside them. The root sits one level inside its
 *  temporary directory, so a file that a case writes beside the root is
 *  removed with that directory. */
async function makeRoot() {
  const root = join(temporaryDirectory("flywheel-web-static-"), "client")
  await mkdir(join(root, "local"), { recursive: true })
  await writeFile(join(root, "local", "index.html"), '<html><body><div id="root">Flywheel</div></body></html>')
  await writeFile(join(root, "local", "webview.js"), "console.log('asset')")
  await writeFile(join(root, "favicon.svg"), "<svg></svg>")
  return root
}

function resolved(root: string) {
  return { kind: "resolved", root, identity } as const
}

function request(pathname: string, init?: RequestInit) {
  return new Request(`http://127.0.0.1${pathname}`, init)
}

describe("Control UI browser security", () => {
  test("the policy allows only the served origin and its socket", () => {
    const csp = buildControlUiCspHeader()

    expect(csp).toContain("script-src 'self'")
    expect(csp).toContain("frame-ancestors 'none'")
    expect(csp).toContain("connect-src 'self'")
    expect(csp).not.toContain("ws:")
    expect(csp).not.toContain("https://")
    expect(csp).not.toContain("unsafe-eval")
  })
})

describe("fixed-root SPA routing", () => {
  test("uses HTML Accept negotiation only for missing SPA routes", () => {
    expect(classifyControlUiRequest({ pathname: "/sessions/1", method: "GET", accept: "text/html" })).toEqual({ kind: "serve", spaFallback: true })
    expect(classifyControlUiRequest({ pathname: "/sessions/1", method: "GET", accept: "application/json" })).toEqual({ kind: "serve", spaFallback: false })
    expect(classifyControlUiRequest({ pathname: "/sessions/1", method: "POST", accept: "text/html" })).toEqual({ kind: "not-control-ui" })
  })

  test("names a bundle file by the identity of the build it belongs to", () => {
    expect(classifyControlUiRequest({ pathname: `/client/${identity}/local/webview.js`, method: "GET" })).toEqual({ kind: "client", identity, path: "local/webview.js" })
    expect(classifyControlUiRequest({ pathname: `/client/${identity}`, method: "GET", accept: "text/html" })).toEqual({ kind: "serve", spaFallback: true })
    expect(classifyControlUiRequest({ pathname: "/client/not-an-identity/local/webview.js", method: "GET", accept: "application/json" })).toEqual({ kind: "serve", spaFallback: false })
  })
})

describe("Bun Response static serving", () => {
  test("serves a bundle under this runtime's identity with MIME, immutable cache, and security headers", async () => {
    const root = await makeRoot()
    const response = await serveControlUiStatic(request(`/client/${identity}/local/webview.js`), resolved(root))

    expect(response.status).toBe(200)
    expect(response.headers.get("content-type")).toBe("application/javascript; charset=utf-8")
    expect(response.headers.get("cache-control")).toBe("public, max-age=31536000, immutable")
    expect(response.headers.get("last-modified")).not.toBeNull()
    expect(response.headers.get("x-content-type-options")).toBe("nosniff")
    expect(await response.text()).toBe("console.log('asset')")
  })

  test("answers 404 for a bundle under another identity or outside the identity path", async () => {
    const root = await makeRoot()
    const stale = await serveControlUiStatic(request(`/client/${other}/local/webview.js`), resolved(root))
    const bare = await serveControlUiStatic(request("/local/webview.js"), resolved(root))
    const missing = await serveControlUiStatic(request(`/client/${identity}/local/missing.js`, { headers: { Accept: "text/html" } }), resolved(root))

    expect(stale.status).toBe(404)
    expect(bare.status).toBe(404)
    expect(missing.status).toBe(404)
  })

  test("serves the page from local/index.html without caching", async () => {
    const root = await makeRoot()
    const page = await serveControlUiStatic(request("/"), resolved(root))

    expect(page.status).toBe(200)
    expect(page.headers.get("content-type")).toBe("text/html; charset=utf-8")
    expect(page.headers.get("cache-control")).toBe("no-cache")
    const html = await page.text()
    expect(html).toContain("Flywheel")
    expect(html).toContain(`data-input-scope="local:${Buffer.from("/project").toString("base64url")}"`)
    const otherProject = await serveProjectPage(request("/"), resolved(root), "/other-project")
    expect(await otherProject.text()).not.toContain(`data-input-scope="local:${Buffer.from("/project").toString("base64url")}"`)
  })

  test("supports HEAD and Last-Modified revalidation", async () => {
    const root = await makeRoot()
    const head = await serveControlUiStatic(request("/favicon.svg", { method: "HEAD" }), resolved(root))
    const lastModified = head.headers.get("last-modified")!

    expect(head.status).toBe(200)
    expect(head.headers.get("content-length")).toBe(String(Buffer.byteLength("<svg></svg>")))
    expect(await head.text()).toBe("")

    const notModified = await serveControlUiStatic(request("/favicon.svg", { headers: { "If-Modified-Since": lastModified } }), resolved(root))
    expect(notModified.status).toBe(304)
    expect(notModified.headers.get("cache-control")).toBe("no-cache")
    expect(notModified.headers.get("last-modified")).toBe(lastModified)
  })

  test("falls back to the SPA only for HTML clients and never for missing assets", async () => {
    const root = await makeRoot()
    const spa = await serveControlUiStatic(request("/sessions/1", { headers: { Accept: "text/html" } }), resolved(root))
    const nonHtml = await serveControlUiStatic(request("/sessions/1", { headers: { Accept: "application/json" } }), resolved(root))
    const asset = await serveControlUiStatic(request("/assets/missing.js", { headers: { Accept: "text/html" } }), resolved(root))

    expect(spa.status).toBe(200)
    expect(spa.headers.get("content-security-policy")).toContain("script-src 'self'")
    expect(spa.headers.get("cache-control")).toBe("no-cache")
    expect(await spa.text()).toContain("Flywheel")
    expect(nonHtml.status).toBe(404)
    expect(asset.status).toBe(404)
  })

  test("rejects encoded traversal and files outside the repository root", async () => {
    const root = await makeRoot()
    const outside = join(root, "..", "outside-static-secret.txt")
    await writeFile(outside, "secret")
    await symlink(outside, join(root, "escape.txt"))

    for (const path of ["/%2e%2e/outside-static-secret.txt", "/..%2foutside-static-secret.txt", "/escape.txt", "/%00.txt"]) {
      const response = await serveControlUiStatic(request(path), resolved(root))
      expect(response.status, path).toBe(404)
      expect(await response.text()).not.toContain("secret")
    }
  })

  test("preparing is retryable and failed is terminal", async () => {
    const preparing = await serveControlUiStatic(request("/"), { kind: "preparing" })
    const failed = await serveControlUiStatic(request("/"), { kind: "failed", error: "the web client build exited 1" })

    expect(preparing.status).toBe(503)
    expect(preparing.headers.get("cache-control")).toBe("no-store")
    expect(preparing.headers.get("retry-after")).toBe("1")
    expect(failed.status).toBe(500)
    expect(failed.headers.get("retry-after")).toBeNull()
    expect(failed.headers.get("content-security-policy")).not.toBeNull()
    expect(await failed.text()).toContain("the web client build exited 1")
  })

  test("a page load while the client is prepared gets a themed page that retries by itself", async () => {
    const navigation = { headers: { Accept: "text/html,application/xhtml+xml" } }
    const preparing = await serveControlUiStatic(request("/session/s-1", navigation), { kind: "preparing" })
    expect(preparing.status).toBe(503)
    expect(preparing.headers.get("retry-after")).toBe("1")
    expect(preparing.headers.get("content-type")).toBe("text/html; charset=utf-8")
    const page = await preparing.text()
    expect(page).toContain('<meta http-equiv="refresh" content="1">')
    expect(page).toContain("background:var(--fw-bg)")
    expect(page).toContain("Preparing the web client.")

    const failed = await serveControlUiStatic(request("/", navigation), { kind: "failed", error: "the web client is not at /x/webview" })
    expect(failed.status).toBe(500)
    const failure = await failed.text()
    expect(failure).toContain("background:var(--fw-bg)")
    expect(failure).toContain('<p role="alert">the web client is not at /x/webview</p>')
    expect(failure).not.toContain('http-equiv="refresh"')

    // A script or asset request keeps the plain answer.
    const asset = await serveControlUiStatic(request("/icon.svg", { headers: { Accept: "image/*" } }), { kind: "preparing" })
    expect(asset.headers.get("content-type")).toBe("text/plain; charset=utf-8")
  })
})
