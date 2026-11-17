import { describe, expect, it } from "bun:test";
import { heapStats } from "bun:jsc";

import { createStreamingSanitizer, sanitizeExternalText, stripAnsiEscapes } from "../../../src/infra/control-characters.js";

const ESC = "\u001b";

describe("stripAnsiEscapes", () => {
  it("strips SGR color sequences", () => {
    expect(stripAnsiEscapes(`${ESC}[0m03:36:30  Running with dbt=1.11.11`)).toBe("03:36:30  Running with dbt=1.11.11");
    expect(stripAnsiEscapes(`${ESC}[32m[RUN]${ESC}[0m`)).toBe("[RUN]");
  });

  it("strips cursor and erase CSI sequences", () => {
    expect(stripAnsiEscapes(`${ESC}[2K${ESC}[1Adone`)).toBe("done");
  });

  it("strips OSC sequences terminated by BEL or ST", () => {
    expect(stripAnsiEscapes(`${ESC}]0;title\u0007text`)).toBe("text");
    expect(stripAnsiEscapes(`${ESC}]8;;https://x${ESC}\\link`)).toBe("link");
  });

  it("strips an unterminated OSC sequence at end of string", () => {
    expect(stripAnsiEscapes(`text${ESC}]0;partial title`)).toBe("text");
  });

  it("strips two-character Fe escapes", () => {
    expect(stripAnsiEscapes(`${ESC}Mtext`)).toBe("text");
  });

  it("strips DCS-family control strings in 7-bit and C1 forms", () => {
    for (const control of [
      `${ESC}Ppayload${ESC}\\`,
      `${ESC}Xpayload${ESC}\\`,
      `${ESC}^payload${ESC}\\`,
      `${ESC}_payload${ESC}\\`,
      `\u0090payload\u009c`,
      `\u0098payload\u009c`,
      `\u009epayload\u009c`,
      `\u009fpayload\u009c`,
    ]) {
      expect(stripAnsiEscapes(`before${control}after`)).toBe("beforeafter");
    }
  });

  it("strips OSC and CSI in 7-bit and C1 forms", () => {
    for (const control of [`${ESC}]title\u0007`, `${ESC}]title${ESC}\\`, `\u009dtitle\u0007`, `\u009dtitle\u009c`, `${ESC}[31m`, `\u009b31m`]) {
      expect(stripAnsiEscapes(`before${control}after`)).toBe("beforeafter");
    }
  });

  it("strips general ESC sequences across the valid final-byte range", () => {
    expect(stripAnsiEscapes(`before${ESC}cafter`)).toBe("beforeafter");
    expect(stripAnsiEscapes(`before${ESC} 0after`)).toBe("beforeafter");
  });

  it("does not leak incomplete control-string payloads", () => {
    for (const control of [`${ESC}Ppayload`, `${ESC}Xpayload`, `${ESC}^payload`, `${ESC}_payload`, `${ESC}]payload`, "\u0090payload", "\u0098payload", "\u009dpayload", "\u009epayload", "\u009fpayload"]) {
      expect(stripAnsiEscapes(`before${control}`)).toBe("before");
    }
  });

  it("leaves plain text untouched", () => {
    expect(stripAnsiEscapes("plain [0m text")).toBe("plain [0m text");
  });
});

describe("sanitizeExternalText", () => {
  it("folds carriage returns into newlines", () => {
    expect(sanitizeExternalText("a\r\nb\rc")).toBe("a\nb\nc");
  });

  it("drops remaining C0 controls but keeps newlines and tabs", () => {
    expect(sanitizeExternalText("a\u0007b\tc\nd\u0000e")).toBe("ab\tc\nde");
  });

  it("normalizes ANSI-laden subprocess output to clean lines", () => {
    const raw = `${ESC}[0m03:36:35  Concurrency: 16 threads (target='sandbox')\n${ESC}[0m03:36:36  1 of 10 START ${ESC}[32m[RUN]${ESC}[0m`;
    expect(sanitizeExternalText(raw)).toBe(
      "03:36:35  Concurrency: 16 threads (target='sandbox')\n03:36:36  1 of 10 START [RUN]",
    );
  });

  it("keeps OSC state across raw newlines", () => {
    expect(sanitizeExternalText(`before${ESC}]title\nforged${ESC}\\after`)).toBe("beforeafter");
  });

  it("returns flat text, so a result nobody reads retains no per-character string nodes", () => {
    const strings = (): number => {
      Bun.gc(true);
      return heapStats().objectTypeCounts.string ?? 0;
    };
    const before = strings();
    const kept = Array.from({ length: 40 }, (_, index) => sanitizeExternalText(`${index} ${"x".repeat(8_000)}`));
    // A rope of one node per character would add about 320,000 strings here.
    expect(strings() - before).toBeLessThan(5_000);
    expect(kept).toHaveLength(40);
  });

  it("gives the same text for any chunking of input with and without control characters", () => {
    let seed = 7;
    const random = (limit: number): number => {
      seed = (seed * 48_271) % 2_147_483_647;
      return seed % limit;
    };
    const clean = ["a", "b", " ", "[", "]", "\\", "m", "P", "\n", "\t", "界", "🙂"];
    const controls = ["\r", ESC, "\u0007", "\u0000", "\u007f", "\u009b", "\u009c", "\u009d", "\u0090"];
    let chunks = 0;
    while (chunks < 1_000) {
      const withControls = random(2) === 0;
      const alphabet = withControls ? [...clean, ...controls] : clean;
      const characters = Array.from({ length: 1 + random(80) }, () => alphabet[random(alphabet.length)]!);
      const input = characters.join("");
      // Splits keep code points whole: an escape that a chunk ends on the high
      // half of a surrogate pair takes only that half, which the whole-text
      // sanitizer never does.
      const parts: string[] = [];
      let start = 0;
      while (start < characters.length) {
        const end = Math.min(characters.length, start + 1 + random(12));
        parts.push(characters.slice(start, end).join(""));
        start = end;
      }
      const streamed: string[] = [];
      const sanitizer = createStreamingSanitizer((text) => { streamed.push(text); });
      for (const part of parts) sanitizer.push(part);
      sanitizer.finish();
      expect(streamed.join("")).toBe(sanitizeExternalText(input));
      chunks += parts.length;
    }
  });
});
