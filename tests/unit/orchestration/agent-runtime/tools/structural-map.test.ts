import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { generateFileMap, formatFileMap, lookupSymbol } from "../../../../../src/orchestration/agent-runtime/tools/structural-map.js";
import type { FileMap } from "../../../../../src/orchestration/agent-runtime/tools/structural-map.js";

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

  function writeTsxFile(content: string): string {
    const filePath = path.join(tmpDir, "test.tsx");
    fs.writeFileSync(filePath, content);
    return filePath;
  }

  it("parses TSX with the TSX dialect", async () => {
    const filePath = writeTsxFile(`
export function Greeting(props: { name: string }) {
  return <text>Hello {props.name}</text>;
}

export class ViewModel {
  render() {
    return <box />;
  }
}
`.trimStart());
    const map = await generateFileMap({ path: filePath, text: fs.readFileSync(filePath, "utf8") });

    expect(map?.symbols.map((symbol) => symbol.name)).toEqual(["Greeting", "ViewModel"]);
    expect(map?.symbols[1]?.children?.map((symbol) => symbol.name)).toEqual(["render"]);
  });

  it("returns null for unsupported extensions", async () => {
    for (const ext of [".go", ".rs"]) {
      const filePath = path.join(tmpDir, `test${ext}`);
      fs.writeFileSync(filePath, "some content");
      const map = await generateFileMap({ path: filePath, text: fs.readFileSync(filePath, "utf8") });
      expect(map).toBeNull();
    }
  });

  it.each([".py", ".pyi"])("maps Python definitions, decorators, and module assignments in %s", async (extension) => {
    const text = [
      "LIMIT: int = 5",
      "obj.value = 3",
      "left, right = (1, 2)",
      "@decorate('Card')",
      "class Card:",
      "    local = 1",
      "    @staticmethod",
      "    async def _split(value):",
      "        return value",
      "    def _parse_value(self):",
      "        return LIMIT",
      "",
      "@decorate('plain')",
      "def plain():",
      "    hidden = 1",
      "    return hidden",
    ].join("\n");
    const map = await generateFileMap({ path: `card${extension}`, text });
    expect(map?.language).toBe("Python");
    expect(map?.symbols).toEqual([
      { name: "LIMIT", kind: "const", startLine: 1, endLine: 1 },
      {
        name: "Card", kind: "class", startLine: 4, endLine: 11,
        children: [
          { name: "_split", kind: "method", startLine: 7, endLine: 9 },
          { name: "_parse_value", kind: "method", startLine: 10, endLine: 11 },
        ],
      },
      { name: "plain", kind: "function", startLine: 13, endLine: 16 },
    ]);
    expect(lookupSymbol(map!, "Card._split")).toEqual({
      type: "found",
      symbol: { name: "_split", kind: "method", startLine: 7, endLine: 9 },
    });
    expect(lookupSymbol(map!, "Card._parse_value").type).toBe("found");
  });

  it("parses caller-owned text instead of rereading the path", async () => {
    const filePath = writeTsFile("export function diskValue() {}\n");
    const map = await generateFileMap({ path: filePath, text: "export function callerValue() {}\n" });
    expect(map?.symbols.map((symbol) => symbol.name)).toEqual(["callerValue"]);
  });

  it("formatFileMap produces expected indented layout", async () => {
    const filePath = writeTsFile(TS_SOURCE);
    const map = await generateFileMap({ path: filePath, text: fs.readFileSync(filePath, "utf8") });
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

  });
});
