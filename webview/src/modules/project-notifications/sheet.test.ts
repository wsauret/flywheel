import assert from "node:assert/strict"
import { test } from "node:test"
import { fileURLToPath } from "node:url"
import { importBuiltModule } from "../../test-support/import-built-module.js"
import { loadSolidFixture } from "../../test-support/solid-transform.js"
import { loadSemanticRowsFixture } from "../../app/semantic-rows-loader-fixture.js"
import { projectNotificationsDomain, type ProjectNotificationEpisode } from "../../../../src/protocol/modules/project-notifications.js"

const build = await Bun.build({
  entrypoints: [fileURLToPath(new URL("sheet-fixture.ts", import.meta.url))],
  target: "bun",
  format: "esm",
  plugins: [{ name: "solid-ssr", setup(builder) { builder.onLoad({ filter: /\.tsx$/ }, loadSolidFixture("ssr")) } }],
})
if (!build.success) throw new Error(build.logs.map(String).join("\n"))
const javascript = build.outputs.find(output => output.kind === "entry-point")
if (!javascript) throw new Error("SSR build produced no JavaScript entry point")
const { renderBadge, renderNotifications, runNotificationAction }: typeof import("./sheet-fixture.js") = await importBuiltModule(javascript)

test("resolution keeps the notification article and current actions until dismissal", async () => {
  const { mountSemanticRows } = await loadSemanticRowsFixture<typeof import("./semantic-rows-fixture.js")>(new URL("semantic-rows-fixture.tsx", import.meta.url))
  const episode: ProjectNotificationEpisode = { id: "episode", sourceId: "provider", title: "Reconnect", message: "Authentication required", severity: "alert", action: { kind: "open-auth" }, createdAt: 1, expiresAt: Number.MAX_SAFE_INTEGER }
  const initial = { modules: { project_notifications: [episode] } }
  const mounted = mountSemanticRows("notifications", initial)
  try {
    const article = mounted.elements().find(node => node.tag === "article")
    const dismiss = mounted.button("Dismiss")
    assert.ok(article && dismiss)
    dismiss.focus()
    mounted.publish(structuredClone(initial))
    assert.ok(mounted.elements().includes(article))
    const current = { ...episode, title: "Current title", message: "Current detail", action: { kind: "open-settings" as const } }
    mounted.publish({ modules: { project_notifications: [current] } })
    const resolved = projectNotificationsDomain.view.patch({ kind: "project_notifications.resolved", sourceId: episode.sourceId, episodeId: episode.id, resolvedAt: 20 }, [current])
    assert.ok(resolved)
    mounted.publish({ modules: { project_notifications: [...resolved] } })
    assert.ok(mounted.elements().includes(article))
    assert.ok(mounted.elements().includes(dismiss))
    assert.equal(dismiss.ownerDocument.activeElement, dismiss)
    assert.deepEqual(article.properties.classList, { "notification-alert": false, "notification-resolved": true })
    assert.match(mounted.text(), /resolved.*Current title.*Current detail/)
    const action = mounted.button("Open settings")?.properties.onClick
    assert.equal(typeof action, "function")
    if (typeof action === "function") action()
    assert.deepEqual(mounted.calls(), [["settings", undefined]])
    const click = dismiss.properties.onClick
    assert.equal(typeof click, "function")
    if (typeof click === "function") click()
    for (let turn = 0; turn < 10; turn++) await Promise.resolve()
    assert.deepEqual(mounted.calls().at(-1), { type: "project_notifications.dismiss", sourceId: "provider", episodeId: "episode" })
    assert.deepEqual(mounted.reports(), [])
    const dismissed = projectNotificationsDomain.view.patch({ kind: "project_notifications.dismissed", sourceId: episode.sourceId, episodeId: episode.id, dismissedAt: 21 }, resolved)
    assert.ok(dismissed)
    mounted.publish({ modules: { project_notifications: [...dismissed] } })
    assert.ok(!mounted.elements().includes(article))
  } finally { mounted.dispose() }
})

test("resolved notifications keep their content and actions without warning styling", () => {
  for (const missing of [undefined, null]) {
    const loading = renderNotifications(missing)
    assert.match(loading, /aria-busy="true">Reading/)
    assert.doesNotMatch(loading, /Nothing needs your attention/)
  }
  assert.match(renderNotifications([]), /Nothing needs your attention/)
  const html = renderNotifications([{
    id: "episode", sourceId: "remote.relay", title: "Relay unavailable",
    message: "Could not connect.", severity: "alert", action: { kind: "open-settings" },
    createdAt: 100, resolvedAt: 101, expiresAt: Number.MAX_SAFE_INTEGER,
  }])
  assert.match(html, /notification-resolved/)
  assert.doesNotMatch(html, /notification-alert/)
  assert.match(html, />resolved</)
  assert.match(html, /Relay unavailable/)
  assert.match(html, /Could not connect\./)
  assert.match(html, /Open settings/)
  assert.match(html, /Dismiss/)
  const notice = renderNotifications([{
    id: "notice", sourceId: "development:bug-report-triage", title: "Bug reports need triage",
    message: "1 bug report waits for triage. Run /bug-report-triage.", severity: "warning",
    createdAt: 1, expiresAt: Number.MAX_SAFE_INTEGER,
  }])
  assert.match(notice, /1 bug report waits for triage/)
  assert.match(notice, /Dismiss/)
  assert.doesNotMatch(notice, /class="primary"/)
})

test("provider auth notification opens the providers sheet at the provider", () => {
  assert.deepEqual(runNotificationAction({ kind: "open-auth-provider", providerId: "chatgpt" }), [
    ["providers", { kind: "focus-provider", providerId: "chatgpt" }],
  ])
})

test("targeted auth notification opens the exact paid-use review", () => {
  assert.deepEqual(runNotificationAction({
    kind: "open-auth", providerId: "chatgpt", accountCorrelationId: "account", envelopeId: "paid",
  }), [["providers", { kind: "review-paid-use", providerId: "chatgpt", accountCorrelationId: "account", envelopeId: "paid" }]])
})

test("generic auth notification opens the providers root", () => {
  assert.deepEqual(runNotificationAction({ kind: "open-auth" }), [["providers", undefined]])
})

test("settings and usage notifications open the client's own sheets", () => {
  assert.deepEqual(runNotificationAction({ kind: "open-settings" }), [["settings", undefined]])
  assert.deepEqual(runNotificationAction({ kind: "open-usage" }), [["usage"]])
})

test("the toolbar badge counts unresolved visible episodes and is absent with none", () => {
  const episode = (id: string) => ({ id, sourceId: `source-${id}`, title: id, message: id, severity: "warning" as const, action: { kind: "open-settings" as const }, createdAt: 10, expiresAt: Number.MAX_SAFE_INTEGER })
  assert.match(renderBadge([episode("one"), episode("two")]), /title="2 notifications"/)
  assert.match(renderBadge([episode("one")]), /title="1 notification"/)
  assert.match(renderBadge([episode("one")]), /toolbar-badge-warning/)
  assert.doesNotMatch(renderBadge([]), /toolbar-badge/)
  assert.doesNotMatch(renderBadge([{ ...episode("gone"), dismissedAt: 11 }]), /toolbar-badge/)
  assert.match(renderBadge([episode("open"), { ...episode("fixed"), resolvedAt: 11 }, { ...episode("fixed-too"), resolvedAt: 12 }]), /title="1 notification"/)
  assert.doesNotMatch(renderBadge([{ ...episode("fixed"), resolvedAt: 11 }]), /toolbar-badge/)
})
