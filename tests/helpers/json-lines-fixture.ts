import { appendFile } from "node:fs/promises";

/** Appends one JSON line to a benchmark ledger as a fixture. It writes past the
 *  ledger's schema check, so a test can plant a row that the ledger itself
 *  refuses to append, such as a malformed or foreign row. */
export async function appendFixtureLine(path: string, value: unknown): Promise<void> {
  await appendFile(path, `${JSON.stringify(value)}\n`);
}
