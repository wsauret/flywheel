#!/usr/bin/env bun
import { join } from "node:path";
import { listNotes } from "./notes/store";
import { loadIndex } from "./search/index-file";
import { search } from "./search/query";

const dir = process.env.NOTES_DIR ?? join(process.env.HOME ?? ".", "notes");
const query = process.argv.slice(2).join(" ");
const notes = await listNotes(dir);
const index = await loadIndex(join(dir, ".notes-index.json"), notes);
for (const path of search(index, query)) console.log(path);
