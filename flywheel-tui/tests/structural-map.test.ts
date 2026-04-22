import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { generateFileMap, formatFileMap, lookupSymbol } from "../src/orchestration/engines/providers/harness/tools/structural-map.js";
import type { FileMap } from "../src/orchestration/engines/providers/harness/tools/structural-map.js";

describe("structural-map", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "structural-map-test-"));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  const TS_SOURCE = `
function standalone(x: number): number {
  return x * 2;
}

export function greet(name: string): string {
  return \`Hello, \${name}\`;
}

export class Calculator {
  add(a: number, b: number): number {
    return a + b;
  }
  subtract(a: number, b: number): number {
    return a - b;
  }
}

interface Config {
  debug: boolean;
  port: number;
}

type Status = "active" | "inactive";

const DEFAULT_PORT = 3000;

enum Color {
  Red,
  Green,
  Blue,
}
`.trimStart();

  function writeTsFile(content: string): string {
    const filePath = path.join(tmpDir, "test.ts");
    fs.writeFileSync(filePath, content);
    return filePath;
  }

  it("extracts functions from TS source", async () => {
    const filePath = writeTsFile(TS_SOURCE);
    const map = await generateFileMap(filePath);
    expect(map).not.toBeNull();
    const funcs = map!.symbols.filter((s) => s.kind === "function");
    expect(funcs.length).toBe(2);
    expect(funcs.map((f) => f.name)).toEqual(["standalone", "greet"]);
  });

  it("extracts classes with method children", async () => {
    const filePath = writeTsFile(TS_SOURCE);
    const map = await generateFileMap(filePath);
    const classes = map!.symbols.filter((s) => s.kind === "class");
    expect(classes.length).toBe(1);
    const calc = classes[0]!;
    expect(calc.name).toBe("Calculator");
    expect(calc.children).toBeDefined();
    expect(calc.children!.length).toBe(2);
    expect(calc.children!.map((m) => m.name)).toEqual(["add", "subtract"]);
  });

  it("extracts interfaces, type aliases, enums", async () => {
    const filePath = writeTsFile(TS_SOURCE);
    const map = await generateFileMap(filePath);
    const ifaces = map!.symbols.filter((s) => s.kind === "interface");
    expect(ifaces.length).toBe(1);
    expect(ifaces[0]!.name).toBe("Config");

    const types = map!.symbols.filter((s) => s.kind === "type");
    expect(types.length).toBe(1);
    expect(types[0]!.name).toBe("Status");

    const enums = map!.symbols.filter((s) => s.kind === "enum");
    expect(enums.length).toBe(1);
    expect(enums[0]!.name).toBe("Color");
  });

  it("extracts const declarations", async () => {
    const filePath = writeTsFile(TS_SOURCE);
    const map = await generateFileMap(filePath);
    const consts = map!.symbols.filter((s) => s.kind === "const");
    expect(consts.length).toBe(1);
    expect(consts[0]!.name).toBe("DEFAULT_PORT");
  });

  it("returns null for unsupported extensions", async () => {
    for (const ext of [".py", ".go", ".rs"]) {
      const filePath = path.join(tmpDir, `test${ext}`);
      fs.writeFileSync(filePath, "some content");
      const map = await generateFileMap(filePath);
      expect(map).toBeNull();
    }
  });

  it("formatFileMap produces expected indented layout", async () => {
    const filePath = writeTsFile(TS_SOURCE);
    const map = await generateFileMap(filePath);
    const output = formatFileMap(map!, filePath);
    expect(output).toContain("--- Structural Map (test.ts,");
    expect(output).toContain("function standalone:");
    expect(output).toContain("function greet:");
    expect(output).toContain("class Calculator:");
    expect(output).toContain("  method add:");
    expect(output).toContain("  method subtract:");
    expect(output).toContain("interface Config:");
    expect(output).toContain("type Status:");
    expect(output).toContain("const DEFAULT_PORT:");
    expect(output).toContain("enum Color:");
  });

  describe("lookupSymbol", () => {
    function makeMap(): FileMap {
      return {
        totalLines: 100,
        language: "TypeScript",
        symbols: [
          { name: "createSession", kind: "function", startLine: 1, endLine: 10 },
          { name: "createManager", kind: "function", startLine: 12, endLine: 30 },
          {
            name: "Calculator",
            kind: "class",
            startLine: 32,
            endLine: 60,
            children: [
              { name: "add", kind: "method", startLine: 34, endLine: 40 },
              { name: "subtract", kind: "method", startLine: 42, endLine: 48 },
            ],
          },
          { name: "Config", kind: "interface", startLine: 62, endLine: 70 },
        ],
      };
    }

    it("exact match returns found", () => {
      const result = lookupSymbol(makeMap(), "createSession");
      expect(result.type).toBe("found");
      if (result.type === "found") {
        expect(result.symbol.name).toBe("createSession");
        expect(result.symbol.kind).toBe("function");
      }
    });

    it("dot-path resolution (Class.method)", () => {
      const result = lookupSymbol(makeMap(), "Calculator.add");
      expect(result.type).toBe("found");
      if (result.type === "found") {
        expect(result.symbol.name).toBe("add");
        expect(result.symbol.kind).toBe("method");
      }
    });

    it("case-insensitive match", () => {
      const result = lookupSymbol(makeMap(), "config");
      expect(result.type).toBe("found");
      if (result.type === "found") {
        expect(result.symbol.name).toBe("Config");
      }
    });

    it("prefix match", () => {
      const result = lookupSymbol(makeMap(), "createS");
      expect(result.type).toBe("found");
      if (result.type === "found") {
        expect(result.symbol.name).toBe("createSession");
      }
    });

    it("ambiguous returns multiple candidates", () => {
      const result = lookupSymbol(makeMap(), "create");
      expect(result.type).toBe("ambiguous");
      if (result.type === "ambiguous") {
        expect(result.candidates.length).toBe(2);
        expect(result.candidates.map((c) => c.name)).toContain("createSession");
        expect(result.candidates.map((c) => c.name)).toContain("createManager");
      }
    });

    it("not-found returns available list", () => {
      const result = lookupSymbol(makeMap(), "nonexistent");
      expect(result.type).toBe("not-found");
      if (result.type === "not-found") {
        expect(result.available.length).toBeGreaterThan(0);
        expect(result.available.map((s) => s.name)).toContain("createSession");
      }
    });
  });
});
