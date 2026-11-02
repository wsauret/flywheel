import { realpath, stat } from "node:fs/promises"
import { extname, isAbsolute, posix, relative, resolve, win32 } from "node:path"
import type { ControlUiAssetState } from "./control-ui-assets"
import { applyControlUiSecurityHeaders } from "./control-ui-csp"
import { respondNotFound, respondPlainText } from "./control-ui-http-utils"
import { classifyControlUiRequest } from "./control-ui-routing"
import { escapeHtml, renderFlywheelPage, renderLoadingCard } from "./flywheel-page"

const IMMUTABLE_CACHE_CONTROL = "public, max-age=31536000, immutable"
const HTML_CONTENT_TYPE = "text/html; charset=utf-8"
const CONTENT_TYPES = new Map<string, string>([
  [".html", HTML_CONTENT_TYPE],
  [".js", "application/javascript; charset=utf-8"],
  [".css", "text/css; charset=utf-8"],
  [".json", "application/json; charset=utf-8"],
  [".map", "application/json; charset=utf-8"],
  [".svg", "image/svg+xml"],
  [".png", "image/png"],
  [".jpg", "image/jpeg"],
  [".jpeg", "image/jpeg"],
  [".gif", "image/gif"],
  [".webp", "image/webp"],
  [".ico", "image/x-icon"],
  [".txt", "text/plain; charset=utf-8"],
  [".webmanifest", "application/manifest+json; charset=utf-8"],
  [".woff2", "font/woff2"],
])

/** The content type the runtime serves a client file with, by its name. */
export function controlUiContentType(pathname: string): string {
  return CONTENT_TYPES.get(extname(pathname).toLowerCase()) ?? "application/octet-stream"
}

function secureHeaders(): Headers {
  return applyControlUiSecurityHeaders(new Headers())
}

/** Returns whether a decoded URL path is a safe root-relative artifact path. */
function isSafeRelativePath(pathname: string): boolean {
  if (!pathname || pathname.includes("\0") || isAbsolute(pathname) || win32.isAbsolute(pathname)) return false
  const normalized = posix.normalize(pathname)
  return normalized !== ".." && !normalized.startsWith("../")
}

async function resolveSafeFile(root: string, relativePath: string) {
  if (!isSafeRelativePath(relativePath)) return undefined
  const rootReal = await realpath(root).catch(() => undefined)
  if (!rootReal) return undefined
  const lexicalPath = resolve(rootReal, relativePath)
  const lexicalRelative = relative(rootReal, lexicalPath)
  if (lexicalRelative.startsWith("..") || isAbsolute(lexicalRelative)) return undefined
  const fileReal = await realpath(lexicalPath).catch(() => undefined)
  if (!fileReal) return undefined
  const canonicalRelative = relative(rootReal, fileReal)
  if (canonicalRelative.startsWith("..") || isAbsolute(canonicalRelative)) return undefined
  const metadata = await stat(fileReal).catch(() => undefined)
  return metadata?.isFile() ? { path: fileReal, size: metadata.size, mtimeMs: metadata.mtimeMs } : undefined
}

function fileHeaders(pathname: string, file: { size: number; mtimeMs: number }, immutable: boolean) {
  const originatedAt = Date.now()
  const lastModifiedMs = Math.floor(Math.min(file.mtimeMs, originatedAt) / 1_000) * 1_000
  const headers = secureHeaders()
  headers.set("Content-Type", controlUiContentType(pathname))
  headers.set("Cache-Control", immutable ? IMMUTABLE_CACHE_CONTROL : "no-cache")
  headers.set("Last-Modified", new Date(lastModifiedMs).toUTCString())
  headers.set("Content-Length", String(file.size))
  return { headers, lastModifiedMs }
}

function isUnmodified(request: Request, lastModifiedMs: number): boolean {
  const ifNoneMatch = request.headers.get("If-None-Match")
  if (ifNoneMatch !== null) return ifNoneMatch.trim() === "*"
  const value = request.headers.get("If-Modified-Since")
  if (!value) return false
  const since = Date.parse(value)
  return Number.isFinite(since) && since <= Date.now() && lastModifiedMs <= since
}

/** The answer while the client is still being built or located, and the
 *  terminal answer when it cannot be. A poller reads the status and the
 *  `Retry-After` header. A page load gets the same status in Flywheel's
 *  theme, and the preparing page reloads itself until the client is there. */
function unservedResponse(state: Exclude<ControlUiAssetState, { kind: "resolved" }>, page: boolean): Response {
  const headers = secureHeaders()
  headers.set("Cache-Control", "no-store")
  if (state.kind === "preparing") headers.set("Retry-After", "1")
  const status = state.kind === "preparing" ? 503 : 500
  if (!page) {
    return respondPlainText(status, state.kind === "preparing"
      ? "The web client is being prepared. Try again shortly."
      : `The web client is unavailable: ${state.error}`, headers)
  }
  headers.set("Content-Type", HTML_CONTENT_TYPE)
  return new Response(state.kind === "preparing"
    ? renderFlywheelPage({ title: "Flywheel", refreshSeconds: 1, body: renderLoadingCard("Starting Flywheel", "Preparing the web client.") })
    : renderFlywheelPage({
      title: "Flywheel",
      style: "main{max-width:42ch}h1{font-size:15px}",
      body: `<h1>The web client is unavailable</h1><p role="alert">${escapeHtml(state.error)}</p>`,
    }), { status, headers })
}

/** The local page, served fresh on every request so a browser always gets the
 *  identity of the build the runtime serves now. */
const PAGE_PATH = "local/index.html"

async function pageResponse(root: string, projectRoot: string): Promise<Response> {
  const file = await resolveSafeFile(root, PAGE_PATH)
  if (!file) return respondNotFound(secureHeaders())
  const headers = secureHeaders()
  headers.set("Content-Type", HTML_CONTENT_TYPE)
  headers.set("Cache-Control", "no-cache")
  // The server sends the headers of a HEAD answer alone, with the length
  // the GET body has.
  const body = (await Bun.file(file.path).text()).replace('id="root"', `id="root" data-input-scope="local:${Buffer.from(projectRoot).toString("base64url")}"`)
  return new Response(body, { status: 200, headers })
}

function fileResponse(request: Request, pathname: string, file: { path: string; size: number; mtimeMs: number }, immutable: boolean): Response {
  const { headers, lastModifiedMs } = fileHeaders(pathname, file, immutable)
  if (isUnmodified(request, lastModifiedMs)) {
    headers.delete("Content-Type")
    headers.delete("Content-Length")
    return new Response(null, { status: 304, headers })
  }
  if (request.method === "HEAD") return new Response(null, { status: 200, headers })
  return new Response(Bun.file(file.path), { status: 200, headers })
}

function decodePathname(pathname: string): string | undefined {
  try {
    return decodeURIComponent(pathname)
  } catch {
    return undefined
  }
}

/** Serves one fixed-root Control UI request with Bun Response primitives. A
 *  failed asset state is terminal and answers without `Retry-After`, so a
 *  poller stops instead of waiting out its deadline.
 *
 *  A bundle file is reachable only as `/client/<identity>/<path>`, and only
 *  under the identity this runtime serves: the identity in the path is the
 *  cache key, so the answer is immutable, and a page from another build asks
 *  under another identity, gets 404, and loads `/` again. The root serves the
 *  page and the files beside it (the manifest, the icons, the notices). */
export async function serveControlUiStatic(request: Request, state: ControlUiAssetState, projectRoot: string): Promise<Response> {
  const url = new URL(request.url)
  const route = classifyControlUiRequest({
    pathname: url.pathname,
    method: request.method,
    accept: request.headers.get("Accept"),
  })
  if (route.kind === "not-control-ui") return respondNotFound(secureHeaders())
  if (state.kind !== "resolved") return unservedResponse(state, route.kind === "serve" && route.spaFallback)

  if (route.kind === "client") {
    if (route.identity !== state.identity) return respondNotFound(secureHeaders())
    const decoded = decodePathname(route.path)
    if (decoded === undefined) return respondNotFound(secureHeaders())
    const file = await resolveSafeFile(state.root, decoded)
    if (!file) return respondNotFound(secureHeaders())
    return fileResponse(request, decoded, file, true)
  }

  const decoded = decodePathname(url.pathname)
  if (decoded === undefined) return respondNotFound(secureHeaders())
  const relativePath = decoded.slice(1)
  if (relativePath === "") return pageResponse(state.root, projectRoot)
  if (!relativePath.includes("/")) {
    const file = await resolveSafeFile(state.root, relativePath)
    if (file) return fileResponse(request, relativePath, file, false)
  }
  const knownAsset = extname(relativePath) !== "" && extname(relativePath).toLowerCase() !== ".html"
  if (!knownAsset && route.spaFallback) return pageResponse(state.root, projectRoot)
  return respondNotFound(secureHeaders())
}
