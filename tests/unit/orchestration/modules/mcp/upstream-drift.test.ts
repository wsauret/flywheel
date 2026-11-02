import { expect, test } from "bun:test";
import { resolve } from "node:path";

interface Slice {
  readonly label: string;
  readonly fixture: string;
  readonly sha256: string;
}
interface Ledger {
  readonly copies: readonly Slice[];
}
const provenance = resolve(import.meta.dir, "../../../../fixtures/upstream/mcp");
const hash = (text: string) => new Bun.CryptoHasher("sha256").update(text).digest("hex");

test("MCP provenance fixtures match pinned upstream source hashes", async () => {
  const ledger: Ledger = await Bun.file(resolve(provenance, "upstream-ledger.json")).json();
  for (const row of ledger.copies) {
    const source = await Bun.file(resolve(provenance, row.fixture)).text();
    expect(hash(source), row.label).toBe(row.sha256);
  }
});
