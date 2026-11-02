import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test"
import { containNotifyFailures } from "../../../../src/orchestration/app-service/contained-notify.js"
import { Log } from "../../../../src/infra/log.js"
import type { NotificationEpisodeInput } from "../../../../src/infra/notification-episode.js"

const secret = "Reconnect the account named private-account-name."
const episode: NotificationEpisodeInput = { type: "raise", occurrence: { sourceId: "runtime:probe", title: "Probe needs attention", message: secret, severity: "warning", action: { kind: "open-settings" } } }
const records: { readonly message: unknown; readonly fields: { readonly [key: string]: unknown } | undefined }[] = []
let errorLog: ReturnType<typeof spyOn> | undefined

beforeEach(() => { errorLog = spyOn(Log.create({ service: "notify" }), "error").mockImplementation((message, fields) => { records.push({ message, fields }) }) })
afterEach(() => {
  errorLog?.mockRestore()
  records.length = 0
})

describe("contained notify", () => {
  test("a refusing channel records once, counts the repeats until a delivery lands, and never rejects", async () => {
    let refusing = true
    const contained = containNotifyFailures(async () => { if (refusing) throw new Error("Notification capacity exceeded") })

    for (let attempt = 0; attempt < 3; attempt += 1) await expect(contained.notify(episode)).resolves.toBeUndefined()
    expect(records.map(({ message }) => message)).toEqual(["notification delivery failed"])

    refusing = false
    await contained.notify(episode)
    expect(records).toEqual([
      { message: "notification delivery failed", fields: { error: "Notification capacity exceeded", operation: "raise" } },
      { message: "notification delivery failed again", fields: { error: "Notification capacity exceeded", count: 2, windowMs: expect.any(Number) } },
    ])

    // The recovery ended the condition, so the next failure records in full again.
    refusing = true
    await contained.notify(episode)
    expect(records.map(({ message }) => message).at(-1)).toBe("notification delivery failed")
    expect(JSON.stringify(records)).not.toContain(secret)
    contained.end()
  })

  test("shutdown reports the repeats still counted", async () => {
    const contained = containNotifyFailures(async () => { throw new Error("notification admission is closed") })
    await contained.notify(episode)
    await contained.notify(episode)
    contained.end()
    expect(records.map(({ message, fields }) => [message, fields?.count])).toEqual([
      ["notification delivery failed", undefined],
      ["notification delivery failed again", 1],
    ])
  })
})
