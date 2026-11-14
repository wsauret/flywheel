import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { SqlPermitRepo } from "../src/permits";

function migrated(): Database {
  const db = new Database(":memory:", { strict: true });
  const dir = join(import.meta.dir, "..", "migrations");
  for (const file of readdirSync(dir).filter((name) => name.endsWith(".sql")).sort()) db.exec(readFileSync(join(dir, file), "utf8"));
  return db;
}

test("save then get round-trips every field, and a second save replaces the permit", async () => {
  const db = migrated();
  try {
    const repo = new SqlPermitRepo(db);
    const permit = { id: "p-1", residentId: "r-1", kind: "residential" as const, zone: "A", plate: "AV12 KDP", expiresOn: "2027-06-30" };
    await repo.save(permit);
    expect(await repo.get("p-1")).toEqual(permit);
    await repo.save({ ...permit, expiresOn: "2028-06-30" });
    expect((await repo.get("p-1"))?.expiresOn).toBe("2028-06-30");
  } finally {
    db.close();
  }
});
