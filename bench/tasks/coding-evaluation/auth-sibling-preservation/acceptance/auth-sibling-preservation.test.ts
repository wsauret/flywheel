import { describe, expect, it } from "bun:test";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { replaceRejectedProviderCredentials, replaceRejectedProviderCredentialsWithReceipt } from "../src/infra/auth/auth-store-mutations.js";

const classifySlot = (providerId: string) => providerId === "opencode_go" ? "subscription" as const : "metered" as const;
const replacement = () => ({ type: "api_key" as const, key: "replacement-test-key" });

async function withStore(store: Record<string, unknown>, use: (authDirectory: string, file: string, before: Buffer) => Promise<void>) {
  const home = await mkdtemp(join(tmpdir(), "auth-sibling-preservation-"));
  try {
    const authDirectory = join(home, ".flywheel", "auth");
    await mkdir(authDirectory, { recursive: true });
    const file = join(authDirectory, "auth.json");
    const before = Buffer.from(`${JSON.stringify(store, null, 2)}\n`);
    await writeFile(file, before, { mode: 0o600 });
    await use(authDirectory, file, before);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
}

const healthy = () => ({
  id: "healthy",
  identity: "Healthy",
  lineageId: crypto.randomUUID(),
  credential: { type: "api_key", key: "healthy-test-key" },
});
const unknownSibling = { arbitrary: "preserved" };

for (const variant of [
  { name: "replaceRejectedProviderCredentials", mutate: replaceRejectedProviderCredentials, noChange: false },
  { name: "replaceRejectedProviderCredentialsWithReceipt", mutate: replaceRejectedProviderCredentialsWithReceipt, noChange: undefined },
]) {
  describe(variant.name, () => {
    it("preserves every byte of a partially damaged account collection", async () => {
      const damaged = {
        id: "damaged",
        identity: "Damaged",
        lineageId: crypto.randomUUID(),
        credential: { type: "api_key", key: 7 },
      };
      await withStore({
        openai_api: { type: "api_key", key: "other-test-key" },
        opencode_go: [healthy(), damaged],
        removed_provider: unknownSibling,
      }, async (authDirectory, file, before) => {
        const result = await variant.mutate("opencode_go", replacement(), authDirectory, classifySlot);
        expect(await readFile(file)).toEqual(before);
        expect(result).toBe(variant.noChange);
      });
    });

    it("repairs a wholly rejected provider while preserving unknown siblings and receipt entries", async () => {
      const rejected = { type: "api_key" };
      await withStore({
        openai_api: rejected,
        removed_provider: unknownSibling,
      }, async (authDirectory, file) => {
        const result = await variant.mutate("openai_api", replacement(), authDirectory, classifySlot);
        const stored = JSON.parse(await readFile(file, "utf8"));
        expect(stored.openai_api).toEqual({
          type: "api_key",
          key: "replacement-test-key",
          lineageId: expect.any(String),
        });
        expect(stored.removed_provider).toEqual(unknownSibling);
        if (variant.name === "replaceRejectedProviderCredentialsWithReceipt") {
          expect(result).toEqual({ providerId: "openai_api", before: rejected, after: stored.openai_api });
        } else {
          expect(result).toBe(true);
        }
      });
    });

    it("does not rewrite a healthy valid provider", async () => {
      await withStore({
        opencode_go: [healthy()],
        removed_provider: unknownSibling,
      }, async (authDirectory, file, before) => {
        const result = await variant.mutate("opencode_go", replacement(), authDirectory, classifySlot);
        expect(await readFile(file)).toEqual(before);
        expect(result).toBe(variant.noChange);
      });
    });
  });
}
