/** The one policy for every document and asset the loopback listener serves.
 *  The page is one bundled script and one stylesheet from the same origin, so
 *  nothing inline, remote, or framed is allowed. `connect-src 'self'` covers
 *  the `/socket` upgrade: CSP3 matches a `ws:` URL on the same host and port
 *  to `'self'`, so no scheme wildcard is needed and none is granted. */
export function buildControlUiCspHeader(): string {
  return [
    "default-src 'self'",
    "base-uri 'none'",
    "object-src 'none'",
    "frame-ancestors 'none'",
    "frame-src 'none'",
    "script-src 'self'",
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob:",
    "media-src 'self' data: blob:",
    "font-src 'self'",
    "worker-src 'self'",
    "connect-src 'self'",
  ].join("; ")
}

/** Applies browser security headers to every Control UI response. */
export function applyControlUiSecurityHeaders(headers: Headers): Headers {
  headers.set("X-Frame-Options", "DENY")
  headers.set("Content-Security-Policy", buildControlUiCspHeader())
  headers.set("X-Content-Type-Options", "nosniff")
  // `same-origin`, not `no-referrer`: with `no-referrer` a browser serializes
  // the Origin of the page's own same-origin form post as `null`, and the hub's
  // mutation check rightly refuses that. Same-origin destinations still learn
  // no more than they served, and every other origin still learns nothing.
  headers.set("Referrer-Policy", "same-origin")
  headers.set("Permissions-Policy", "camera=(), microphone=(), geolocation=(), clipboard-write=(self)")
  return headers
}
