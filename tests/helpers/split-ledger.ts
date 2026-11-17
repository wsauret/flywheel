import { mkdir } from "node:fs/promises";
import { join } from "node:path";

/** The rows of one historical split-ledger campaign, one list per record kind.
 *  Rows are untyped so a fixture can also hold a malformed or superseded row. */
export interface SplitLedgerRows {
  readonly runs?: readonly unknown[];
  readonly attempts?: readonly unknown[];
  readonly judgeAttempts?: readonly unknown[];
  readonly scores?: readonly unknown[];
}

/** Writes a historical split-ledger campaign the way releases before the
 *  persona campaign ledger stored it: run-config.json beside one JSON Lines
 *  file per record kind. No release writes this format any more, so a test of
 *  its read-only reader builds it here. A record kind without rows has no file. */
export async function writeSplitLedger(directory: string, config: unknown, rows: SplitLedgerRows = {}): Promise<void> {
  await mkdir(directory, { recursive: true });
  await Bun.write(join(directory, "run-config.json"), `${JSON.stringify(config, null, 2)}\n`);
  const ledgers = [
    ["runs.jsonl", rows.runs],
    ["attempts.jsonl", rows.attempts],
    ["judge-attempts.jsonl", rows.judgeAttempts],
    ["scores.jsonl", rows.scores],
  ] as const;
  for (const [file, records] of ledgers) {
    if (records === undefined || records.length === 0) continue;
    await Bun.write(join(directory, file), records.map((record) => `${JSON.stringify(record)}\n`).join(""));
  }
}
