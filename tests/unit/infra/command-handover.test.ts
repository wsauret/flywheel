import { afterEach, describe, expect, test } from "bun:test"
import { readFileSync, statSync, writeFileSync } from "node:fs"
import { dirname, join } from "node:path"

import {
  decodeSupervisorAnswer,
  decodeSupervisorWord,
  encodeSupervisorAnswer,
  encodeSupervisorWord,
  handoverChannelAddress,
  readOutcomeRecord,
  writeOutcomeRecord,
} from "../../../src/infra/command-handover.js"
import type { DebugLogRecordInput } from "../../../src/infra/debug-log.js"
import { Log } from "../../../src/infra/log.js"
import { accountServeDir, accountServeSocketPath } from "../../../src/infra/paths.js"
import { temporaryDirectories } from "../../helpers/directories.js"

const temporary = temporaryDirectories()

/** Version 1 records exactly as a version 1 supervisor writes them. A later
 *  release must still read these bytes. */
const RECORD_HANDED_OVER = `{"version":1,"handedOverAtMs":1758800000000}`
const RECORD_ENDED = `{"version":1,"handedOverAtMs":1758800000000,"outcome":{"code":3,"signal":null,"deadlineExpired":false,"endedAtMs":1758800004000}}`
const RECORD_KILLED_AT_DEADLINE = `{"version":1,"handedOverAtMs":1758800000000,"outcome":{"code":null,"signal":"SIGTERM","deadlineExpired":true,"endedAtMs":1758800060000}}`

/** Version 1 channel words exactly as a version 1 peer sends them. */
const WORDS = {
  go: "go",
  stop: "stop",
  handover: `handover {"v":1,"channel":"/home/a/.flywheel/serve/h0123456789","recordPath":"/p/.flywheel/sessions/s/scratch/bash/c.outcome.json","userDataRoot":"/home/a/.flywheel","deadlineAtMs":1758800060000}`,
  handoverWithoutDeadline: `handover {"v":1,"channel":"\\\\\\\\.\\\\pipe\\\\Flywheel.handover.owned:1","recordPath":"C:\\\\p\\\\c.outcome.json","userDataRoot":"C:\\\\Users\\\\a\\\\.flywheel"}`,
  adopt: `adopt {"v":1,"guardianPid":4242,"guardianIdentity":"4242 4242 1758800000.000001"}`,
}
const ANSWERS = {
  adopted: "adopted",
  refused: `refused {"versions":[1]}`,
}

async function capturedWarnings<T>(read: () => T): Promise<{ readonly value: T; readonly warnings: readonly DebugLogRecordInput[] }> {
  const records: DebugLogRecordInput[] = []
  await Log.init({ forward: (record) => { records.push(record) } })
  try {
    return { value: read(), warnings: records.filter((record) => record.type === "log.warn") }
  } finally {
    await Log.closeGlobal()
  }
}

describe("command outcome record", () => {
  let dir = ""
  afterEach(() => { dir = "" })
  const recordAt = (text: string): string => {
    dir ||= temporary("command-handover-")
    const file = join(dir, "command.outcome.json")
    writeFileSync(file, text)
    return file
  }

  test("reads each version 1 record as the typed record it states", () => {
    expect(readOutcomeRecord(recordAt(RECORD_HANDED_OVER))).toEqual({ kind: "record", record: { version: 1, handedOverAtMs: 1758800000000 } })
    expect(readOutcomeRecord(recordAt(`{"version":1,"handedOverAtMs":1758800000000,"supervisorIdentity":"7070 7070 1758800000.000001"}`))).toEqual({
      kind: "record", record: { version: 1, handedOverAtMs: 1758800000000, supervisorIdentity: "7070 7070 1758800000.000001" },
    })
    expect(readOutcomeRecord(recordAt(RECORD_ENDED))).toEqual({
      kind: "record",
      record: { version: 1, handedOverAtMs: 1758800000000, outcome: { code: 3, signal: null, deadlineExpired: false, endedAtMs: 1758800004000 } },
    })
    expect(readOutcomeRecord(recordAt(RECORD_KILLED_AT_DEADLINE))).toEqual({
      kind: "record",
      record: { version: 1, handedOverAtMs: 1758800000000, outcome: { code: null, signal: "SIGTERM", deadlineExpired: true, endedAtMs: 1758800060000 } },
    })
  })

  test("writes a record that reads back as itself, readable by its owner only", () => {
    const file = join(temporary("command-handover-"), "command.outcome.json")
    const record = { version: 1, handedOverAtMs: 1758800000000, outcome: { code: 3, signal: null, deadlineExpired: false, endedAtMs: 1758800004000 } } as const

    writeOutcomeRecord(file, record)

    expect(readFileSync(file, "utf8")).toBe(RECORD_ENDED)
    expect(readOutcomeRecord(file)).toEqual({ kind: "record", record })
    if (process.platform !== "win32") expect(statSync(file).mode & 0o777).toBe(0o600)
  })

  test("reports a record of another version, warns, and leaves the file byte for byte", async () => {
    const text = `{"version":2,"handedOverAtMs":1758800000000,"handoff":"h1"}`
    const file = recordAt(text)

    const { value, warnings } = await capturedWarnings(() => readOutcomeRecord(file))

    expect(value).toEqual({ kind: "unreadable", reason: expect.stringContaining("version 2") })
    expect(warnings).toHaveLength(1)
    expect(warnings[0]?.payload).toMatchObject({ recordPath: file })
    expect(readFileSync(file, "utf8")).toBe(text)
  })

  test("never reads a version 1 record of the wrong shape in part", async () => {
    const file = recordAt(`{"version":1,"handedOverAtMs":1758800000000,"outcome":{"code":"3","signal":null,"deadlineExpired":false,"endedAtMs":1}}`)

    const { value } = await capturedWarnings(() => readOutcomeRecord(file))

    expect(value.kind).toBe("unreadable")
  })

  test("reads a missing record as absent: the command was never handed over", () => {
    expect(readOutcomeRecord(join(temporary("command-handover-"), "never.outcome.json"))).toEqual({ kind: "absent" })
  })
})

describe("supervisor channel words", () => {
  test("decodes each version 1 word to its typed value and encodes it back byte for byte", () => {
    const decoded = {
      go: decodeSupervisorWord(WORDS.go),
      stop: decodeSupervisorWord(WORDS.stop),
      handover: decodeSupervisorWord(WORDS.handover),
      handoverWithoutDeadline: decodeSupervisorWord(WORDS.handoverWithoutDeadline),
      adopt: decodeSupervisorWord(WORDS.adopt),
    }

    expect(decoded).toEqual({
      go: { kind: "go" },
      stop: { kind: "stop" },
      handover: {
        kind: "handover",
        handover: {
          channel: "/home/a/.flywheel/serve/h0123456789",
          recordPath: "/p/.flywheel/sessions/s/scratch/bash/c.outcome.json",
          userDataRoot: "/home/a/.flywheel",
          deadlineAtMs: 1758800060000,
        },
      },
      handoverWithoutDeadline: {
        kind: "handover",
        handover: { channel: String.raw`\\.\pipe\Flywheel.handover.owned:1`, recordPath: String.raw`C:\p\c.outcome.json`, userDataRoot: String.raw`C:\Users\a\.flywheel` },
      },
      adopt: { kind: "adopt", adoption: { guardianPid: 4242, guardianIdentity: "4242 4242 1758800000.000001" } },
    })
    for (const [name, line] of Object.entries(WORDS)) {
      const word = decodeSupervisorWord(line)
      if (word.kind === "unknown") throw new Error(`${name} did not decode`)
      expect(encodeSupervisorWord(word)).toBe(line)
    }
  })

  test("decodes each version 1 answer to its typed value and encodes it back byte for byte", () => {
    expect(decodeSupervisorAnswer(ANSWERS.adopted)).toEqual({ kind: "adopted" })
    expect(decodeSupervisorAnswer(ANSWERS.refused)).toEqual({ kind: "refused", versions: [1] })
    expect(encodeSupervisorAnswer({ kind: "adopted" })).toBe(ANSWERS.adopted)
    expect(encodeSupervisorAnswer({ kind: "refused", versions: [1] })).toBe(ANSWERS.refused)
  })

  test("reads a handover or adopt payload of another version as unknown, never as a partial value", () => {
    const handover = WORDS.handover.replace(`"v":1`, `"v":2`)
    const adopt = WORDS.adopt.replace(`"v":1`, `"v":2`)

    expect(decodeSupervisorWord(handover)).toEqual({ kind: "unknown", word: "handover" })
    expect(decodeSupervisorWord(adopt)).toEqual({ kind: "unknown", word: "adopt" })
    // A payload of this version with a key it does not define is not a
    // version 1 word either.
    expect(decodeSupervisorWord(WORDS.adopt.replace("}", `,"lease":"x"}`))).toEqual({ kind: "unknown", word: "adopt" })
    expect(decodeSupervisorWord("adopt")).toEqual({ kind: "unknown", word: "adopt" })
    expect(decodeSupervisorWord("go now")).toEqual({ kind: "unknown", word: "go" })
    expect(decodeSupervisorAnswer(`refused {"versions":["1"]}`)).toEqual({ kind: "unknown", word: "refused" })
  })
})

describe("handover channel address", () => {
  const TOKEN = "owned:11111111-2222-3333-4444-555555555555"

  test("puts a POSIX channel in the account service's directory, named no longer than the account socket beside it", () => {
    // The shape of the replacement harness's short account home, after the
    // symlinked temporary root is resolved.
    const userDataRoot = "/private/tmp/fw-replacement-hold-AbCdEf/home/.flywheel"

    for (const lane of ["installed", "dev"] as const) {
      const address = handoverChannelAddress({ userDataRoot, lane, token: TOKEN }, "darwin")

      expect(dirname(address)).toBe(accountServeDir(userDataRoot, lane))
      // A home whose account socket fits the path limit holds every channel.
      expect(Buffer.byteLength(address)).toBeLessThanOrEqual(Buffer.byteLength(accountServeSocketPath(userDataRoot, lane, "darwin")))
    }
    // One command, one address: another token never names the same channel.
    expect(handoverChannelAddress({ userDataRoot, lane: "dev", token: TOKEN }, "linux"))
      .not.toBe(handoverChannelAddress({ userDataRoot, lane: "dev", token: "owned:other" }, "linux"))
  })

  test("names the Windows pipe by the ownership token", () => {
    expect(handoverChannelAddress({ userDataRoot: String.raw`C:\Users\a\.flywheel`, lane: "installed", token: TOKEN }, "win32"))
      .toBe(String.raw`\\.\pipe\Flywheel.handover.${TOKEN}`)
  })
})
