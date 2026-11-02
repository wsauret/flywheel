import { brandTileSvg } from "../../../protocol/client/brand.js"

/** The token values of the client's dark set (`webview/src/styles/tokens.css`)
 *  and the local host's light set (`webview/local/theme.css`), under the same
 *  names. A page that the runtime renders itself, before or instead of the
 *  client, reads these names, so the hub, its starting page, and a project's
 *  own placeholder pages keep the theme that the client then shows. */
const THEME = `:root{color-scheme:light dark;--fw-bg:#1c1b19;--fw-fg:#cfcbc3;--fw-fg-muted:#9b968c;--fw-raised:color-mix(in srgb,var(--fw-fg) 6%,transparent);--fw-hairline:color-mix(in srgb,var(--fw-fg) 16%,transparent);--fw-secondary:#33312d;--fw-secondary-hover:#3e3c37;--fw-error:#f85149;--fw-focus:#0078d4;--fw-link:#4daafc;--fw-shadow-sheet:0 12px 40px rgb(0 0 0/.45)}
@media(prefers-color-scheme:light){:root{--fw-bg:#f7f7f5;--fw-fg:#1f2430;--fw-fg-muted:#626b7d;--fw-secondary:#e6e8ec;--fw-secondary-hover:#d9dce3;--fw-error:#c2362f;--fw-focus:#2563eb;--fw-link:#1d4fc2;--fw-shadow-sheet:0 12px 40px rgb(0 0 0/.18)}}
*{box-sizing:border-box}body{margin:0;min-height:100dvh;display:grid;place-items:center;padding:1rem;background:var(--fw-bg);color:var(--fw-fg);font:13px/1.55 -apple-system,BlinkMacSystemFont,"Segoe UI",system-ui,sans-serif;-webkit-font-smoothing:antialiased}a{color:var(--fw-link)}a:focus-visible,button:focus-visible{outline:2px solid var(--fw-focus);outline-offset:2px}[role=alert]{color:var(--fw-error);overflow-wrap:anywhere}
.loading{max-width:42ch;display:flex;flex-direction:column;align-items:center;gap:.5rem;text-align:center}.brand-tile{margin-bottom:.5rem;line-height:0;border-radius:22.37%;box-shadow:var(--fw-shadow-sheet)}.brand-mark{transform-box:fill-box;transform-origin:center;animation:spin 3s linear var(--spin-offset,0ms) infinite}.loading strong{font-size:15px;font-weight:600;letter-spacing:-.01em}.loading p{margin:0;color:var(--fw-fg-muted);overflow-wrap:anywhere}@keyframes spin{to{transform:rotate(360deg)}}@media(prefers-reduced-motion:reduce){.brand-mark{animation:none}}`

export interface FlywheelPage {
  readonly title: string
  /** Markup inside `<main>`; the caller escapes every value it interpolates. */
  readonly body: string
  /** Reloads the page after this many seconds, for a state that resolves itself. */
  readonly refreshSeconds?: number
  /** Rules for this page alone, written against the theme's token names. */
  readonly style?: string
  readonly script?: string
}

/** One complete HTML document in Flywheel's theme, which follows the
 *  browser's light or dark preference the way the client does. Every page the
 *  runtime renders itself goes through here, so no page of the start flow
 *  falls back to the browser's default look or flips theme on the way to the
 *  client. */
export function renderFlywheelPage(page: FlywheelPage): string {
  const refresh = page.refreshSeconds === undefined ? "" : `<meta http-equiv="refresh" content="${page.refreshSeconds}">`
  const script = page.script === undefined ? "" : `<script src="${page.script}" defer></script>`
  return `<!doctype html><html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0">${refresh}<title>${page.title}</title><link rel="icon" href="/icon.svg" type="image/svg+xml"><style>
${THEME}${page.style ?? ""}
</style></head><body><main>${page.body}</main>${script}</body></html>`
}

/** The animated Flywheel tile over one escaped status line, the look of a
 *  state that resolves by itself. The spin starts at the wall clock's phase,
 *  so a page that reloads every second keeps the mark turning instead of
 *  restarting it. */
export function renderLoadingCard(label: string, statusLine: string): string {
  const spinOffsetMs = Date.now() % 3_000
  return `<div class="loading" role="status" aria-label="${label}" style="--spin-offset:-${spinOffsetMs}ms"><div class="brand-tile">${brandTileSvg(96, { corners: "rounded", markClass: "brand-mark" })}</div><strong>Flywheel</strong><p>${statusLine}</p></div>`
}

export function escapeHtml(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;")
}
