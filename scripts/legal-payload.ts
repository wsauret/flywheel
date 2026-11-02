import { copyFile, mkdir } from "node:fs/promises";
import { join } from "node:path";

export const LEGAL_PAYLOAD_FILES = ["LICENSE", "THIRD-PARTY-NOTICES.md", "THIRD-PARTY-LICENSES.txt"] as const;

/** Copies the complete legal payload into one distributed artifact root. */
export async function stageLegalPayload(repositoryRoot: string, destination: string): Promise<void> {
  await mkdir(destination, { recursive: true });
  await Promise.all(LEGAL_PAYLOAD_FILES.map((name) => copyFile(join(repositoryRoot, name), join(destination, name))));
}
