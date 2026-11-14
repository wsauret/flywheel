import { Database } from "bun:sqlite";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

export const MIGRATIONS_DIR = join(import.meta.dir, "..", "migrations");

/** Apply every migration in `dir` in file-name order. The deploy runs this before the new build serves. */
export function migrate(db: Database, dir: string = MIGRATIONS_DIR): void {
  for (const file of readdirSync(dir).filter((name) => name.endsWith(".sql")).sort()) {
    db.exec(readFileSync(join(dir, file), "utf8"));
  }
}

export function openDatabase(path: string): Database {
  return new Database(path, { strict: true });
}
