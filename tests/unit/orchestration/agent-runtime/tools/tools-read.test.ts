import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import sharp from "sharp";

import { readDefinition } from "../../../../../src/orchestration/agent-runtime/tools/read.js";
import { executePreparedTool, prepareToolCall } from "../../../../../src/orchestration/agent-runtime/tools/tool-dispatch.js";
import type { RuntimeToolInput } from "../../../../../src/orchestration/agent-runtime/tools/types.js";
import { planToolExposure } from "../../../../../src/orchestration/agent-runtime/tools/tool-exposure-planner.js";
import type { AgentPurpose } from "../../../../../src/orchestration/agent-runtime/types.js";
import { NO_MODULE_RUNTIMES } from "../../../../../src/infra/module-runtime.js";
import { testKernelToolDeps } from "../../../../helpers/request-tool-surface.js";
import { makeContext } from "./_fixtures.js";

const nameInterpolation = ["", "{name}"].join("$");


describe("read tool", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "agent-tools-read-"));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  const dispatch = (input: RuntimeToolInput) => executePreparedTool(
    prepareToolCall({ id: "read", name: "read", input }, new Map([["read", readDefinition]])),
    makeContext({ executionCwd: tmpDir, projectRoot: tmpDir }),
  );

  it("reads several files in order with one header per path, while keeping an existing spaced path intact", async () => {
    fs.writeFileSync(path.join(tmpDir, "a.txt"), "alpha");
    fs.writeFileSync(path.join(tmpDir, "b.txt"), "beta");
    fs.writeFileSync(path.join(tmpDir, "a.txt b.txt"), "literal");
    expect((await dispatch({ path: "a.txt b.txt" })).content).toBe("1|literal");
    for (const paths of ["a.txt,b.txt", "b.txt a.txt"]) {
      const result = await dispatch({ path: paths });
      expect(result.outcome).toBe("ok");
      const text = String(result.content);
      expect(text).toStartWith(`[Path '${paths}' names several paths; read each in order.]`);
      expect(text).toContain("### a.txt\n1|alpha");
      expect(text).toContain("### b.txt\n1|beta");
      expect(text.indexOf(paths.startsWith("b") ? "### b.txt" : "### a.txt")).toBeLessThan(text.indexOf(paths.startsWith("b") ? "### a.txt" : "### b.txt"));
    }
    fs.writeFileSync(path.join(tmpDir, "c.txt"), "gamma");
    const ambiguous = await dispatch({ path: "a.txt b.txt,c.txt" });
    expect(ambiguous.outcome).toBe("error");
    expect(ambiguous.content).toContain("can name different path lists");
    fs.writeFileSync(path.join(tmpDir, "a,"), "comma");
    fs.writeFileSync(path.join(tmpDir, "a"), "a");
    fs.writeFileSync(path.join(tmpDir, "b"), "b");
    for (const input of [{ path: "a, b" }, { path: "a, b", pattern: "a" }]) {
      const refused = await dispatch(input);
      expect(refused.outcome).toBe("error");
      expect(refused.content).toContain("can name different path lists");
    }
    const cwd = path.join(tmpDir, "worktree");
    fs.mkdirSync(cwd);
    for (const name of ["a.txt", "b.txt"]) fs.writeFileSync(path.join(cwd, name), "local");
    const refused = await executePreparedTool(
      prepareToolCall({ id: "read", name: "read", input: { path: "a.txt b.txt" } }, new Map([["read", readDefinition]])),
      makeContext({ executionCwd: cwd, projectRoot: tmpDir }),
    );
    expect(refused.outcome).toBe("error");
    expect(refused.content).toContain(path.join(tmpDir, "a.txt b.txt"));
    expect(refused.content).toContain("'a.txt', 'b.txt'");
  });

  it("reads each selected batch member and preserves a valid single-file multi-range selector", async () => {
    for (const name of ["a", "b"]) fs.writeFileSync(path.join(tmpDir, `${name}.txt`), `${name}1\n${name}2\n${name}3\n${name}4\n${name}5\n${name}6`);
    for (const paths of ["a.txt:1-1 b.txt:1-1", "a.txt:1-1,b.txt:1-1"]) {
      const result = await dispatch({ path: paths });
      expect(result.outcome).toBe("ok");
      expect(result.content).toStartWith(`[Path '${paths}' names several paths; read each in order.]`);
      expect(result.content).toContain("### a.txt:1-1\n1|a1");
      expect(result.content).toContain("### b.txt:1-1\n1|b1");
      expect(result.content).not.toContain("6|");
    }
    expect((await dispatch({ path: "a.txt:1-1,3-3" })).content).toBe("1|a1\n\n...\n\n3|a3");
  });

  it("lists a directory through the ordinary list implementation", async () => {
    fs.mkdirSync(path.join(tmpDir, "src"));
    fs.writeFileSync(path.join(tmpDir, "src", "app.ts"), "not returned");
    const result = await dispatch({ path: "src" });
    expect(result.outcome).toBe("ok");
    expect(result.content).toBe("[Path 'src' is a directory; listed its contents instead.]\nsrc/app.ts");
    fs.mkdirSync(path.join(tmpDir, "other", "src"), { recursive: true });
    const ambiguous = await dispatch({ path: "missing/src" });
    expect(ambiguous.outcome).toBe("error");
    expect(ambiguous.content).toContain("src/");
    expect(ambiguous.content).toContain("other/src/");
  });

  it("runs misplaced search arguments on the named file and still validates them", async () => {
    fs.writeFileSync(path.join(tmpDir, "a.txt"), "before\nneedle\nafter");
    const result = await dispatch({ path: "a.txt", pattern: "needle", output_mode: "content", context: "1" });
    expect(result.outcome).toBe("ok");
    expect(result.content).toContain("[Search arguments were supplied to read; searched the named path instead.]");
    expect(result.content).toContain("needle");
    expect(result.content).toContain("before");
    const invalid = await dispatch({ path: "a.txt", pattern: "needle", context: {} });
    expect(invalid.outcome).toBe("error");
    const missing = await dispatch({ path: "a.txt", output_mode: "content" });
    expect(missing.outcome).toBe("error");
    expect(missing.content).toContain("pattern");
  });

  it("respects offset (0-based) and limit", async () => {
    const filePath = path.join(tmpDir, "lines.txt");
    const lines = Array.from({ length: 10 }, (_, i) => `line ${i + 1}`);
    fs.writeFileSync(filePath, lines.join("\n"));

    const ctx = makeContext({ executionCwd: tmpDir });
    const result = await readDefinition.execute(
      { path: filePath, offset: 2, limit: 3 },
      ctx,
    );
    expect(result.outcome).toBe("ok");
    expect(result.content).toContain("3|line 3");
    expect(result.content).toContain("4|line 4");
    expect(result.content).toContain("5|line 5");
    expect(result.content).not.toContain("line 2\n");
    expect(result.content).not.toContain("|line 6");
    expect(result.content).toContain("Starting from line 3");
    expect(result.content).toContain("more line");
  });

  it("reads PNG file and returns structured image content parts", async () => {
    const imgPath = path.join(tmpDir, "test.png");
    const TINY_PNG = Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==",
      "base64",
    );
    fs.writeFileSync(imgPath, TINY_PNG);

    const ctx = makeContext({ executionCwd: tmpDir });
    const result = await readDefinition.execute({ path: imgPath }, ctx);
    expect(result.outcome).toBe("ok");
    if (!Array.isArray(result.content)) throw new Error("read must return image content parts");
    const parts = result.content;
    expect(parts[0]).toMatchObject({ type: "image", mediaType: "image/png" });
    const image = parts[0];
    if (image?.type !== "image") throw new Error("read must lead with an image part");
    expect(typeof image.data).toBe("string");
    expect(image.data.length).toBeGreaterThan(0);
    for (const p of parts) {
      if (p.type === "text") expect(p.text).not.toContain("data:image");
    }
  });

  it("reads JPG file and returns structured image content parts", async () => {
    const imgPath = path.join(tmpDir, "test.jpg");
    const jpgBuf = Buffer.from([
      0xFF, 0xD8, 0xFF, 0xE0, 0x00, 0x10, 0x4A, 0x46,
      0x49, 0x46, 0x00, 0x01, 0x01, 0x00, 0x00, 0x01,
      0x00, 0x01, 0x00, 0x00, 0xFF, 0xD9,
    ]);
    fs.writeFileSync(imgPath, jpgBuf);

    const ctx = makeContext({ executionCwd: tmpDir });
    const result = await readDefinition.execute({ path: imgPath }, ctx);
    expect(result.outcome).toBe("ok");
    if (!Array.isArray(result.content)) throw new Error("read must return image content parts");
    const parts = result.content;
    expect(parts[0]).toMatchObject({ type: "image", mediaType: "image/jpeg" });
    const image = parts[0];
    if (image?.type !== "image") throw new Error("read must lead with an image part");
    expect(typeof image.data).toBe("string");
    expect(image.data.length).toBeGreaterThan(0);
    for (const p of parts) {
      if (p.type === "text") expect(p.text).not.toContain("data:image");
    }
  });

  it("labels an image by its bytes, not its extension, and re-encodes a format providers refuse", async () => {
    const pixels = sharp({ create: { width: 2, height: 2, channels: 3, background: "#f00" } });
    const cases = [
      { name: "webp.png", bytes: await pixels.clone().webp().toBuffer(), mediaType: "image/webp", passthrough: true },
      { name: "tiff.png", bytes: await pixels.clone().tiff().toBuffer(), mediaType: "image/png", passthrough: false },
    ];
    for (const { name, bytes, mediaType, passthrough } of cases) {
      fs.writeFileSync(path.join(tmpDir, name), bytes);
      const result = await readDefinition.execute({ path: path.join(tmpDir, name) }, makeContext({ executionCwd: tmpDir }));
      if (!Array.isArray(result.content)) throw new Error("read must return image content parts");
      const [image] = result.content;
      if (image?.type !== "image") throw new Error("read must return the image first");
      expect(image.mediaType).toBe(mediaType);
      expect(image.data === bytes.toString("base64")).toBe(passthrough);
      expect(result.content[1]).toMatchObject({ type: "text", text: "(2x2)" });
    }
  });

  it("treats non-image extensions as text even if binary", async () => {
    const binPath = path.join(tmpDir, "test.bin");
    const buf = Buffer.alloc(100);
    buf[10] = 0;
    fs.writeFileSync(binPath, buf);

    const ctx = makeContext({ executionCwd: tmpDir });
    const result = await readDefinition.execute({ path: binPath }, ctx);
    expect(result.outcome).toBe("error");
    expect(result.content).toContain("binary");
  });

  it("rejects an unsupported image format", async () => {
    const imgPath = path.join(tmpDir, "test.bmp");
    fs.writeFileSync(imgPath, Buffer.from([0x42, 0x4D]));

    const result = await readDefinition.execute({ path: imgPath }, makeContext());
    expect(result.outcome).toBe("error");
    expect(result.content).toContain("Unsupported image format");
  });

  it("rejects images over 20MB", async () => {
    const imgPath = path.join(tmpDir, "large.png");
    const fd = fs.openSync(imgPath, "w");
    fs.ftruncateSync(fd, 21 * 1024 * 1024);
    fs.closeSync(fd);

    const ctx = makeContext({ executionCwd: tmpDir });
    const result = await readDefinition.execute({ path: imgPath }, ctx);
    expect(result.outcome).toBe("error");
    expect(result.content).toContain("too large");
  });

  it("returns error for missing path parameter", async () => {
    const ctx = makeContext({ executionCwd: tmpDir });
    const result = await readDefinition.execute({}, ctx);
    expect(result.outcome).toBe("error");
    expect(result.content).toContain("'path' string");
  });

  it("returns error for nonexistent file", async () => {
    const ctx = makeContext({ executionCwd: tmpDir });
    const result = await readDefinition.execute(
      { path: path.join(tmpDir, "does-not-exist.txt") },
      ctx,
    );
    expect(result.outcome).toBe("error");
    expect(result.content).toContain("Failed to read");
    expect(result.content).toContain("Use list");
  });

  it("read with map: true includes structural map for a .ts file", async () => {
    const filePath = path.join(tmpDir, "mapped.ts");
    const tsContent = [
      "export function greet(name: string): string {",
      `  return \`Hello, ${nameInterpolation}\`;`,
      "}",
      "",
      "export class Calculator {",
      "  add(a: number, b: number): number {",
      "    return a + b;",
      "  }",
      "  subtract(a: number, b: number): number {",
      "    return a - b;",
      "  }",
      "}",
      "",
      "interface Config {",
      "  debug: boolean;",
      "  port: number;",
      "}",
      "",
      'type Status = "active" | "inactive";',
      "",
      "const DEFAULT_PORT = 3000;",
    ].join("\n");
    fs.writeFileSync(filePath, tsContent);

    const ctx = makeContext({ executionCwd: tmpDir });
    const result = await readDefinition.execute({ path: filePath, map: true }, ctx);
    expect(result.outcome).toBe("ok");
    expect(result.content).toContain("--- Structural Map (mapped.ts,");
    expect(result.content).toContain("function greet:");
    expect(result.content).toContain("class Calculator:");
    expect(result.content).toContain("  method add:");
  });

  it("truncated read auto-appends structural map", async () => {
    const filePath = path.join(tmpDir, "large.ts");
    const lines = [
      "export function topFunc(): void {",
      ...Array.from({ length: 2998 }, (_, i) => `  const x${i} = ${i};`),
      "}",
    ];
    fs.writeFileSync(filePath, lines.join("\n"));

    const ctx = makeContext({ executionCwd: tmpDir });
    const result = await readDefinition.execute({ path: filePath }, ctx);
    expect(result.outcome).toBe("ok");
    expect(result.content).toContain("ln elided");
    expect(result.content).toContain("export function topFunc(): void { … }");
    expect(result.content).not.toContain("--- Structural Map");
  });

  it("read with symbol dot notation returns method", async () => {
    const filePath = path.join(tmpDir, "cls.ts");
    const tsContent = [
      "export class Calculator {",
      "  add(a: number, b: number): number {",
      "    return a + b;",
      "  }",
      "  subtract(a: number, b: number): number {",
      "    return a - b;",
      "  }",
      "}",
    ].join("\n");
    fs.writeFileSync(filePath, tsContent);

    const ctx = makeContext({ executionCwd: tmpDir });
    const result = await readDefinition.execute({ path: filePath, symbol: "Calculator.add" }, ctx);
    expect(result.outcome).toBe("ok");
    expect(result.content).toContain("[Symbol: add (method)");
    expect(result.content).toContain("a + b");
    expect(result.content).not.toContain("a - b");
  });

  it("read with nonexistent symbol falls back with available symbols", async () => {
    const filePath = path.join(tmpDir, "avail.ts");
    const tsContent = [
      "export function greet(): string {",
      '  return "Hi";',
      "}",
    ].join("\n");
    fs.writeFileSync(filePath, tsContent);

    const ctx = makeContext({ executionCwd: tmpDir });
    const result = await readDefinition.execute({ path: filePath, symbol: "nonexistent" }, ctx);
    expect(result.outcome).toBe("ok");
    expect(result.content).toContain('symbol "nonexistent" not found');
    expect(result.content).toContain("greet");
    expect(result.content).toContain("Falling back to normal read");
  });

  it("reads a symbol and reports ignoring offset and limit", async () => {
    const filePath = path.join(tmpDir, "excl.ts");
    fs.writeFileSync(filePath, "const x = 1;");

    const result = await dispatch({ path: filePath, symbol: "x", offset: 5, limit: 1 });
    expect(result.outcome).toBe("ok");
    expect(result.content).toStartWith("[Read symbol 'x'; ignored offset and limit.]");
    expect(result.content).toContain("const x = 1;");
  });

  it("read with symbol and map returns error (mutually exclusive)", async () => {
    const filePath = path.join(tmpDir, "excl2.ts");
    fs.writeFileSync(filePath, "const x = 1;");

    const ctx = makeContext({ executionCwd: tmpDir });
    const result = await readDefinition.execute({ path: filePath, symbol: "x", map: true }, ctx);
    expect(result.outcome).toBe("error");
    expect(result.content).toContain("mutually exclusive");
  });

  it("rejects a zero limit instead of silently truncating to one line", async () => {
    const filePath = path.join(tmpDir, "ranges.txt");
    const lines = Array.from({ length: 10 }, (_, i) => `line ${i + 1}`);
    fs.writeFileSync(filePath, lines.join("\n"));

    const ctx = makeContext({ executionCwd: tmpDir });
    const result = await readDefinition.execute({ path: filePath, limit: 0 }, ctx);
    expect(result.outcome).toBe("error");
    expect(result.content).toContain("limit must be at least 1");
    expect(result.content).not.toContain("|line 1");
  });

  it("rejects a negative offset", async () => {
    const filePath = path.join(tmpDir, "negoff.txt");
    fs.writeFileSync(filePath, "a\nb\nc");

    const ctx = makeContext({ executionCwd: tmpDir });
    const result = await readDefinition.execute({ path: filePath, offset: -1 }, ctx);
    expect(result.outcome).toBe("error");
    expect(result.content).toContain("offset must be at least 0");
  });
  it("summarizes only an option-free large code read", async () => {
    const filePath = path.join(tmpDir, "summary.ts");
    const lines = [
      "export function alpha(): number {",
      "  const one = 1;",
      "  const two = 2;",
      "  return one + two;",
      "}",
      ...Array.from({ length: 96 }, (_, index) => `const padding${index} = ${index};`),
    ];
    fs.writeFileSync(filePath, lines.join("\n"));
    const ctx = makeContext({ executionCwd: tmpDir });

    const summarized = await readDefinition.execute({ path: filePath }, ctx);
    expect(summarized.outcome).toBe("ok");
    expect(summarized.content).toContain("[…3ln elided; re-read needed ranges with");

    for (const input of [
      { path: filePath, offset: 0 },
      { path: filePath, limit: 2000 },
      { path: `${filePath}:1-1000` },
      { path: `${filePath}:raw` },
    ]) {
      const explicit = await readDefinition.execute(input, makeContext({ executionCwd: tmpDir }));
      expect(explicit.content).toContain("const one = 1;");
      expect(explicit.content).not.toContain("ln elided");
    }
  });

  it("gives a workflow step the whole file of a large code read, while a chat gets the summary, under one read definition", async () => {
    const filePath = path.join(tmpDir, "large.ts");
    const lines = [
      "export function alpha(): number {",
      "  const hiddenFromChat = 1;",
      "  const two = 2;",
      "  return hiddenFromChat + two;",
      "}",
      ...Array.from({ length: 295 }, (_, index) => `const padding${index} = ${index};`),
    ];
    fs.writeFileSync(filePath, lines.join("\n"));
    const advertised: string[] = [];
    const readFor = async (purpose: AgentPurpose) => {
      const planned = await planToolExposure({ kernel: testKernelToolDeps({ purpose }), modules: NO_MODULE_RUNTIMES });
      const read = planned.tools.get("read");
      if (!read) throw new Error(`no read tool for ${purpose.kind}`);
      advertised.push(JSON.stringify({ description: read.description, inputSchema: read.inputSchema }));
      return read.execute({ path: filePath }, makeContext({ executionCwd: tmpDir }));
    };

    const step = await readFor({ kind: "workflow-agent", briefScope: { briefId: "review" }, workflowAttemptId: "review-1" });
    expect(step.content).toContain("  const hiddenFromChat = 1;");
    expect(step.content).toContain("const padding294 = 294;");
    expect(step.content).not.toContain("ln elided");
    expect(step.content).not.toContain("more line");

    const chat = await readFor({ kind: "interactive-chat" });
    expect(chat.content).toContain("ln elided");
    expect(chat.content).not.toContain("const hiddenFromChat = 1;");
    // Every agent of a chat tree shares one engine host, which fixes the tool bytes.
    expect(advertised).toHaveLength(2);
    expect(new Set(advertised).size).toBe(1);
  });

  it("falls back to full reads for malformed code and unsupported prose", async () => {
    const filePath = path.join(tmpDir, "broken-large.ts");
    const text = `${Array.from({ length: 2100 }, (_, index) => `const value${index} = ${index};`).join("\n")}\nexport function broken( {`;
    fs.writeFileSync(filePath, text);
    const result = await readDefinition.execute({ path: filePath }, makeContext({ executionCwd: tmpDir }));
    expect(result.content).toContain("export function broken( {");
    expect(result.content).not.toContain("ln elided");
    expect(result.content).not.toContain("more line");

    const markdownPath = path.join(tmpDir, "long.md");
    const markdown = Array.from({ length: 2101 }, (_, index) => `Markdown line ${index + 1}`).join("\n");
    fs.writeFileSync(markdownPath, markdown);
    const prose = await readDefinition.execute({ path: markdownPath }, makeContext({ executionCwd: tmpDir }));
    expect(prose.content).toContain("Markdown line 2101");
    expect(prose.content).not.toContain("ln elided");
    expect(prose.content).not.toContain("more line");
  });
});
