import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";

function makeTmpPath(filePath: string): string {
  const pid = process.pid;
  const timestamp = Date.now();
  const rand = crypto.randomBytes(4).toString("hex");
  return `${filePath}.__flywheel__.${pid}.${timestamp}.${rand}.tmp`;
}

export function writeFileAtomic(
  filePath: string,
  content: string,
  options?: { mode?: number },
): void {
  const tmpPath = makeTmpPath(filePath);

  const dir = path.dirname(tmpPath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }

  const fd = fs.openSync(tmpPath, "w");
  try {
    fs.writeFileSync(fd, content, "utf-8");
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }

  if (options?.mode !== undefined) {
    fs.chmodSync(tmpPath, options.mode);
  }

  fs.renameSync(tmpPath, filePath);
}
