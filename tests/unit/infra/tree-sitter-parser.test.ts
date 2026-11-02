import { describe, expect, it } from "bun:test";

import {
  getTreeSitterParser,
  loadTreeSitterParser,
  treeSitterWasmFile,
} from "../../../src/infra/tree-sitter-parser.js";

describe("tree-sitter parser registry", () => {
  it("loads each semantic grammar once from the checkout, whatever native directory a parent build exports", async () => {
    // An installed launcher exports its build's native directory, and a source
    // run started below it inherits that build's grammars, not the checkout's.
    const inherited = process.env.FLYWHEEL_NATIVE_DIR;
    process.env.FLYWHEEL_NATIVE_DIR = "/scratch/another-build/native";
    try {
      for (const language of ["bash", "javascript", "typescript", "tsx", "python"] as const) {
        const first = await loadTreeSitterParser(language);
        const second = await loadTreeSitterParser(language);
        expect(second).toBe(first);
        expect(getTreeSitterParser(language)).toBe(first);
      }
    } finally {
      if (inherited === undefined) delete process.env.FLYWHEEL_NATIVE_DIR;
      else process.env.FLYWHEEL_NATIVE_DIR = inherited;
    }
  });

  it("uses the real TSX dialect", async () => {
    const parser = await loadTreeSitterParser("tsx");
    const tree = parser.parse("const view: JSX.Element = <View name={value} />;");
    expect(tree?.rootNode.hasError).toBe(false);
    expect(tree?.rootNode.toString()).toContain("jsx_self_closing_element");
    tree?.delete();
  });

  it("parses the shell structures used by command policy", async () => {
    const parser = await loadTreeSitterParser("bash");
    const tree = parser.parse("printf '%s' \"$(cat input.txt)\" | tee output.txt");
    expect(tree?.rootNode.hasError).toBe(false);
    expect(tree?.rootNode.descendantsOfType("command")).toHaveLength(3);
    tree?.delete();
  });

  it("publishes canonical packaged asset names", () => {
    expect(treeSitterWasmFile("bash")).toBe("tree-sitter-bash.wasm");
    expect(treeSitterWasmFile("javascript")).toBe("tree-sitter-javascript.wasm");
    expect(treeSitterWasmFile("typescript")).toBe("tree-sitter-typescript.wasm");
    expect(treeSitterWasmFile("tsx")).toBe("tree-sitter-tsx.wasm");
  });
});
