/** Returns true for idempotent methods that can read static assets. */
export function isReadHttpMethod(method: string | undefined): boolean {
  return method === "GET" || method === "HEAD"
}

function accepts(range: string, expected: string): boolean {
  const [type = "", ...parameters] = range.trim().toLowerCase().split(";")
  const quality = parameters.find((parameter) => parameter.trim().startsWith("q="))
  if (quality && Number(quality.trim().slice(2)) === 0) return false
  if (type === "*/*") return true
  const [expectedType, expectedSubtype] = expected.split("/")
  const [rangeType, rangeSubtype] = type.split("/")
  return rangeType === expectedType && (rangeSubtype === "*" || rangeSubtype === expectedSubtype)
}

/** Returns whether an Accept header permits an HTML document response. */
export function acceptsControlUiHtmlResponse(accept: string | null | undefined): boolean {
  if (!accept?.trim()) return true
  return accept.split(",").some((range) => accepts(range, "text/html") || accepts(range, "application/xhtml+xml"))
}

/** Creates a plain UTF-8 response. */
export function respondPlainText(status: number, body: string, headers?: HeadersInit): Response {
  const responseHeaders = new Headers(headers)
  responseHeaders.set("Content-Type", "text/plain; charset=utf-8")
  return new Response(body, { status, headers: responseHeaders })
}

/** Creates the shared static-route 404 response. */
export function respondNotFound(headers?: HeadersInit): Response {
  return respondPlainText(404, "Not Found", headers)
}
