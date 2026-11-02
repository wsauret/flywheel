import assert from "node:assert/strict"
import { test } from "node:test"
import { UNKNOWN_COMMAND_NOTICE } from "../../../src/protocol/client/slash-route.js"
import { mountComposerSubmission } from "./composer-submission-loader-fixture.js"
import { textContent } from "./render-ownership-host-fixture.js"

test("an ordinary workflow-agent conversation shows its own live transcript status", () => {
  const mounted = mountComposerSubmission()
  try {
    mounted.openWorkflow(true)
    mounted.publishActivity("thinking")
    assert.match(mounted.activityText(), /Thinking/)
    mounted.publishActivity("generating")
    assert.match(mounted.activityText(), /Generating/)
    mounted.publishActivity("executing_tools")
    assert.match(mounted.activityText(), /Executing/)
  } finally { mounted.dispose() }
})

test("Enter in the attachment menu opens the chooser without sending the focused composer's draft", () => {
  const mounted = mountComposerSubmission()
  try {
    mounted.type("keep these words")
    mounted.openAttachments()
    assert.equal(mounted.attachmentMenuOpen(), true)
    mounted.enter()
    assert.equal(mounted.filePicks(), 1)
    assert.equal(mounted.attachmentMenuOpen(), false)
    assert.deepEqual(mounted.sent, [])
    assert.equal(mounted.text(), "keep these words")
  } finally { mounted.dispose() }
})

test("the compact changes pill keeps the count and complete accessible review name", () => {
  const mounted = mountComposerSubmission()
  try {
    assert.equal(mounted.changesLabel(), undefined)
    mounted.publishChanges({ status: "ready", data: { fileCount: 0, unknownFileMutationGaps: 0, snapshotPosition: 1 } })
    assert.equal(mounted.changesLabel(), undefined)
    mounted.publishChanges({ status: "incomplete", data: { fileCount: 12, unknownFileMutationGaps: 1, snapshotPosition: 2 } })
    assert.equal(mounted.changesCount(), "12")
    assert.equal(mounted.changesLabel(), "Show all changes: 12 known changed (incomplete)")
    mounted.publishChanges({ status: "loading", data: { fileCount: 12, unknownFileMutationGaps: 1, snapshotPosition: 2 } })
    assert.equal(mounted.changesCount(), "12")
  } finally { mounted.dispose() }
})

test("a send into an open session clears the composer at once, and Up takes a failed one back with its files", async () => {
  const mounted = mountComposerSubmission()
  try {
    mounted.type("  message this workflow  ")
    await mounted.attach("draft.txt")
    mounted.send()
    assert.equal(typeof mounted.paneHeight(), "string")
    assert.equal(mounted.wrapperHeight(), undefined)
    assert.equal(mounted.text(), "")
    assert.equal(mounted.attachmentCount(), 0)
    assert.equal(mounted.disabled(), true)
    mounted.type("next thought")
    await mounted.refuse()
    assert.deepEqual(mounted.reports, ["Flywheel could not complete that action: This workflow cannot accept the message"])
    assert.equal(mounted.text(), "next thought")
    mounted.type("")
    mounted.key("ArrowUp")
    assert.equal(mounted.text(), "message this workflow")
    assert.deepEqual(mounted.recalledEntries, [undefined], "Up takes back the newest failed message")
    assert.equal(mounted.attachmentCount(), 1)
    mounted.send()
    assert.equal(mounted.sent.length, 2)
    assert.equal(mounted.sent[1]?.text, mounted.sent[0]?.text)
    assert.equal(mounted.sent[1]?.attachments?.[0]?.name, "draft.txt")
    assert.equal(mounted.text(), "")
  } finally { mounted.dispose() }
})

test("Edit under a message that was not delivered takes back that message, not the newest", async () => {
  const mounted = mountComposerSubmission()
  try {
    mounted.type("first thought")
    mounted.send()
    await mounted.refuse()
    mounted.edit("local-1")
    assert.deepEqual(mounted.recalledEntries, ["local-1"])
    assert.equal(mounted.text(), "first thought")
  } finally { mounted.dispose() }
})

test("a second message while the first is on its way is its own send", async () => {
  const mounted = mountComposerSubmission()
  try {
    mounted.type("first")
    mounted.send()
    mounted.type("second")
    mounted.enter()
    assert.deepEqual(mounted.sent.map((entry) => entry.text), ["first", "second"])
    assert.equal(mounted.text(), "")
    await mounted.accept()
    assert.deepEqual(mounted.reports, [])
  } finally { mounted.dispose() }
})

test("with no session open, a send clears the composer at once and a second send is its own", async () => {
  const mounted = mountComposerSubmission()
  try {
    mounted.leaveSession()
    mounted.type("  first chat  ")
    await mounted.attach("draft.txt")
    mounted.send()
    assert.equal(mounted.text(), "")
    assert.equal(mounted.attachmentCount(), 0)
    assert.equal(mounted.sent.length, 1)
    assert.equal(mounted.sent[0]?.attachments?.[0]?.name, "draft.txt")
    mounted.type("second")
    mounted.enter()
    assert.equal(mounted.sent.length, 2)
    assert.equal(mounted.sent[1]?.text, "second")
    assert.equal(mounted.text(), "")
  } finally { mounted.dispose() }
})

test("an ordinary member view names that member's model assignment", async () => {
  const mounted = mountComposerSubmission()
  try {
    mounted.openWorkflow(true)
    mounted.openAgent("json")
    assert.equal(mounted.model(), "Model: gpt-6-luna, high effort")
  } finally { mounted.dispose() }
})

test("Escape in an agent view interrupts only that running agent and never falls back to its siblings", async () => {
  const mounted = mountComposerSubmission()
  try {
    mounted.openWorkflow(true)
    mounted.openAgent("json")
    assert.deepEqual(mounted.controlTitles(), ["Interrupt this agent. Its work so far is kept and it can resume."])
    mounted.type("/")
    assert.ok(mounted.labels().some(label => label.includes("Interrupt")))
    mounted.type("")
    mounted.key("Escape")
    await mounted.answer()
    assert.deepEqual(mounted.interruptTargets, [undefined])
    assert.deepEqual(mounted.interrupts, ["member-json"])
    mounted.interruptCommand()
    await mounted.answer()
    assert.deepEqual(mounted.interruptTargets, [undefined, undefined])
    mounted.openAgent("json", "parked")
    assert.deepEqual(mounted.controlTitles(), ["Resume this agent from where it stopped"])
    mounted.key("Escape")
    await mounted.answer()
    mounted.openAgent(undefined, "done")
    mounted.key("Escape")
    await mounted.answer()
    mounted.interruptCommand()
    await mounted.answer()
    assert.deepEqual(mounted.interruptTargets, [undefined, undefined])
  } finally { mounted.dispose() }
})

test("a slash command shows at the composer that it runs until it answers, and a repeat joins it", async () => {
  const mounted = mountComposerSubmission()
  try {
    mounted.hold()
    mounted.type("/compact now")
    mounted.enter()
    assert.equal(mounted.text(), "")
    assert.equal(mounted.placeholder(), "Running /compact…")
    assert.equal(mounted.sendWorking(), true)
    mounted.type("/compact now")
    mounted.enter()
    assert.equal(mounted.commands.length, 1)
    await mounted.answer()
    assert.equal(mounted.placeholder(), "Type your task here")
    assert.equal(mounted.sendWorking(), false)
  } finally { mounted.dispose() }
})

test("a running command shows at the composer only in the chat it runs in", async () => {
  const mounted = mountComposerSubmission()
  try {
    mounted.hold()
    mounted.type("/compact now")
    mounted.enter()
    assert.equal(mounted.placeholder(), "Running /compact…")
    mounted.openChat("other")
    assert.equal(mounted.placeholder(), "Type your task here")
    assert.equal(mounted.sendWorking(), false)
    mounted.openChat("chat")
    assert.equal(mounted.placeholder(), "Running /compact…")
    await mounted.answer()
  } finally { mounted.dispose() }
})

test("Up recalls the queued message under one action that shows at the composer, and a repeat joins it", async () => {
  const mounted = mountComposerSubmission()
  try {
    mounted.work()
    mounted.hold()
    mounted.key("ArrowUp")
    assert.equal(mounted.placeholder(), "Recalling the queued message…")
    mounted.key("ArrowUp")
    assert.equal(mounted.recalls(), 1)
    await mounted.answer()
    assert.equal(mounted.text(), "queued words")
  } finally { mounted.dispose() }
})

for (const [name, args] of [
  ["compact", "now"],
  ["probe", "requested change"],
  ["stats", 'add a "dark mode" toggle'],
] as const) {
  test(`exact /${name} accepts arguments without opening the panel or sending a message`, () => {
    const mounted = mountComposerSubmission()
    try {
      mounted.type(`/${name} ${args}`)
      assert.deepEqual(mounted.labels(), [])
      mounted.enter()
      assert.deepEqual(mounted.commands, [{ name, args }])
      assert.equal(mounted.text(), "")
      assert.equal(mounted.sent.length, 0)
    } finally { mounted.dispose() }
  })

  test(`Send invokes /${name} with or without arguments instead of sending a message`, () => {
    const mounted = mountComposerSubmission()
    try {
      for (const argument of ["", args]) {
        mounted.type(`/${name}${argument ? ` ${argument}` : ""}`)
        const count = mounted.commands.length
        mounted.send()
        assert.equal(mounted.commands.length, count + 1)
        assert.deepEqual(mounted.commands.at(-1), { name, args: argument })
        assert.equal(mounted.text(), "")
        assert.equal(mounted.sent.length, 0)
      }
    } finally { mounted.dispose() }
  })
}

for (const key of ["Enter", "Tab"]) {
  for (const [query, label, name] of [["/insp", "Inspect", "inspect"], ["/probe", "Review", "review"], ["/examine", "Review", "review"]] as const) {
    test(`${key} on ${query} runs the built-in command it names, under its one name`, () => {
      const mounted = mountComposerSubmission()
      try {
        mounted.type(query)
        assert.deepEqual(mounted.selected(), [label])
        mounted.key(key)
        assert.deepEqual(mounted.commands, [{ name, args: undefined }])
        assert.equal(mounted.text(), "")
        assert.equal(mounted.sent.length, 0)
      } finally { mounted.dispose() }
    })
  }

  test(`${key} opens the surface of the visible label-prefix match across groups`, () => {
    const mounted = mountComposerSubmission()
    try {
      for (const [query, label, surface] of [
        ["/status", "Status", "status"],
        ["/key", "Keyboard shortcuts", "shortcuts"],
        ["/search", "Find in transcripts", "find"],
        ["/find", "Find in transcripts", "find"],
      ] as const) {
        mounted.type(query)
        assert.deepEqual(mounted.selected(), [label])
        if (query === "/status") assert.deepEqual(mounted.labels(), ["Status", "Inspect"])
        mounted.key(key)
        assert.equal(mounted.opened.at(-1), surface)
        assert.equal(mounted.text(), "")
      }
      assert.deepEqual(mounted.commands, [])
      assert.deepEqual(mounted.settings, [])
      assert.deepEqual(mounted.sent, [])
    } finally { mounted.dispose() }
  })

  test(`${key} honors explicit arrow selection rather than the default match`, () => {
    const mounted = mountComposerSubmission()
    try {
      mounted.type("/s")
      const [first, second] = mounted.labels()
      assert.deepEqual(mounted.selected(), [first])
      mounted.key("ArrowDown")
      assert.deepEqual(mounted.selected(), [second])
      assert.notEqual(first, second)
      mounted.type("/key")
      mounted.key("ArrowDown")
      mounted.key("ArrowUp")
      assert.deepEqual(mounted.selected(), ["Keyboard shortcuts"])
      mounted.key(key)
      assert.deepEqual(mounted.opened, ["shortcuts"])
      assert.equal(mounted.sent.length, 0)
    } finally { mounted.dispose() }
  })
}

for (const key of ["Enter", "Tab"]) {
  test(`${key} on an exact token opens that command, before a command whose name starts with the word`, () => {
    const mounted = mountComposerSubmission()
    try {
      for (const [query, label, sheet] of [["/model", "Models", "models"], ["/effort", "Model and effort", "model"], ["/model-and-effort", "Model and effort", "model"]] as const) {
        mounted.type(query)
        assert.deepEqual(mounted.selected(), [label])
        mounted.key(key)
        assert.equal(mounted.opened.at(-1), sheet)
      }
    } finally { mounted.dispose() }
  })
}

test("a typed surface command hands its argument to the surface it opens", () => {
  const mounted = mountComposerSubmission()
  try {
    for (const [text, opened] of [["/find error", "find:error"], ["/search error", "find:error"], ["/profile Personal", "profiles:Personal"], ["/profile", "profiles"]] as const) {
      mounted.type(text)
      mounted.send()
      assert.equal(mounted.opened.at(-1), opened)
    }
    assert.equal(mounted.sent.length, 0)
  } finally { mounted.dispose() }
})

test("multi-word setting queries remain searchable and do not send a message", () => {
  const mounted = mountComposerSubmission()
  try {
    mounted.type("/auto compact")
    assert.deepEqual(mounted.selected(), ["Auto compact at"])
    mounted.enter()
    assert.deepEqual(mounted.opened, ["settings"])
    assert.deepEqual(mounted.prompts, [])
    assert.equal(mounted.text(), "")
    assert.equal(mounted.sent.length, 0)
  } finally { mounted.dispose() }
})

test("a bare slash opens on the top commands with no Most used, and background changes preserve selection and row identity", () => {
  const mounted = mountComposerSubmission()
  try {
    mounted.type("/")
    assert.deepEqual(mounted.sections(), ["Common", "Settings", "Chat", "More"])
    // Skills answer to typing only.
    assert.deepEqual(mounted.labels().filter((label) => label.startsWith("/")), [])
    mounted.type("/s")
    const rows = mounted.rows()
    const labels = mounted.labels()
    const sections = mounted.sections()
    assert.ok(new Set(sections).size < sections.length, "Ranked groups must have separate noncontiguous runs")
    assert.equal(new Set(labels).size, labels.length)
    mounted.key("ArrowDown")
    const selected = mounted.selected()
    mounted.refresh()
    assert.deepEqual(mounted.selected(), selected)
    assert.ok(mounted.rows().every((row, index) => row === rows[index]))
    mounted.type("/")
    const statusIndex = mounted.labels().indexOf("Status")
    for (let index = 0; index < statusIndex; index += 1) mounted.key("ArrowDown")
    const statusRow = mounted.rows()[statusIndex]
    assert.deepEqual(mounted.selected(), ["Status"])
    for (const pending of [true, false]) {
      mounted.publishBackground(pending)
      assert.equal(mounted.labels().includes("Background work"), pending)
      assert.deepEqual(mounted.selected(), ["Status"])
      assert.equal(mounted.rows().find((row) => row.properties["aria-selected"] === true), statusRow)
    }
    mounted.publishBackground(true)
    mounted.type("/background")
    assert.deepEqual(mounted.selected(), ["Background work"])
    mounted.enter()
    assert.deepEqual(mounted.opened, ["background"])
  } finally { mounted.dispose() }
})

test("a typed skill id is unknown text: refused and kept unless a built-in matches, never sent as a skill", () => {
  // The runtime's /experiment descriptor, whose description holds the word "design".
  const mounted = mountComposerSubmission({ catalog: { revision: 1, builtInCommands: [{ id: "experiment", title: "Experiment", description: "Run an experiment loop: design <goal>, start, off, clear, finalize, or dashboard", aliases: [] }], offCommands: [] } })
  try {
    // "/design" matches the Experiment row: send refuses the typed token, and Enter runs the top row.
    for (const [text, submit] of [["/learned.conventions", mounted.send], ["/learned.conventions", mounted.enter], ["/plan add a dark mode toggle", mounted.send], ["/plan add a dark mode toggle", mounted.enter], ["/design", mounted.send]] as const) {
      mounted.type(text)
      submit()
      assert.deepEqual([mounted.text(), mounted.reports.at(-1), mounted.commands], [text, UNKNOWN_COMMAND_NOTICE, []])
    }
    assert.deepEqual([mounted.reports.length, mounted.labels()], [5, ["Experiment"]])
    mounted.enter()
    assert.deepEqual([mounted.sent, mounted.commands.map((command) => command.name)], [[], ["experiment"]])
  } finally { mounted.dispose() }
})

test("slash text no command owns is refused with the one notice and kept, and attached commands and multiword actions stay messages", async () => {
  const mounted = mountComposerSubmission()
  try {
    for (const text of ["/summ", "/no matching action"]) {
      mounted.type(text)
      assert.deepEqual(mounted.labels(), [])
      mounted.enter()
      assert.equal(mounted.text(), text)
    }
    assert.deepEqual(mounted.reports, [UNKNOWN_COMMAND_NOTICE, UNKNOWN_COMMAND_NOTICE])
    assert.equal(mounted.sent.length, 0)
    for (const text of ["/compact now", "/probe requested change", "/auto compact"]) {
      mounted.type(text)
      await mounted.attach("draft.txt")
      assert.deepEqual(mounted.labels(), [])
      const sentBefore: number = mounted.sent.length
      mounted.enter()
      assert.equal(mounted.sent.length, sentBefore + 1)
      assert.ok(mounted.sent.at(-1)?.text.startsWith(text))
      assert.equal(mounted.sent.at(-1)?.attachments?.[0]?.name, "draft.txt")
      assert.equal(mounted.text(), "")
      assert.equal(mounted.attachmentCount(), 0)
      assert.deepEqual(mounted.commands, [])
      assert.deepEqual(mounted.prompts, [])
      await mounted.accept()
    }
  } finally { mounted.dispose() }
})

test("a slash command sent before the command catalog arrives waits for it and is never sent to the model as text", async () => {
  const mounted = mountComposerSubmission({ catalogLater: true })
  try {
    mounted.type("/inspect")
    mounted.enter()
    assert.equal(mounted.text(), "")
    assert.equal(mounted.placeholder(), "Running /inspect…")
    mounted.type("/summ")
    mounted.enter()
    assert.equal(mounted.sent.length, 0)
    assert.equal(mounted.commands.length, 0)
    await mounted.arriveCatalog()
    assert.deepEqual(mounted.commands, [{ name: "inspect", args: "" }])
    // Once the catalog is known, slash text that no command owns is refused and comes back.
    assert.deepEqual(mounted.sent, [])
    assert.deepEqual(mounted.reports, [UNKNOWN_COMMAND_NOTICE])
    assert.equal(mounted.text(), "/summ")
  } finally { mounted.dispose() }
})

test("a command only a turned-off module provides, or a retired workflow command, answers its refusal, opens no panel, and keeps the draft", () => {
  const mounted = mountComposerSubmission()
  try {
    for (const text of ["/drain", "/sweep", "/workflow:debug", "/workflow:debug fix the flaky test"]) {
      mounted.type(text)
      assert.deepEqual(mounted.labels(), [])
      mounted.enter()
      assert.equal(mounted.text(), text)
    }
    assert.deepEqual(mounted.reports, [
      '"/drain" needs the Papercuts module, which is off. Turn it on in Settings.',
      '"/sweep" needs the Papercuts module, which is off. Turn it on in Settings.',
      'Unknown command "/workflow:debug". Ask the chat to write and launch a workflow.',
      'Unknown command "/workflow:debug". Ask the chat to write and launch a workflow.',
    ])
    assert.deepEqual(mounted.sent, [])
    assert.deepEqual(mounted.commands, [])
  } finally { mounted.dispose() }
})

test("a question in a kept window keeps its dock while settlement waits for a current window", async () => {
  const mounted = mountComposerSubmission()
  try {
    const block = {
      kind: "question" as const, toolUseId: "draft", timestamp: 1,
      questions: [{ question: "Which file?", multiSelect: false, choices: [{ kind: "option" as const, choiceId: "file", label: "a.ts", requiresText: true }, { kind: "freeform" as const, label: "Other" }] }],
    }
    mounted.publishQuestionBlock(block)
    mounted.clickQuestion("a.ts")
    await mounted.settle()
    const field = mounted.elements().find((node) => node.properties["aria-label"] === "a.ts: Which file?")
    assert.ok(field)
    const input = field.properties.onInput
    const keydown = field.properties.onKeyDown
    assert.equal(typeof input, "function")
    assert.equal(typeof keydown, "function")
    if (typeof input === "function") input({ currentTarget: Object.assign(field, { value: "a.ts" }) })
    mounted.unmerged()
    if (typeof keydown === "function") keydown({ key: "Enter", shiftKey: false, preventDefault() {} })
    mounted.clickQuestion("Skip")
    await mounted.settle()
    assert.equal(mounted.questionAnswers.length, 0)
    assert.equal(mounted.questionSkips.length, 0)
    const skip = () => mounted.elements().find((node) => node.tag === "button" && textContent(node) === "Skip")
    mounted.merged()
    assert.equal(mounted.question(), true)
    if (typeof keydown === "function") keydown({ key: "Enter", shiftKey: false, preventDefault() {} })
    await mounted.settle()
    assert.equal(mounted.questionAnswers.length, 1)
    mounted.publishQuestionBlock({ ...block, toolUseId: "skip" })
    mounted.unmerged()
    mounted.clickQuestion("Skip")
    await mounted.settle()
    assert.equal(mounted.questionSkips.length, 0)
    mounted.merged()
    mounted.clickQuestion("Skip")
    await mounted.settle()
    assert.deepEqual(mounted.questionSkips, ["skip"])
    mounted.publishQuestionBlock({
      ...block, toolUseId: "pick",
      questions: [{ question: "Which file?", multiSelect: false, choices: [{ kind: "option", choiceId: "file", label: "a.ts" }, { kind: "freeform", label: "Other" }] }],
    })
    mounted.unmerged()
    mounted.clickQuestion("a.ts")
    await mounted.settle()
    assert.equal(mounted.questionAnswers.length, 1)
    const row = mounted.elements().find((node) => node.properties.class === "question-choice-row")
    assert.equal(row?.properties["aria-checked"], true, "a held window keeps local picks editable")
    assert.equal(skip()?.properties["aria-disabled"], "true", "held actions must not use native disabled")
    const answer = mounted.elements().find((node) => node.tag === "button" && textContent(node) === "Answer")
    assert.equal(answer?.properties["aria-disabled"], "true")
    assert.equal(answer?.properties.title, "Waiting for the latest messages")
    assert.equal(skip()?.properties.title, "Waiting for the latest messages")
    mounted.clickQuestion("Answer")
    await mounted.settle()
    assert.equal(mounted.questionAnswers.length, 1, "held Answer must not submit a local pick")
    mounted.merged()
    assert.equal(mounted.questionAnswers.length, 1, "a local pick waits for explicit submission")
    mounted.clickQuestion("Answer")
    await mounted.settle()
    assert.equal(mounted.questionAnswers.length, 2)
    assert.equal(mounted.questionAnswers[1]?.toolUseId, "pick")
  } finally { mounted.dispose() }
})

test("a question settled through a path the transcript never received leaves the dock", async () => {
  const mounted = mountComposerSubmission()
  try {
    mounted.publishQuestion(true)
    assert.equal(mounted.question(), true)
    mounted.settleOutsideTranscript()
    assert.equal(mounted.question(), false, "the dock follows the question projection, not the transcript's block")
  } finally { mounted.dispose() }
})

test("Escape skips the docked question from the panel or the composer, and interrupts only while no question waits", async () => {
  const mounted = mountComposerSubmission()
  try {
    mounted.publishQuestion(true)
    const panel = mounted.elements().find((node) => node.properties.class === "command-panel question-panel")
    const onKeyDown = panel?.properties.onKeyDown
    assert.equal(typeof onKeyDown, "function")
    if (typeof onKeyDown === "function") onKeyDown({ key: "Escape", shiftKey: false, preventDefault() {}, stopPropagation() {} })
    await mounted.settle()
    assert.deepEqual(mounted.questionSkips, ["ask"])
    mounted.work()
    mounted.key("Escape")
    await mounted.settle()
    assert.deepEqual(mounted.questionSkips, ["ask", "ask"])
    assert.deepEqual(mounted.interrupts, [])
  } finally { mounted.dispose() }
})

test("a selected child shows no question panel, and its composer messages it", async () => {
  const mounted = mountComposerSubmission()
  try {
    // The root chat's own question docks in its panel.
    mounted.publishQuestion(true)
    assert.equal(mounted.question(), true)
    // A child asks its parent, never the person, so its pane has no panel.
    mounted.openWorkflow(true)
    mounted.openAgent("t1")
    assert.equal(mounted.question(), false)
    assert.equal(mounted.placeholder(), "Message item t1")
    mounted.type("check the tests")
    assert.equal(mounted.sendLabel(), "Send message")
  } finally { mounted.dispose() }
})

test("Resume in a kept window waits until the window is current", async () => {
  const mounted = mountComposerSubmission()
  try {
    mounted.openStoppedSubagent()
    assert.equal(mounted.resumeOffered(), true)
    mounted.unmerged()
    assert.equal(mounted.resumeOffered(), false, "the run may have resumed elsewhere while the lane was down")
    mounted.merged()
    assert.equal(mounted.resumeOffered(), true)
  } finally { mounted.dispose() }
})

test("words typed while the new chat is being created stay in the composer of the chat it creates", async () => {
  const mounted = mountComposerSubmission()
  try {
    mounted.leaveSession()
    mounted.type("first message")
    mounted.send()
    mounted.type("second thought")
    mounted.openCreated("created")
    assert.equal(mounted.text(), "second thought")
    mounted.openChat("chat")
    mounted.leaveSession()
    assert.equal(mounted.text(), "", "the new chat's pane starts empty again")
  } finally { mounted.dispose() }
})

test("a member view sends ordinary session input and takes no file", async () => {
  const mounted = mountComposerSubmission()
  try {
    mounted.openWorkflow(true)
    mounted.openAgent("t2")
    assert.equal(mounted.placeholder(), "Message item t2")
    mounted.type("Keep the old flag names.")
    mounted.send()
    await Promise.resolve()
    assert.deepEqual(mounted.sent, [{ text: "Keep the old flag names.", attachments: undefined }])
    assert.equal(mounted.text(), "")
    await mounted.attach("later.txt")
    assert.equal(mounted.attachmentCount(), 0)
    assert.equal(mounted.reports.at(-1), "This message takes words only, so the file was not added.")
    assert.equal(mounted.sent.length, 1)
  } finally { mounted.dispose() }
})

test("an agent view and a subagent view refuse an unknown token and a chat command, and open a surface, never sending any", () => {
  const mounted = mountComposerSubmission()
  try {
    for (const [open, view] of [[() => { mounted.openWorkflow(true); mounted.openAgent("t2") }, "workflow agent"], [() => { mounted.closeAgent(); mounted.closeWorkflow(); mounted.openSubagent() }, "subagent"]] as const) {
      open()
      mounted.type("/xyzzy")
      mounted.send()
      assert.equal(mounted.text(), "/xyzzy")
      assert.equal(mounted.reports.at(-1), UNKNOWN_COMMAND_NOTICE)
      // A command the runtime runs on a chat is refused before dispatch
      // under the command's own token, and the draft stays. Enter on an exact token picks its command menu row, which
      // refuses the same way as the send control.
      mounted.type("/compact")
      assert.deepEqual(mounted.selected(), ["Compact conversation"])
      for (const [typed, named] of [["/compact", "compact"], ["/compact x", "compact"]] as const) {
        for (const submit of [mounted.send, mounted.enter]) {
          mounted.type(typed)
          submit()
          assert.equal(mounted.text(), typed)
          assert.equal(mounted.reports.at(-1), `/${named} works in a chat, not in this ${view}`)
        }
      }
      mounted.type("/status ")
      mounted.send()
      assert.equal(mounted.opened.at(-1), "status")
      assert.equal(mounted.text(), "")
    }
    assert.deepEqual(mounted.sent, [])
    assert.deepEqual(mounted.commands.filter((command) => command.name === "compact"), [])
  } finally { mounted.dispose() }
})
