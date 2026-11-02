import { describe, expect, test } from "bun:test";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Schema, Redacted } from "effect";
import { createRuntimeConfigOwner } from "../../../../../src/orchestration/config/runtime-config-owner.js";
import { addMcpServers, mcpExpectedToken, mcpMutationMessage, removeMcpServer, setMcpEnabled } from "../../../../../src/orchestration/modules/mcp/config-mutation.js";
import { McpConfigSchema, mcpConfigSection, resolveMcpConfig } from "../../../../../src/orchestration/modules/mcp/config.js";
import { configSection } from "../../../../../src/orchestration/config/config-section.js";
import { createMcpCredentialStore } from "../../../../../src/orchestration/modules/mcp/credentials.js";
import { temporaryDirectories } from "../../../../helpers/directories.js";

const temporaryDirectory = temporaryDirectories();
interface EnvironmentValues { readonly [key: string]: string }
const currentMcpConfig = (owner: Awaited<ReturnType<typeof createRuntimeConfigOwner>>) => configSection(owner.snapshot().config, mcpConfigSection);
const source = '# retained\nshow_intro = false\n[projects."/other"]\nshow_build = true # retained sibling\n[mcp.servers.work]\nurl = "https://example.test/mcp"\n[mcp.servers.other]\ncommand = "keep" # keep\n[mcp.projects."/a".servers.work]\nenabled = false\n[mcp.projects."/b".servers.work]\nenabled = true\n[mcp.projects."/c".servers.work]\ncommand = "local"\n';

describe("scoped MCP mutations", () => {
  test("removes globals and dependent overrides atomically while retaining full definitions, unrelated bytes and credentials", async () => {
    const root = temporaryDirectory("mcp-mutation-");
    const file = join(root, "flywheel.toml");
    writeFileSync(file, source);
    const store = createMcpCredentialStore(root);
    await store.save("work", "https://example.test/mcp", { tokens: { accessToken: Redacted.make("fixture"), tokenType: "Bearer" } });
    const credentialBytes = readFileSync(join(root, "mcp-credentials.json"));
    const owner = await createRuntimeConfigOwner({ configPath: file, watch: false });
    let publications = 0;
    const stop = owner.subscribeAll(() => { publications++; });
    try {
      const expected = mcpExpectedToken(currentMcpConfig(owner), "/a", "work");
      const result = await removeMcpServer(owner, { projectRoot: "/a", server: "work", scope: "global", expected });
      expect(result.ok).toBe(true);
      expect(publications).toBe(1);
      const reopened = await createRuntimeConfigOwner({ configPath: file, watch: false });
      try {
        const config = currentMcpConfig(reopened);
        expect(config.servers.work).toBeUndefined();
        expect(config.projects["/a"]?.servers.work).toBeUndefined();
        expect(config.projects["/b"]?.servers.work).toBeUndefined();
        expect(config.projects["/c"]?.servers.work).toMatchObject({ command: "local" });
        expect(readFileSync(file, "utf8")).toContain('command = "keep" # keep');
        expect(readFileSync(file, "utf8")).toContain('show_build = true # retained sibling');
        expect(readFileSync(join(root, "mcp-credentials.json"))).toEqual(credentialBytes);
        expect(createMcpCredentialStore(root).get("work", "https://example.test/mcp")).toBeDefined();
      } finally { await reopened.dispose(); }
    } finally { await stop(); await owner.dispose(); }
  });

  test("authors only project state, preserves siblings, restores fallback and refuses stale selected edits", async () => {
    const root = temporaryDirectory("mcp-mutation-");
    const file = join(root, "flywheel.toml");
    writeFileSync(file, source);
    const owner = await createRuntimeConfigOwner({ configPath: file, watch: false });
    const token = () => mcpExpectedToken(currentMcpConfig(owner), "/c", "work");
    try {
      expect((await setMcpEnabled(owner, { projectRoot: "/c", server: "work", scope: "project", enabled: false, expected: token() })).ok).toBe(true);
      expect(resolveMcpConfig(currentMcpConfig(owner), "/b").servers.work?.enabled).toBe(true);
      expect((await removeMcpServer(owner, { projectRoot: "/c", server: "work", scope: "project", expected: token() })).ok).toBe(true);
      expect(resolveMcpConfig(currentMcpConfig(owner), "/c").servers.work).toMatchObject({ url: "https://example.test/mcp" });
      const stale = token();
      writeFileSync(file, readFileSync(file, "utf8").replace('https://example.test/mcp', 'https://changed.test/mcp'));
      const admitted = readFileSync(file);
      expect(await removeMcpServer(owner, { projectRoot: "/c", server: "work", scope: "global", expected: stale })).toMatchObject({ ok: false, kind: "stale" });
      expect(readFileSync(file)).toEqual(admitted);
    } finally { await owner.dispose(); }
  });

  test("adds local shadows and imports all-or-nothing through inline, dotted and table sources", async () => {
    for (const initial of ['mcp = {servers = {work = {command = "global"}}}\n', 'mcp.servers.work.command = "global"\n', '[mcp.servers.work]\ncommand = "global"\n']) {
      const file = join(temporaryDirectory("mcp-mutation-"), "flywheel.toml");
      writeFileSync(file, initial);
      const owner = await createRuntimeConfigOwner({ configPath: file, watch: false });
      try {
        const server = { command: "local", args: [], env: {}, enabled: true };
        expect((await addMcpServers(owner, "/a", "project", { work: server })).ok).toBe(true);
        expect(resolveMcpConfig(currentMcpConfig(owner), "/a").servers.work?.command).toBe("local");
        expect(resolveMcpConfig(currentMcpConfig(owner), "/b").servers.work?.command).toBe("global");
        const before = readFileSync(file);
        expect(await addMcpServers(owner, "/a", "project", { work: server, new: server })).toMatchObject({ ok: false, kind: "stale" });
        expect(readFileSync(file)).toEqual(before);
        expect((await setMcpEnabled(owner, { projectRoot: "/b", server: "work", scope: "project", enabled: false, expected: mcpExpectedToken(currentMcpConfig(owner), "/b", "work") })).ok).toBe(true);
        expect(resolveMcpConfig(currentMcpConfig(owner), "/b").servers.work?.enabled).toBe(false);
        expect(resolveMcpConfig(currentMcpConfig(owner), "/a").servers.work?.enabled).toBe(true);
        expect((await setMcpEnabled(owner, { projectRoot: "/a", server: "work", scope: "global", enabled: false, expected: mcpExpectedToken(currentMcpConfig(owner), "/a", "work") })).ok).toBe(true);
        expect(resolveMcpConfig(currentMcpConfig(owner), "/a").servers.work?.enabled).toBe(true);
        expect((await removeMcpServer(owner, { projectRoot: "/b", server: "work", scope: "project", expected: mcpExpectedToken(currentMcpConfig(owner), "/b", "work") })).ok).toBe(true);
        expect(resolveMcpConfig(currentMcpConfig(owner), "/b").metadata.work?.enabledScope).toBe("global");
        expect((await removeMcpServer(owner, { projectRoot: "/a", server: "work", scope: "global", expected: mcpExpectedToken(currentMcpConfig(owner), "/a", "work") })).ok).toBe(true);
        expect(resolveMcpConfig(currentMcpConfig(owner), "/a").servers.work?.command).toBe("local");
        expect(resolveMcpConfig(currentMcpConfig(owner), "/b").servers.work).toBeUndefined();
      } finally { await owner.dispose(); }
    }
  });

  test("refuses malformed current bytes without exposing source content or publishing a candidate", async () => {
    const file = join(temporaryDirectory("mcp-mutation-"), "flywheel.toml");
    writeFileSync(file, source);
    const owner = await createRuntimeConfigOwner({ configPath: file, watch: false });
    let publications = 0;
    const stop = owner.subscribeAll(() => { publications++; });
    try {
      const expected = mcpExpectedToken(currentMcpConfig(owner), "/a", "work");
      const invalid = 'mcp = { private_auth_marker = [ }';
      writeFileSync(file, invalid);
      const result = await removeMcpServer(owner, { projectRoot: "/a", server: "work", scope: "global", expected });
      expect(result).toMatchObject({ ok: false, kind: "parse-or-decode-failed" });
      expect(mcpMutationMessage(result)).not.toContain("private_auth_marker");
      expect(readFileSync(file, "utf8")).toBe(invalid);
      expect(publications).toBe(0);
    } finally { await stop(); await owner.dispose(); }
  });

  test("adds and mutates authored dictionary names without admitting inherited definitions", async () => {
    for (const name of ["__proto__", "toString", "constructor"]) {
      const file = join(temporaryDirectory("mcp-mutation-"), "flywheel.toml");
      writeFileSync(file, "# retained\n");
      const owner = await createRuntimeConfigOwner({ configPath: file, watch: false });
      const token = (projectRoot = name) => mcpExpectedToken(currentMcpConfig(owner), projectRoot, name);
      const request = (scope: "global" | "project", projectRoot = name) => ({ projectRoot, server: name, scope, expected: token(projectRoot) });
      const server = { command: "local", args: [], env: {}, enabled: true };
      try {
        const empty = Schema.decodeUnknownSync(McpConfigSchema)({});
        expect(token()).toBe(mcpExpectedToken(empty, "/missing", "missing"));
        const before = readFileSync(file);
        for (const scope of ["global", "project"] as const) {
          expect((await setMcpEnabled(owner, { ...request(scope), enabled: false })).ok).toBe(false);
          expect((await removeMcpServer(owner, request(scope))).ok).toBe(false);
        }
        expect(readFileSync(file)).toEqual(before);
        expect((await addMcpServers(owner, name, "global", Object.fromEntries([[name, server]]))).ok).toBe(true);
        expect((await setMcpEnabled(owner, { ...request("project"), enabled: false })).ok).toBe(true);
        expect(resolveMcpConfig(currentMcpConfig(owner), name).servers[name]).toMatchObject({ command: "local", enabled: false });
        expect((await addMcpServers(owner, "/full", "project", Object.fromEntries([[name, server]]))).ok).toBe(true);
        expect((await addMcpServers(owner, "/full", "project", Object.fromEntries([[name, server]]))).ok).toBe(false);
        expect((await removeMcpServer(owner, request("global"))).ok).toBe(true);
        expect(Object.hasOwn(currentMcpConfig(owner).projects[name]?.servers ?? {}, name)).toBe(false);
        expect(resolveMcpConfig(currentMcpConfig(owner), "/full").servers[name]).toMatchObject({ command: "local" });
        expect((await setMcpEnabled(owner, { ...request("project", "/full"), enabled: false })).ok).toBe(true);
        expect((await removeMcpServer(owner, request("project", "/full"))).ok).toBe(true);
        expect(Object.keys(resolveMcpConfig(currentMcpConfig(owner), "/full").servers)).toEqual([]);
        expect(readFileSync(file, "utf8")).toContain("# retained");
      } finally { await owner.dispose(); }
    }
  });

  test("reports a saved application failure without disclosing subscriber details or claiming rollback", async () => {
    const file = join(temporaryDirectory("mcp-mutation-"), "flywheel.toml");
    writeFileSync(file, source);
    const owner = await createRuntimeConfigOwner({ configPath: file, watch: false });
    const stop = owner.subscribe(mcpConfigSection, () => { throw new Error("private_connection_detail"); });
    try {
      const result = await setMcpEnabled(owner, { projectRoot: "/a", server: "work", scope: "project", enabled: true, expected: mcpExpectedToken(currentMcpConfig(owner), "/a", "work") });
      expect(result).toMatchObject({ ok: true, subscriberOutcome: { kind: "committed-but-degraded" } });
      expect(resolveMcpConfig(currentMcpConfig(owner), "/a").servers.work?.enabled).toBe(true);
      expect(mcpMutationMessage(result)).toContain("were saved");
      expect(mcpMutationMessage(result)).toContain("could not fully update");
      expect(mcpMutationMessage(result)).not.toContain("private_connection_detail");
    } finally { await stop(); await owner.dispose(); }
  });

  test("normalizes record key order but retains argument order and fallback state in expectations", () => {
    const config = (env: EnvironmentValues, args: string[] = ["a", "b"]) => Schema.decodeUnknownSync(McpConfigSchema)({ servers: { work: { command: "bun", args, env } } });
    const first = config({ "é": "one", "é": "two", "😀": "three", "\ue000": "four" });
    const second = config({ "\ue000": "four", "😀": "three", "é": "two", "é": "one" });
    expect(mcpExpectedToken(first, "/a", "work")).toBe(mcpExpectedToken(second, "/a", "work"));
    expect(mcpExpectedToken(first, "/a", "work")).not.toBe(mcpExpectedToken(config({ "é": "one", "é": "two", "😀": "three", "\ue000": "four" }, ["b", "a"]), "/a", "work"));
    expect(mcpExpectedToken({ ...first, projects: { "/a": { servers: { work: { enabled: true } } } } }, "/a", "work")).not.toBe(mcpExpectedToken(first, "/a", "work"));
    expect(mcpExpectedToken({ ...first, servers: { ...first.servers, unrelated: second.servers.work! } }, "/a", "work")).toBe(mcpExpectedToken(first, "/a", "work"));
  });
});
