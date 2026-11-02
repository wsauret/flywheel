import { expect, test } from "bun:test";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AuthStoreMutationError, replaceRejectedProviderCredentials, replaceRejectedProviderCredentialsWithReceipt } from "../src/infra/auth/auth-store-mutations";
const classify = () => "metered" as const;
const replacement = { type: "api_key" as const, key: "fixture-only-replacement" };
async function store(raw: string, use: (directory: string, file: string) => Promise<void>) {
  const home = await mkdtemp(join(tmpdir(), "auth-root-"));
  try {
    const directory = join(home, "auth");
    await mkdir(directory);
    const file = join(directory, "auth.json");
    await writeFile(file, raw, { mode: 0o600 });
    await use(directory, file);
  } finally { await rm(home, { recursive: true, force: true }); }
}
for (const [name, mutate] of [["boolean", replaceRejectedProviderCredentials], ["receipt", replaceRejectedProviderCredentialsWithReceipt]] as const) {
  test(`${name} refuses nonobject store roots without changing bytes`, async () => {
    for (const raw of ["null\n", "[1,2]\n", '"text"\n', "17\n", "false\n"]) {
      await store(raw, async (directory, file) => {
        const result = await mutate("metered", replacement, directory, classify).then(value => ({ value }), error => ({ error }));
        expect("error" in result && result.error).toBeInstanceOf(AuthStoreMutationError);
        expect(await readFile(file, "utf8")).toBe(raw);
      });
    }
  });
  test(`${name} refuses invalid JSON and remains usable after external correction`, async () => {
    const raw = '{"metered":';
    await store(raw, async (directory, file) => {
      const result = await mutate("metered", replacement, directory, classify).then(value => ({ value }), error => ({ error }));
      expect("error" in result && result.error).toBeInstanceOf(AuthStoreMutationError);
      expect(await readFile(file, "utf8")).toBe(raw);
      await writeFile(file, JSON.stringify({ metered: { broken: true } }));
      await mutate("metered", replacement, directory, classify);
      expect(JSON.parse(await readFile(file, "utf8")).metered).toEqual({ ...replacement, lineageId: expect.any(String) });
    });
  });
  test(`${name} repairs a malformed target and preserves its sibling`, async () => {
    const sibling = { type: "api_key", key: "fixture-only-sibling", lineageId: crypto.randomUUID() };
    const before = { broken: true };
    await store(JSON.stringify({ metered: before, other: sibling }), async (directory, file) => {
      const result = await mutate("metered", replacement, directory, classify);
      const written = JSON.parse(await readFile(file, "utf8"));
      expect(written.metered).toEqual({ ...replacement, lineageId: expect.any(String) });
      expect(written.other).toEqual(sibling);
      expect(result).toEqual(name === "boolean" ? true : { providerId: "metered", before, after: written.metered });
    });
  });
}
