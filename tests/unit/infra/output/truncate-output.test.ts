import { describe, expect, test } from "bun:test";
import { truncateUtf8Prefix } from "../../../../src/infra/output/truncate-output.js";

describe("truncateUtf8Prefix", () => {
  test("keeps multibyte text within the exact UTF-8 byte bound", () => {
    const result = truncateUtf8Prefix("😀".repeat(10_000), 30_000);

    expect(Buffer.byteLength(result)).toBe(30_000);
    expect(result).not.toContain("�");
  });
});
