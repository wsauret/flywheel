import * as fs from "node:fs";
import { writeFileAtomic } from "../../workflows/shared/atomic-write.js";
import type { AnyBlock } from "../../infra/output-blocks.js";
import {
  toSnapshot,
  fromSnapshot,
  type OutputSnapshot,
} from "./output-schemas.js";
import {
  createDebouncedWriter,
  type DebouncedWriter,
} from "../../workflows/shared/debounced-writer.js";
import { resolveSessionFile, ensureSessionDir } from "../../infra/paths.js";

const DEFAULT_MAX_SIZE_BYTES = 50 * 1024 * 1024;
const DEFAULT_FLUSH_INTERVAL_MS = 5000;

export interface OutputPersistenceDeps {
  sessionId: string;
  baseDir?: string;
  maxSizeBytes?: number;
}

interface OutputFlusherOpts {
  intervalMs?: number;
}

export interface OutputFlusher {
  schedule(): void;
  flush(): Promise<void>;
  dispose(): void;
}

export interface OutputPersistence {
  save(blocks: AnyBlock[]): void;
  load(): Promise<OutputSnapshot[]>;
  delete(): Promise<boolean>;
  createFlusher(getBlocks: () => readonly AnyBlock[], opts?: OutputFlusherOpts): OutputFlusher;
}

export function createOutputPersistence(deps: OutputPersistenceDeps): OutputPersistence {
  const { sessionId, baseDir = ".", maxSizeBytes = DEFAULT_MAX_SIZE_BYTES } = deps;

  function outputFilePath(): string {
    return resolveSessionFile(sessionId, "output", baseDir);
  }

  function save(blocks: readonly AnyBlock[]): void {
    const snapshots = toSnapshot(blocks);
    let json = JSON.stringify(snapshots);

    if (json.length > maxSizeBytes) {
      let truncated = [...snapshots];
      while (truncated.length > 1) {
        truncated.shift();
        json = JSON.stringify(truncated);
        if (json.length <= maxSizeBytes) break;
      }
    }

    writeFileAtomic(outputFilePath(), json);
  }

  async function load(): Promise<OutputSnapshot[]> {
    const filePath = outputFilePath();

    try {
      const file = Bun.file(filePath);
      const exists = await file.exists();
      if (!exists) return [];

      const raw = await file.text();
      const parsed = JSON.parse(raw);

      if (!Array.isArray(parsed)) return [];

      return fromSnapshot(parsed);
    } catch { return []; }
  }

  async function del(): Promise<boolean> {
    const filePath = outputFilePath();
    try {
      if (!fs.existsSync(filePath)) return false;
      fs.unlinkSync(filePath);
      return true;
    } catch {
      return false;
    }
  }

  function createFlusher(
    getBlocks: () => readonly AnyBlock[],
    opts?: OutputFlusherOpts,
  ): OutputFlusher {
    const intervalMs = opts?.intervalMs ?? DEFAULT_FLUSH_INTERVAL_MS;

    const writer = createDebouncedWriter<undefined>(
      async () => {
        const blocks = getBlocks();
        save(blocks);
      },
      { intervalMs },
    );

    return {
      schedule(): void {
        writer.schedule(undefined);
      },
      flush(): Promise<void> {
        return writer.flush();
      },
      dispose(): void {
        writer.dispose();
      },
    };
  }

  return {
    save,
    load,
    delete: del,
    createFlusher,
  };
}
