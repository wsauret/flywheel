import { describe, expect, it } from "bun:test"

import { containsSecret, redactDeep, redactSecretEntries, redactSecrets, redactSecretsPrefix, redactSecretsWork } from "../../../src/infra/redact-secrets.js"
import { SLOW_UNIT_BUDGET_MS } from "../../../src/infra/event-loop-lag.js"
import { runInTaskSlices } from "../../../src/infra/task-scheduling.js"

/** Redacts text with the synchronous form, and with the cooperative form on a
 *  clock that ends the slice after every unit. Fails unless the two forms give
 *  the same bytes and the cooperative form gave the task queue more than one turn. */
async function redactBothForms(text: string, options: { readonly completeness?: "complete" | "prefix" } = {}): Promise<string> {
  let clock = 0
  let yields = 0
  const sliced = await runInTaskSlices("test:redact", redactSecretsWork(text, options), {
    now: () => (clock += SLOW_UNIT_BUDGET_MS),
    yieldToNextTask: async () => { yields += 1 },
  })
  expect(sliced).toBe(redactSecrets(text, options))
  expect(yields).toBeGreaterThan(1)
  return sliced
}

describe("redactSecretEntries", () => {
  it("preserves multiline, empty, and trailing entry boundaries across a complete private key", () => {
    const begin = `-----BEGIN ${"PRIVATE KEY"}-----`
    const end = `-----END ${"PRIVATE KEY"}-----`
    const entries = Object.freeze(["", `before\n${begin}\nbody\n`, "", `${end}\nafter\n`, ""])
    expect(redactSecretEntries(entries)).toEqual(["", "before\n[redacted secret]\n\n", "", "\nafter\n", ""])
    expect(entries).toEqual(["", `before\n${begin}\nbody\n`, "", `${end}\nafter\n`, ""])
    expect(redactSecretEntries([])).toEqual([])
    expect(redactSecretEntries(["", "\n", ""])).toEqual(["", "\n", ""])
  })

  it("uses the central complete and prefix rules without changing ordinary redaction output", () => {
    for (const kind of ["PRIVATE KEY", "RSA PRIVATE KEY", "EC PRIVATE KEY", "OPENSSH PRIVATE KEY"]) {
      const entries = [`-----BEGIN ${kind}-----`, "body\n", ""]
      const text = entries.join("\n")
      expect(redactSecretEntries(entries)).toEqual(entries)
      expect(redactSecretEntries(entries, "complete")).toEqual(entries)
      expect(redactSecretEntries(entries, "prefix")).toEqual(["[redacted secret]", "\n", ""])
      expect(redactSecrets(text)).toBe(text)
      expect(redactSecrets(text, { completeness: "prefix" })).toBe("[redacted secret]")
      expect(containsSecret(text)).toBe(false)
      expect(redactDeep({ text })).toEqual({ text })
    }
    const publicKey = ["-----BEGIN PUBLIC KEY-----", "body"]
    expect(redactSecretEntries(publicKey, "prefix")).toEqual(publicKey)
  })

  it("preserves matched newlines in non-key credentials across entries", () => {
    const credential = "aB3_".repeat(10)
    const entries = ["before Bearer\n", `${credential} after`, ""]
    expect(redactSecretEntries(entries)).toEqual(["before [redacted secret]\n", " after", ""])
    expect(redactSecrets(entries.join("\n"))).toBe("before [redacted secret] after\n")
  })
})

describe("redactSecrets", () => {
  it("redacts cut private-key prefixes only at an explicitly incomplete boundary", () => {
    for (const kind of ["PRIVATE KEY", "RSA PRIVATE KEY", "EC PRIVATE KEY", "OPENSSH PRIVATE KEY"]) {
      const begin = `-----BEGIN ${kind}-----`
      const end = `-----END ${kind}-----`
      const incomplete = `${begin}\nprivate-body`
      const complete = `${incomplete}\n${end}`
      expect(redactSecrets(`before\n${incomplete}`, { completeness: "prefix" })).toBe("before\n[redacted secret]")
      expect(redactSecrets(`${complete}\nafter`, { completeness: "prefix" })).toBe("[redacted secret]\nafter")
      expect(redactSecrets(complete)).toBe("[redacted secret]")
      expect(redactSecrets(incomplete)).toBe(incomplete)
      expect(redactSecrets(incomplete, { completeness: "complete" })).toBe(incomplete)
      expect(containsSecret(incomplete)).toBe(false)
      expect(containsSecret(complete)).toBe(true)
      expect(redactDeep({ value: incomplete })).toEqual({ value: incomplete })
    }
    const publicPrefix = ["-----BEGIN PUBLIC KEY-----", "public-body"].join("\n")
    expect(redactSecrets(publicPrefix, { completeness: "prefix" })).toBe(publicPrefix)
  })

  it("redacts OpenAI project keys", () => {
    const secret = ["sk", "proj", "aB3".repeat(12)].join("-")
    expect(redactSecrets(`key ${secret} done`)).toBe("key [redacted secret] done")
  })

  it("redacts Google AIza keys", () => {
    const out = redactSecrets("token AIzaSyA1234567890abcdefghij_klmnop end")
    expect(out).toContain("[redacted secret]")
    expect(out).not.toContain("AIzaSy")
  })

  it("redacts JWT-shaped tokens", () => {
    const jwt = "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NSJ9.abc-DEF_123"
    expect(redactSecrets(`bearer ${jwt}`)).toBe("bearer [redacted secret]")
  })

  it("redacts every secret in a string, not just the first", () => {
    const first = ["sk", "proj", "aB3".repeat(12)].join("-")
    const second = ["sk", "ant", "api03", "dE5".repeat(12)].join("-")
    const out = redactSecrets(`a ${first} b ${second} c`)
    expect(out.match(/\[redacted secret\]/g)).toHaveLength(2)
  })

  it("classifies common standalone credential families", () => {
    const credentials = [
      ["ghp", "A".repeat(36)].join("_"),
      ["github", "pat", "11AA", "B".repeat(40)].join("_"),
      `xoxb-${"1".repeat(12)}-${"a".repeat(24)}`,
      `AKIA${"A1".repeat(8)}`,
      `Bearer ${"aB3_".repeat(10)}`,
      `npm_${"aB3".repeat(12)}`,
      `glpat-${"aB3".repeat(10)}`,
    ]

    for (const credential of credentials) {
      expect(containsSecret(`credential ${credential}`)).toBe(true)
      expect(redactSecrets(`credential ${credential}`)).not.toContain(credential)
      expect(redactSecretEntries([`credential ${credential}`, "after"])).toEqual(["credential [redacted secret]", "after"])
    }
  })

  it("classifies private keys", () => {
    const privateKey = ["-----BEGIN PRIVATE KEY-----", "aB3/".repeat(20), "-----END PRIVATE KEY-----"].join("\n")

    expect(containsSecret(privateKey)).toBe(true)
    expect(redactSecrets(privateKey)).toBe("[redacted secret]")
  })

  it("does not classify values without a recognized credential format", () => {
    expect(containsSecret("step 3 completed in 404ms with status ok")).toBe(false)
    expect(containsSecret(`sha256:${"a".repeat(64)}`)).toBe(false)
    expect(containsSecret("aB3dE5fG7hJ9kLmN2pQrS4tUvW6xYz8+")).toBe(false)
  })

  it("leaves credential-named assignments unchanged when their values have no recognized format", () => {
    for (const input of [
      "API_KEY=abc123",
      "export DB_PASSWORD=hunter2",
      "SESSION_TOKEN=abc",
      "AUTH_TOKEN = xK9.q2/wZ",
      "GITHUB_TOKEN=ghp_unshapedvalue123",
    ]) {
      expect(redactSecrets(input)).toBe(input)
      expect(containsSecret(input)).toBe(false)
    }
  })

  it("redacts a recognized value regardless of its variable name", () => {
    const secret = ["sk", "proj", "aB3".repeat(12)].join("-")
    expect(redactSecrets(`ORDINARY_VALUE=${secret}`)).toBe("ORDINARY_VALUE=[redacted secret]")
  })

  it("does not treat a dash-prefixed identifier as an sk- key", () => {
    expect(redactSecrets("--sk-color: red")).toBe("--sk-color: red")
  })

  it("does not classify short sk-prefixed values or placeholders", () => {
    for (const input of ["sk-test", "sk-placeholder-value", "sk-********************"]) {
      expect(redactSecrets(input)).toBe(input)
      expect(containsSecret(input)).toBe(false)
    }
  })

  it("masks each credential family byte for byte and leaves its near misses unchanged in both forms", async () => {
    const masked = [
      ["sk", "proj", "aB3".repeat(12)].join("-"),
      ["sk", "ant", "api03", "dE5".repeat(12)].join("-"),
      `sk-${"a1".repeat(20)}`,
      `sk_live_${"a1".repeat(8)}`,
      `rk_test_${"B2".repeat(8)}`,
      `AIza${"S-_9".repeat(5)}`,
      "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NSJ9.abc-DEF_123",
      `ghp_${"A".repeat(36)}`,
      `ghs_${"b".repeat(20)}`,
      `github_pat_11AA_${"B".repeat(20)}`,
      `glpat-${"aB3".repeat(10)}`,
      `npm_${"aB3".repeat(12)}`,
      `pypi-${"aB3".repeat(10)}`,
      `xoxb-${"1".repeat(12)}-${"a".repeat(24)}`,
      `xoxp-${"2".repeat(20)}`,
      `AKIA${"A1".repeat(8)}`,
      `ASCA${"Z9".repeat(8)}`,
      `SG.${"a".repeat(16)}.${"b".repeat(16)}`,
      `Bearer ${"aB3_".repeat(10)}`,
      `bearer\t${"x.y/".repeat(4)}z`,
      ["-----BEGIN RSA PRIVATE KEY-----", "aB3/".repeat(4), "-----END RSA PRIVATE KEY-----"].join("\n"),
    ]
    const unchanged = [
      "--sk-color: red", "sk-short", `xsk-${"a1".repeat(20)}`, `sk_live_${"a1".repeat(7)}`, `tk_live_${"a1".repeat(8)}`,
      `AIza${"a".repeat(19)}`, "eyJhbGciOiJIUzI1NiJ9", "eyJ.only.", `ghx_${"A".repeat(36)}`, `ghp_${"A".repeat(19)}`,
      `github_pat_${"B".repeat(19)}`, `glpat-${"a".repeat(19)}`, `npm_${"a".repeat(19)}`, `pypi-${"a".repeat(19)}`,
      `xoxz-${"1".repeat(24)}`, `xoxb-${"1".repeat(19)}`, "xo xox xoxo", `AKIA${"a1".repeat(8)}`, `AKIB${"A1".repeat(8)}`,
      `SG.${"a".repeat(15)}.${"b".repeat(16)}`, "Bearer short", "-----BEGIN PUBLIC KEY-----\nbody\n-----END PUBLIC KEY-----",
    ]
    for (const credential of masked) {
      expect(await redactBothForms(`before ${credential} after`)).toBe("before [redacted secret] after")
    }
    for (const text of unchanged) expect(await redactBothForms(`before ${text} after`)).toBe(`before ${text} after`)
    expect(await redactBothForms([...masked, ...unchanged].join(" | "))).toBe([...masked.map(() => "[redacted secret]"), ...unchanged].join(" | "))
  })

  it("gives the same bytes in both forms where credentials touch or overlap", async () => {
    const sk = `sk-${"a1".repeat(20)}`
    const xoxb = `xoxb-${"1".repeat(12)}-${"a".repeat(24)}`
    const jwt = "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NSJ9.abc-DEF_123"
    const ghp = `ghp_${"A".repeat(36)}`
    const aws = `AKIA${"A1".repeat(8)}`
    const bearer = `Bearer ${"aB3_".repeat(10)}`
    const key = ["-----BEGIN RSA PRIVATE KEY-----", "aB3/".repeat(4), "-----END RSA PRIVATE KEY-----"].join("\n")
    // Each expected value is the output of the redaction before it became cooperative.
    const cases: readonly (readonly [string, string])[] = [
      [`${sk}${xoxb}`, "[redacted secret]-111111111111-aaaaaaaaaaaaaaaaaaaaaaaa"],
      [`${sk} ${xoxb}`, "[redacted secret] [redacted secret]"],
      [`Bearer ${jwt}`, "Bearer [redacted secret]"],
      [`Bearer ${ghp}`, "Bearer [redacted secret]"],
      [`${aws}.SG.${"a".repeat(16)}.${"b".repeat(16)}`, "[redacted secret].[redacted secret]"],
      [`SG.${"a".repeat(16)}.${aws}`, "SG.aaaaaaaaaaaaaaaa.[redacted secret]"],
      [`${bearer}${sk}`, "[redacted secret]"],
      [`-----BEGIN PRIVATE KEY-----\n${bearer}\n-----END PRIVATE KEY-----`, "[redacted secret]"],
      [`${key}${key}`, "[redacted secret][redacted secret]"],
      [`${jwt}.${sk}`, "[redacted secret].[redacted secret]"],
      [`sk-proj-${ghp}`, "[redacted secret]"],
    ]
    for (const [text, expected] of cases) expect(await redactBothForms(text)).toBe(expected)
    const cut = `${bearer}\n-----BEGIN PRIVATE KEY-----\nbody`
    expect(await redactBothForms(cut, { completeness: "prefix" })).toBe("[redacted secret]\n[redacted secret]")
  })

  it("gives the same bytes in both forms for a text that spans many slices", async () => {
    const secrets = [`ghp_${"A".repeat(36)}`, `xoxp-${"2".repeat(20)}`, `AKIA${"A1".repeat(8)}`, `Bearer ${"aB3_".repeat(10)}`]
    const record = (index: number, value: string) => `{"index":${index},"value":"${value}","path":"src/infra/file-${index}.ts"}`
    const values = Array.from({ length: 20_000 }, (_, index) => index % 97 === 0 ? secrets[index % secrets.length] ?? "" : "ordinary text")
    const text = values.map((value, index) => record(index, value)).join("\n")
    const expected = values.map((value, index) => record(index, value.startsWith("ordinary") ? value : "[redacted secret]")).join("\n")
    expect(await redactBothForms(text)).toBe(expected)
  })

  it("divides a large text into more units than a small text, so that no unit scans the whole text", () => {
    const yieldPoints = (text: string): number => {
      const work = redactSecretsWork(text)
      let count = 0
      while (work.next().done !== true) count += 1
      return count
    }
    const line = `{"path":"src/infra/file.ts","text":"export const value = 1"},\n`
    expect(yieldPoints(line.repeat(130_000))).toBeGreaterThan(4 * yieldPoints(line.repeat(1_000)))
  })

  it("gives the same bytes as the redaction of each line when a large text joins secret-dense lines at any alignment", async () => {
    const sk = `sk-${"a1".repeat(20)}`
    const ghp = `ghp_${"A".repeat(36)}`
    const jwt = "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NSJ9.abc-DEF_123"
    const lines = [
      `${sk}${`xoxb-${"1".repeat(12)}-${"a".repeat(24)}`}`, `Bearer ${jwt}`, `Bearer\n \t\n${"aB3_".repeat(10)} tail`,
      `sk-proj-${ghp}`, `--sk-color: ${sk}`, `AKIA${"A1".repeat(8)}.SG.${"a".repeat(16)}.${"b".repeat(16)}`,
      `${jwt}.${sk}`, `path/to/file-${"x".repeat(40)}.ts`, `"${`npm_${"aB3".repeat(12)}`}",'${`glpat-${"aB3".repeat(10)}`}'`,
      ["-----BEGIN RSA PRIVATE KEY-----", "aB3/".repeat(4), "-----END RSA PRIVATE KEY-----"].join("\n"), "plain words, and more",
    ]
    const body = Array.from({ length: 20_000 }, (_, index) => lines[index % lines.length] ?? "")
    const expectedBody = body.map((text) => redactSecrets(text)).join("\n")
    for (let offset = 0; offset < 600; offset += 41) {
      const pad = "\n".repeat(offset)
      expect(await redactBothForms(pad + body.join("\n"))).toBe(pad + expectedBody)
    }
  })

  it("keeps a credential whole when it, or the whitespace inside it, is longer than a unit of work", () => {
    const run = (character: string) => character.repeat(3 << 20)
    const token = "aB3_".repeat(10)
    for (const text of [`Bearer${run(" ")}${token}`, `Bearer${run("\n")}${token}`, `bearer ${run("A")}`, `ghp_${run("A")}`]) {
      expect(redactSecrets(`x ${text} y`)).toBe("x [redacted secret] y")
    }
    expect(redactSecrets(`Beaver${run(" ")}${token}`)).toBe(`Beaver${run(" ")}${token}`)
  })

  // The engine compiles each pattern's scan from the first text that the
  // pattern gets. No public seam shows that choice, so this test compares the
  // time for the same 8 MB text with and without the dense character. A bad
  // choice costs about six times as much. The two texts alternate, so a burst
  // of load on the machine falls on both, and the fastest of nine runs of
  // each is compared, because load only adds time to a run.
  it("redacts a large text dense in a pattern's character as fast as one without it, whatever short text came first", () => {
    for (const first of ["xo", "gh"]) redactSecrets(first)
    const records = (character: string, word: string) => `${word} ${`{"payload":"${character.repeat(1_000)}"},`.repeat(8_192)}`
    const timedMs = (text: string): number => {
      const start = performance.now()
      expect(redactSecrets(text)).toBe(text)
      return performance.now() - start
    }
    for (const { character, word } of [{ character: "x", word: "exotic" }, { character: "g", word: "through" }]) {
      const dense = records(character, word)
      const plain = records("~", word)
      let denseMs = Number.POSITIVE_INFINITY
      let plainMs = Number.POSITIVE_INFINITY
      for (let run = 0; run < 9; run += 1) {
        denseMs = Math.min(denseMs, timedMs(dense))
        plainMs = Math.min(plainMs, timedMs(plain))
      }
      expect(denseMs).toBeLessThan(3 * plainMs)
    }
  })

  it("is idempotent", () => {
    const secret = ["sk", "proj", "aB3".repeat(12)].join("-")
    const once = redactSecrets(secret)
    expect(redactSecrets(once)).toBe(once)
  })
})

describe("redactSecretsPrefix", () => {
  const key = ["-----BEGIN RSA PRIVATE KEY-----", "aB3/".repeat(40), "-----END RSA PRIVATE KEY-----"].join("\n")
  const lines = [
    `TOKEN=sk-${"a1".repeat(20)}`, `Bearer \t\n ${"aB3_".repeat(10)} tail`, key, "plain words,   and more",
    `ghp_${"A".repeat(36)}xoxb-${"1".repeat(12)}-${"a".repeat(24)}`, `-----BEGIN ${"LONG NAME ".repeat(30)}PRIVATE KEY-----\nbody`,
  ]
  const text = lines.join("\n")

  it("is the start of the whole redaction at every cut, including a cut inside a credential, a key, or a key header", () => {
    const whole = redactSecrets(text)
    let cuts = 0
    for (let length = 0; length <= text.length + 1; length += 1) {
      const prefix = redactSecretsPrefix(text, length)
      expect(whole.startsWith(prefix.text)).toBe(true)
      expect(prefix.whole).toBe(prefix.text === whole)
      if (!prefix.whole) cuts += 1
    }
    expect(cuts).toBeGreaterThan(text.length / 2)
  })

  it("masks a private key through the cut when its END delimiter lies past the cut", () => {
    const cut = `intro ${key}\nafter`
    const prefix = redactSecretsPrefix(cut, "intro -----BEGIN RSA PRIVATE KEY-----".length + 10)
    expect(prefix).toEqual({ text: "intro [redacted secret]", whole: false })
    expect(redactSecretsPrefix(`intro ${key.slice(0, -30)}`, 1 << 20)).toEqual({ text: `intro ${key.slice(0, -30)}`, whole: true })
  })
})
