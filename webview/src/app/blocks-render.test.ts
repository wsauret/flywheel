import assert from "node:assert/strict"
import { describe, test } from "node:test"

import type { FrontendOutputBlock, FrontendToolEntry } from "../../../src/protocol/app-service-types.js"
import type { StatusView } from "../../../src/protocol/status-protocol-types.js"
import { foldReadRuns } from "../../../src/protocol/client/tool-run-category.js"
import { rendered } from "./blocks-render-loader-fixture.js"
const { renderBlock, renderCompactRow, renderTurnFold, renderLocalMessage, tool } = rendered

test("returned input preserves the person's text in a whitespace-preserving notice", () => {
  const message = "Explorer finished before reading your message:\n\nrename `foo` to `bar`\n  keep  spacing"
  const notice: FrontendOutputBlock = { kind: "system", id: "returned-input:child:person:send", message, timestamp: 0 }
  const html = renderBlock(notice)
  const content = html.match(/<div class="block system\s+returned-input">([\s\S]*?)<\/div>/)?.[1]
  assert.equal(content, message)
  assert.doesNotMatch(renderBlock({ ...notice, id: "ordinary-notice" }), /returned-input/)
})

test("shell rows show the live tail over restored bodies until settled output replaces it", () => {
  for (const status of ["pending", "completed"] as const) {
    for (const background of [undefined, false, true]) {
      const row = tool({
        name: "bash",
        fileChangeKind: undefined,
        status,
        ...(background === undefined ? {} : { background }),
        content: "Running in background as managed process",
      })
      const live = renderBlock(row, {
        streaming: { content: "latest command output" },
        body: { blockId: `tool:${row.id}`, content: "old hydrated output" },
        processStatus: {
          activeBackgroundCommands: [{ id: "process-1", toolUseId: row.id, description: "Shell", startedAtMs: 0 }],
          activeForegroundBashToolCallIds: [],
        },
      })
      assert.ok(live.includes("latest command output"))
      assert.ok(!live.includes("Running in background as managed process"))
      assert.ok(!live.includes("old hydrated output"))
      assert.match(live, /marker-dot live/)
      assert.match(live, />Stop</)
      assert.doesNotMatch(live, />Detach</)

      const settled = renderBlock({ ...row, status: "completed", content: "finished command output" })
      assert.ok(settled.includes("finished command output"))
      assert.ok(!settled.includes("latest command output"))
      assert.doesNotMatch(settled, /marker-dot live|>Stop<|>Detach</)
    }
  }
})

test("saved questions and answers share a wrapping text region beside their bullet", async () => {
  const question = "Which approach should we use for the complete implementation?"
  const answer = "Keep the complete question and answer visible even in a narrow panel."
  const html = renderBlock({
    kind: "question",
    toolUseId: "question-wrap",
    timestamp: 0,
    questions: [{ question, choices: [{ kind: "freeform", label: "Other" }], multiSelect: false }],
    answers: { [question]: answer },
  })
  assert.match(html, /class="question-record-text"><span class="tool-title">/)
  assert.ok(html.includes(question))
  assert.ok(html.includes(answer))
  const css = await Bun.file(new URL("../styles/blocks.css", import.meta.url)).text()
  assert.match(css, /\.question-record-text\s*\{[^}]*min-width:\s*0;[^}]*overflow-wrap:\s*anywhere;/)
  assert.match(css, /\.question-record-text \.tool-detail\s*\{[^}]*white-space:\s*pre-wrap;/)
})

describe("running work reads as running", () => {
  test("subagent lines use the workflow glyph and one sentence for every settled and queued state", () => {
    const base = {
      kind: "agentGroup" as const, id: "states", toolUseId: "states", containerKind: "subagent" as const,
      label: "Explorer", description: "Inspect", model: "test", duration: 2000,
      timestamp: 0, children: [], totalToolCount: 1, linkUri: "flywheel://session/child",
      summary: "Found the cause", activity: { name: "Read", detail: "a.ts" },
    }
    const cases = [
      [{ status: "queued" }, "○", ""],
      [{ status: "completed" }, "✓", "Found the cause"],
      [{ status: "partial" }, "◐", "Partial: Found the cause"],
      [{ status: "paused", pausedBy: "person" }, "‖", "Interrupted by you"],
      [{ status: "paused", pausedBy: "agent" }, "‖", "Interrupted by the parent"],
      [{ status: "paused", pausedBy: "runtime" }, "‖", "Interrupted by the runtime"],
      [{ status: "interrupted" }, "‖", "Interrupted"],
      [{ status: "stopped" }, "–", "Stopped"],
      [{ status: "cancelled" }, "–", "Canceled"],
    ] as const
    for (const [state, glyph, sentence] of cases) {
      const html = renderBlock({ ...base, ...state })
      const line = html.slice(html.indexOf('<div class="subagent-line'))
      assert.equal(textOf(line), `${glyph}${sentence}`)
      assert.doesNotMatch(line, /Read|a\.ts|workflow-card-time/)
    }
  })
  test("a retry is a full subagent row that keeps child-session navigation and states its failure message with the provider detail below it", () => {
    for (const status of ["active", "completed", "error"] as const) {
      const base = {
        kind: "agentGroup" as const, id: "retry-1", toolUseId: "retry-1", containerKind: "subagent" as const,
        label: "Explorer retry", description: "Inspect files", linkUri: "flywheel://session/child",
        children: Array.from({ length: 5 }, (_, i) => tool({ id: `operation-${i}`, name: "bash", presentation: { name: "Bash", detail: `operation-${i}` }, fileChangeKind: undefined })),
        totalToolCount: 5, timestamp: Date.now() - 3_600_000, duration: 7000, totalTokens: 900, model: "test-model",
      }
      const html = renderBlock(status === "error"
        ? { ...base, status, failure: { title: "Provider failed", message: "Provider refused the request", guidance: "Send a message to retry.", detail: "HTTP 500" } }
        : { ...base, status }, { reopened: true })
      assert.match(html, /Open this run&#39;s own session|Open this run's own session/)
      assert.doesNotMatch(html.slice(0, html.indexOf("</button>")), /disclosure static|aria-expanded=/)
      assert.match(html, /Explorer retry/)
      assert.match(html, /test-model/)
      assert.match(html, /5 operations/)
      assert.doesNotMatch(html, /tokens/)
      const duration = "7s"
      const summary = html.match(/<span class="subagent-header-parts[^"]*">([\s\S]*?)<\/button>/)?.[1]
      const corner = html.match(/<span class="row-duration">([\s\S]*?)<\/span><\/span>/)?.[1]
      assert.ok(summary)
      assert.ok(corner)
      assert.ok(!textOf(summary).includes(duration), "the web header keeps time in RowTime")
      assert.doesNotMatch(html, /class="workflow-card-time"/)
      assert.equal(textOf(corner), ` · ${duration}`, "the corner excludes inactive time")
      if (status === "active") {
        const episode = renderBlock({ ...base, status, activeStartedAt: 15000 }, { now: 20000 })
        const episodeCorner = episode.match(/<span class="row-duration">([\s\S]*?)<\/span><\/span>/)?.[1]
        assert.ok(episodeCorner)
        assert.doesNotMatch(episode, /class="workflow-card-time"/)
        assert.equal(textOf(episodeCorner), " · 12s")
        assert.match(html, /marker-dot live/)
        assert.match(html, /subagent-line/)
        assert.doesNotMatch(html, /agent-activity-preview|operation-[0-4]/)
      }
      if (status === "error") {
        assert.match(textOf(html), /✗Provider refused the requestHTTP 500/)
        assert.doesNotMatch(html, /Send a message to retry/)
      } else {
        assert.doesNotMatch(html, /tool-error/)
      }
    }
  })
  test("a running tool row with nothing to open is never dimmed and its marker pulses", () => {
    const row = tool({ id: "bash-1", name: "bash", presentation: { name: "Bash", detail: "bun test" }, status: "pending", fileChangeKind: undefined })
    const html = renderBlock(row)
    assert.doesNotMatch(html, /<button[^>]*disabled/)
    assert.match(html, /marker-dot live/)
    assert.doesNotMatch(html, />Detach</)
    const held = renderBlock(row, {
      processStatus: { activeBackgroundCommands: [], activeForegroundBashToolCallIds: [row.id] },
    })
    assert.match(held, />Detach</)
    assert.doesNotMatch(held, />Stop</)
    const completed = { ...row, status: "completed" as const, background: true }
    const quiet = renderBlock(completed, {
      collapsed: true,
      processStatus: { activeBackgroundCommands: [{ id: "process-1", toolUseId: row.id, description: "Shell", startedAtMs: 0 }], activeForegroundBashToolCallIds: [] },
    })
    assert.match(quiet, /marker-dot live/)
    assert.match(textOf(renderBlock(completed, {
      now: 12000,
      processStatus: { activeBackgroundCommands: [{ id: "process-1", toolUseId: row.id, description: "Shell", startedAtMs: 0 }], activeForegroundBashToolCallIds: [] },
    })), / · 12s/)
    assert.match(quiet, />Stop</)
    assert.doesNotMatch(quiet, /class="tool-body"|<button[^>]*disabled/)
    const settled = renderBlock(completed, { collapsed: true })
    assert.doesNotMatch(settled, /marker-dot live|>Stop<|>Detach</)
  })

  test("a command that waits for CPU keeps its live marker and its control until released", () => {
    const foreground = tool({ id: "bash-held", name: "bash", presentation: { name: "Bash", detail: "make all" }, status: "pending", fileChangeKind: undefined })
    const background = { ...foreground, id: "bash-background", status: "completed" as const, background: true }
    const managed = { id: "process-1", toolUseId: background.id, description: "Shell", startedAtMs: 0 }
    const waiting = /<span class="processor-wait">Waiting for CPU<\/span>/
    const heldForeground = renderBlock(foreground, {
      processStatus: { activeBackgroundCommands: [], activeForegroundBashToolCallIds: [foreground.id], processorHeldToolCallIds: [foreground.id] },
    })
    assert.match(heldForeground, waiting)
    assert.match(heldForeground, /marker-dot live/)
    assert.match(heldForeground, />Detach</)
    assert.doesNotMatch(heldForeground, /<button[^>]*disabled/)
    const heldBackground = renderBlock(background, {
      collapsed: true,
      processStatus: { activeBackgroundCommands: [managed], activeForegroundBashToolCallIds: [], processorHeldToolCallIds: [background.id] },
    })
    assert.match(heldBackground, waiting)
    assert.match(heldBackground, /marker-dot live/)
    assert.match(heldBackground, />Stop</)
    const released = renderBlock(background, {
      collapsed: true,
      processStatus: { activeBackgroundCommands: [managed], activeForegroundBashToolCallIds: [], processorHeldToolCallIds: [] },
    })
    assert.doesNotMatch(released, /processor-wait/)
    assert.match(released, /marker-dot live/)
    assert.match(released, />Stop</)
    // A command that has finished never waits, even before the status drops its id.
    assert.doesNotMatch(renderBlock(background, {
      collapsed: true,
      processStatus: { activeBackgroundCommands: [], activeForegroundBashToolCallIds: [], processorHeldToolCallIds: [background.id] },
    }), /processor-wait|marker-dot live/)
  })

  test("a settled tool row with nothing to open is static, not disabled", () => {
    const html = renderBlock(tool({ id: "list-1", name: "list", presentation: { name: "List", detail: "src" }, status: "completed", fileChangeKind: undefined }))
    assert.doesNotMatch(html, /<button[^>]*disabled/)
    assert.match(html, /disclosure static/)
    assert.doesNotMatch(html, /marker-dot live/)
  })

  test("an initializing subagent keeps its persona and hides partial details until ready", () => {
    const card = {
      kind: "agentGroup" as const, containerKind: "subagent" as const, id: "initializing", toolUseId: "initializing",
      label: "Explorer", description: "Find the fold", status: "pending" as const, timestamp: 1,
      children: [tool({ id: "read-preview", name: "read", presentation: { name: "Read", detail: "private-preview.ts" }, fileChangeKind: undefined })],
      totalToolCount: 1,
    }
    for (const partial of [card, { ...card, model: "gpt-6-astra high" }, { ...card, status: "active" as const, linkUri: "flywheel://session/child", activeStartedAt: 1 }]) {
      const html = renderBlock(partial)
      assert.match(textOf(html), /Explorer.*Initializing\.\.\./)
      assert.doesNotMatch(html, /Find the fold|gpt-6-astra|private-preview|Open/)
    }
    const ready = { ...card, status: "active" as const, linkUri: "flywheel://session/child", activeStartedAt: 1, model: "gpt-6-astra high", activity: { name: "Read", detail: "private-preview.ts" } }
    const readyHtml = renderBlock(ready)
    assert.doesNotMatch(readyHtml, /Initializing/)
    for (const detail of ["Explorer", "Find the fold", "gpt-6-astra high", "private-preview.ts", "Open"]) assert.ok(readyHtml.includes(detail))
    for (const preserved of [{ ...card, status: "queued" as const }, { ...card, status: "completed" as const }, { ...card, status: "interrupted" as const }, { ...ready, activeStartedAt: undefined, duration: 10 }]) {
      const preservedHtml = renderBlock(preserved)
      assert.doesNotMatch(preservedHtml, /Initializing/)
      assert.ok(preservedHtml.includes("Explorer"))
    }
  })

  test("a linked subagent keeps its activity marker before its label and its open arrow after the summary", () => {
    for (const status of ["active", "completed"] as const) {
      const html = renderBlock({
        kind: "agentGroup",
        id: "agent-1",
        toolUseId: "tu-1",
        containerKind: "subagent",
        label: "Explorer",
        description: "Find the fold",
        status,
        linkUri: "flywheel://session/child-1",
        children: [],
        totalToolCount: 0,
        timestamp: Date.now(),
        activeStartedAt: Date.now(),
        model: "gpt-6-astra high",
      })
      assert.doesNotMatch(html, /<button[^>]*disabled/)
      assert.match(html, /marker-dot/)
      if (status === "active") assert.match(html, /marker-dot live/)
      else assert.doesNotMatch(html, /marker-dot live/)
      assert.doesNotMatch(html, /<button class="disclosure[^>]*aria-expanded=/)
      assert.ok(html.indexOf("marker-dot") < html.indexOf("Explorer"))
      assert.ok(html.indexOf("\u2197") > html.indexOf("Find the fold"))
      assert.match(html, /class="agent-open">\u2197 Open<\/span>/)
    }
  })

  test("a linked subagent draws its server-selected activity, not child tool rows or the parent's processes", () => {
    const card: FrontendOutputBlock = {
      kind: "agentGroup", id: "agent-1", toolUseId: "tu-1", containerKind: "subagent", label: "Implementer", description: "Generate",
      status: "active", linkUri: "flywheel://session/child-1", totalToolCount: 1, timestamp: Date.now(), activeStartedAt: Date.now(), model: "gpt-6-astra high",
      // A card lists its child's call under the card's suffix; the child's status names the call itself.
      children: [tool({ id: "reshape#agent-1", status: "completed", declaresMutation: true, presentation: { name: "Bash", detail: "python3 reshape.py" } })],
      activity: { name: "Edited", detail: "3 files" },
    }
    const processes = { activeBackgroundCommands: [{ id: "process", toolUseId: "reshape", description: "Shell", startedAtMs: 0 }], activeForegroundBashToolCallIds: [], processorHeldToolCallIds: [] }
    const childStatus: StatusView = { ...processes, activity: "generating", activityStartedAt: 0, settledOutputPosition: null, connectionState: "connected", activeSubagentCount: 0, waitingOnBackgroundWork: false, replyWaits: [], startedAt: 0, streamingStartedAt: null, accumulatedActiveMs: 0, compactionStartedAt: null }
    const live = renderBlock(card, { childStatus, now: 5_000 })
    assert.match(textOf(live), /●Edited 3 files/)
    assert.doesNotMatch(live, /python3/)
    assert.doesNotMatch(live, /class="workflow-card-time"/)
    assert.match(live, /class="row-duration"/)
    for (const settled of [renderBlock(card), renderBlock(card, { processStatus: processes })]) {
      assert.match(textOf(settled), /Edited 3 files/)
      assert.doesNotMatch(settled, /bash command is running/)
      assert.doesNotMatch(settled, /live-time inline-time/)
    }
  })

  test("a subagent a person stopped reads Stopped, in the Canceled tone, not as an error", () => {
    const card = (status: "stopped" | "cancelled") => renderBlock({
      kind: "agentGroup",
      id: "agent-1",
      toolUseId: "tu-1",
      containerKind: "subagent",
      label: "Explorer",
      description: "Find the fold",
      status,
      children: [],
      totalToolCount: 0,
      timestamp: Date.now(),
    })
    assert.match(textOf(card("stopped")), /–Stopped/)
    assert.match(textOf(card("cancelled")), /–Canceled/)
    assert.doesNotMatch(card("stopped"), /Canceled/)
  })

  test("a linked subagent card shows the child's current model and effort", () => {
    const html = renderBlock({
      kind: "agentGroup",
      id: "agent-1",
      toolUseId: "tu-1",
      containerKind: "subagent",
      label: "General",
      description: "Own public output settlement",
      status: "active",
      children: [],
      totalToolCount: 0,
      model: "gpt-6-astra high",
      activeStartedAt: Date.now(),
      linkUri: "flywheel://session/child-1",
      timestamp: Date.now(),
    }, {
      roles: { assignments: { chat: { model: "wrong-chat", effort: "low" } }, serving: { slot: { kind: "role", roleId: "chat" }, selection: { model: "gpt-6-astra", effort: "medium" } } },
    })

    assert.match(html, /gpt-6-astra medium/)
    assert.doesNotMatch(html, /gpt-6-astra high/)
  })

})

describe("compact read rows", () => {
  test("an unmerged read names its file by basename, as the merged row and the terminal do", () => {
    const html = renderCompactRow(tool({ id: "read-1", name: "read", action: "file_read", presentation: { name: "Read", detail: "../backend/Services/PropertyRecord/Api.cs" }, linkUri: "file:///repo/backend/Services/PropertyRecord/Api.cs", status: "completed", fileChangeKind: undefined }))
    assert.match(html, /class="tool-detail ?">Api\.cs</)
    assert.doesNotMatch(html, /PropertyRecord\/Api/)
  })

  test("a read that names a resource rather than a file keeps its identifier whole", () => {
    const html = renderCompactRow(tool({ id: "skill-1", name: "skill", action: "file_read", presentation: { name: "Load Skill", detail: "ship/SKILL.md" }, status: "completed", fileChangeKind: undefined }))
    assert.match(html, /class="tool-detail ?">ship\/SKILL\.md</)
    assert.match(html, /tabindex="0"[^>]*aria-label="Load Skill ship\/SKILL\.md"/)
    assert.doesNotMatch(html, /<time[^>]*tabindex/)
  })

  test("an opened read offers its file's path as the way into the editor when the host opens files", () => {
    const read = tool({ id: "read-2", name: "read", action: "file_read", presentation: { name: "Read", detail: "docs/README.md" }, linkUri: "file:///repo/docs/README.md", content: "hello", status: "completed", fileChangeKind: undefined })
    assert.match(renderBlock(read, { canOpenFiles: true }), /<button[^>]+class="tool-file-path"[^>]*>docs\/README\.md</)
    assert.doesNotMatch(renderBlock(read), /tool-file-path/)
  })

  test("a merged read run links each file it names when the host opens files", () => {
    const read = (id: string, path: string) => tool({ id, name: "read", action: "file_read", presentation: { name: "Read", detail: path }, linkUri: `file://${path}`, status: "completed", fileChangeKind: undefined })
    const skill = tool({ id: "skill-3", name: "read", action: "file_read", presentation: { name: "Read", detail: "ship/SKILL.md" }, status: "completed", fileChangeKind: undefined })
    const [run] = foldReadRuns([read("read-3", "/repo/a.ts"), skill, read("read-4", "/repo/src/b.ts")])
    if (run === undefined) throw new Error("expected one read run")
    const html = renderCompactRow(run, () => {})
    assert.match(html, /<button[^>]+class="tool-file-link"[^>]*>a\.ts<\/button>, (?:<!--[^>]*-->)?ship\/SKILL\.md, <button[^>]+class="tool-file-link"[^>]*>b\.ts</)
    assert.doesNotMatch(html, /tabindex="0"/)
    assert.match(renderCompactRow(run), /tabindex="0"/)
    assert.doesNotMatch(renderCompactRow(run), /tool-file-link/)
  })
})

describe("calls whose work waits", () => {
  test("a held message states why it waits as a notice on its row, alone and in a subagent card, never as a failure", () => {
    const held: FrontendToolEntry = {
      ...tool({ id: "message-1", name: "message_session", action: "ui_meta", presentation: { name: "Message to", detail: "Plan the release" }, fileChangeKind: undefined }),
      status: "blocked",
      statusMessage: "Held: nothing runs it now. It reads the message when it runs again.",
    }
    for (const html of [renderBlock(held), renderCompactRow(held)]) {
      assert.match(html, /<div class="tool-notice">Held: nothing runs it now\. It reads the message when it runs again\.<\/div>/)
      assert.doesNotMatch(html, /tool-error/)
    }
  })
})

describe("Executed summary limits", () => {
  test("scopes the clamp to Executed rows in normal and compact views", () => {
    const entry = tool({ name: "linear.save_issue", action: "shell_exec", fileChangeKind: undefined, runCategoryOverride: "execute", presentation: { name: "linear.save_issue", detail: "[description=one\n two]" } })
    for (const html of [renderBlock(entry), renderCompactRow(entry)]) {
      assert.match(html, /class="[^"]*execute-summary/)
      assert.match(html, /\[description=one two\]/)
    }
    const bash = tool({ name: "bash", action: "shell_exec", fileChangeKind: undefined, presentation: { name: "Bash", detail: "echo one\necho two" } })
    for (const html of [renderBlock(bash), renderCompactRow(bash)]) {
      assert.doesNotMatch(html, /execute-summary/)
      assert.match(html, /echo one\necho two/)
    }
  })
})

test("message times use absolute earlier-day dates, next-block durations and running elapsed", () => {
  const timestamp = new Date(2025, 0, 2, 16, 32).getTime()
  const message = { kind: "text" as const, id: "answer-clock", content: "Done", timestamp }
  const settled = renderBlock(message, { end: timestamp + 8000 })
  assert.match(textOf(settled), /2025 · .* · 8s/)
  assert.match(settled, /aria-label="Copy message"/)
  assert.match(textOf(renderBlock(tool({ timestamp, status: "pending" }), { now: timestamp + 12000 })), / · 12s/)
  assert.doesNotMatch(textOf(renderBlock(message)), / · \d+s/)
  assert.doesNotMatch(textOf(renderBlock(message, { end: timestamp })), / · 0s/)
  assert.doesNotMatch(settled, /tabindex=/)
})

/** The words a rendered fragment shows, without its markup. */
const textOf = (html: string) => html.replace(/<!--[\s\S]*?-->|<[^>]*>/g, "")

test("a folded turn shows its absolute start, duration and failed count in error colour", () => {
  const start = new Date(2025, 0, 2, 16, 32).getTime()
  const html = renderTurnFold([
    { kind: "userMessage", id: "person", content: "Do it", timestamp: start, pending: false, injected: false },
    tool({ name: "bash", action: "shell_exec", timestamp: start + 1000, exitCode: 1, fileChangeKind: undefined }),
    { kind: "text", id: "answer", content: "Done", timestamp: start + 481000 },
  ])
  assert.match(textOf(html.slice(html.indexOf("<button"), html.indexOf("</button>"))), /2025 · .* · Worked 8m 1s · ran 1 command · 1 failed/)
  assert.doesNotMatch(html, /row-meta/)
  assert.match(html, /class="tool-group-failed">1 failed<\/span>/)
})

test("a sent message the runtime has not shown back reads as the person's message, queued or not delivered", () => {
  const input = { text: "look at this\n[Image #1]", attachments: [{ marker: "[Image #1]", mediaType: "image/png", data: "iVBORw0K" }] }
  const queued = renderLocalMessage({ id: "local-1", input, timestamp: 0, delivery: { kind: "sending" } })
  assert.match(queued, /class="block user pending\s*"/)
  assert.match(queued, /look at this/)
  assert.match(queued, /src="data:image\/png;base64,iVBORw0K"/)
  assert.match(queued, /class="user-delivery">Queued</)
  assert.doesNotMatch(queued, /Edit/)
  const adopted = renderBlock({ kind: "userMessage", id: "runtime", content: input.text, timestamp: 0, pending: true, injected: false, submissionIds: ["local-1"] })
  assert.match(adopted, /class="user-delivery">Queued</)
  const consumed = renderBlock({ kind: "userMessage", id: "runtime", content: input.text, timestamp: 0, pending: false, injected: false, submissionIds: ["local-1"] })
  assert.doesNotMatch(consumed, /user-delivery/)
  const failed = renderLocalMessage({ id: "local-1", input, timestamp: 0, delivery: { kind: "failed", error: "Disconnected" } })
  assert.doesNotMatch(failed, /pending/)
  assert.match(failed, /class="user-delivery failed"/)
  // A phone has no hover, so the cause is text, not a tooltip.
  assert.match(textOf(failed), /Not delivered: Disconnected/)
  assert.doesNotMatch(failed, /title=/)
  assert.match(failed, /aria-label="Edit the message that was not delivered"[^>]*>Edit</)
  // A send whose answer was lost says what the terminal says, not the transport's words.
  const unconfirmed = renderLocalMessage({ id: "local-1", input, timestamp: 0, delivery: { kind: "unconfirmed" } })
  assert.match(unconfirmed, /class="user-delivery failed"/)
  assert.match(textOf(unconfirmed), /Not confirmed/)
  assert.doesNotMatch(textOf(unconfirmed), /Not delivered/)
  assert.match(unconfirmed, />Edit</)
})

test("a person's message answers the tap: it never rises in, a queue dims only its words, and Edit is phone-sized", async () => {
  const css = await Bun.file(new URL("../styles/blocks.css", import.meta.url)).text()
  // A rise would flash the queued copy and replay when the runtime's own copy replaces it.
  assert.match(css, /\.block\.user\s*\{[^}]*animation:\s*none;/)
  assert.doesNotMatch(css, /\.block\.user\.pending\s*\{[^}]*opacity/)
  assert.match(css, /\.block\.user\.pending \.user-text,\s*\.block\.user\.pending \.user-images\s*\{[^}]*opacity:/)
  const coarse = [...css.matchAll(/@media \(pointer: coarse\)\s*\{([\s\S]*?)\n?\}\s*\}/g)].map((match) => match[1]).join("\n")
  assert.match(coarse, /\.user-delivery-edit\s*\{[^}]*min-height:\s*calc\(2 \* var\(--fw-s5\)\)/)
})


test("a message from another session names its sender above the text and the person's words below it", () => {
  const html = renderBlock({
    kind: "userMessage", id: "msg", content: "Use main.ts", timestamp: 1, pending: false, injected: false,
    from: { sessionId: "parent-1", name: "Plan the release", relation: "parent", personWords: "keep the tests green" },
  })
  const sender = html.indexOf(">From Plan the release (parent)<")
  const text = html.indexOf(">Use main.ts<")
  const person = html.indexOf(">From the person<")
  assert.ok(sender >= 0 && sender < text && text < person, html)
  assert.match(html, /class="block user\s+from-session"/)
  assert.match(html, /class="user-sender"/)
  assert.match(html, /class="user-person-words"/)
  assert.ok(html.includes(">keep the tests green<"))

  const own = renderBlock({ kind: "userMessage", id: "own", content: "Hello", timestamp: 1, pending: false, injected: false })
  assert.doesNotMatch(own, /user-sender/)
  assert.doesNotMatch(own, /from-session/)
})

for (const relation of ["child", "sibling", "other"] as const) test(`a received ${relation} message uses a collapsed tool disclosure, with its words behind the arrow`, () => {
  const block = {
    kind: "userMessage" as const, id: "received", content: "Use main.ts", timestamp: 1, pending: false, injected: false,
    from: { sessionId: "sender", name: "Trace message rendering", relation, ...(relation === "other" ? {} : { typeLabel: "Explorer" }), personWords: "keep the tests green" },
  }
  const closed = renderBlock(block, { collapsed: true })
  assert.match(closed, /aria-expanded="false"/)
  assert.ok(textOf(closed).includes(relation === "other" ? "Message fromTrace message rendering" : "Message fromExplorer · Trace message rendering"), closed)
  assert.ok(!closed.includes("Use main.ts"), closed)
  assert.doesNotMatch(closed, /from-session/)
  const opened = renderBlock(block)
  assert.match(opened, /aria-expanded="true"/)
  assert.ok(opened.includes("Use main.ts"), opened)
  assert.ok(opened.includes("keep the tests green"), opened)
})

test("a Message to row opens the sent words without a delivery receipt", () => {
  const sent = tool({ name: "message_session", status: "completed", fileChangeKind: undefined,
    presentation: { name: "Message to", detail: "\u2699 Implement · Update server settings" },
    invocationBody: { content: "Use main.ts", filetype: "text", presentation: "disclosure" }, content: "Delivered" })
  const closed = renderBlock(sent, { collapsed: true })
  assert.match(closed, /aria-expanded="false"/)
  assert.ok(!closed.includes("Use main.ts") && !closed.includes("Delivered"), closed)
  const opened = renderBlock(sent)
  assert.ok(opened.includes("Use main.ts") && !opened.includes("Delivered"), opened)
  const omittedReceipt = renderBlock({ ...sent, content: undefined, contentOmittedLines: 1 })
  assert.ok(omittedReceipt.includes("Use main.ts") && !omittedReceipt.includes("more output lines"), omittedReceipt)
  const waitOnly = { ...sent, invocationBody: undefined, content: "Not waiting on Update server settings: it cannot answer now." }
  assert.ok(!renderBlock(waitOnly, { collapsed: true }).includes("Not waiting"))
  assert.ok(renderBlock(waitOnly).includes("Not waiting"))
  for (const outcome of [
    { ...sent, status: "error" as const, errorMessage: "Recipient finished" },
    { ...sent, status: "blocked" as const, statusMessage: "Message held" },
  ]) {
    const message = outcome.status === "error" ? outcome.errorMessage : outcome.statusMessage
    assert.ok(!renderBlock(outcome, { collapsed: true }).includes(message))
    assert.ok(renderBlock(outcome).includes(message))
  }
})
