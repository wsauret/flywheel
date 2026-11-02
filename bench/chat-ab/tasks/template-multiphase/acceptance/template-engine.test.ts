import { describe, expect, test } from "bun:test";
import { render } from "../render.js";
import { tokenize } from "../tokenizer.js";
import { TemplateError } from "../types.js";

function renderError(template: string): TemplateError {
  try {
    render(template, {});
  } catch (error) {
    expect(error).toBeInstanceOf(TemplateError);
    if (error instanceof TemplateError) return error;
    throw error;
  }
  throw new Error("Expected render to throw");
}

describe("public error contract", () => {
  test("preserves the exact message, name, and source position", () => {
    const error = new TemplateError("Unexpected closing tag: if", 4);
    expect(error.name).toBe("TemplateError");
    expect(error.message).toBe("Template error: Unexpected closing tag: if at position 4");
    expect(error.position).toBe(4);
  });
});

describe("tokenizer", () => {
  test("recognizes every tag form with trimmed paths and exact opening offsets", () => {
    expect(tokenize("a{{ name }}{{{ raw.path }}}{{#if  ready }}{{#each rows }}{{/each}}{{/if}}"))
      .toEqual([
        { kind: "text", value: "a", position: 0 },
        { kind: "variable", path: "name", escaped: true, position: 1 },
        { kind: "variable", path: "raw.path", escaped: false, position: 11 },
        { kind: "open", block: "if", path: "ready", position: 27 },
        { kind: "open", block: "each", path: "rows", position: 42 },
        { kind: "close", block: "each", position: 57 },
        { kind: "close", block: "if", position: 66 },
      ]);
  });

  test("preserves literal spans and omits empty text tokens", () => {
    expect(tokenize("abc")).toEqual([{ kind: "text", value: "abc", position: 0 }]);
    expect(tokenize("")).toEqual([]);
    expect(tokenize("{{a}}{{{b}}}")).toEqual([
      { kind: "variable", path: "a", escaped: true, position: 0 },
      { kind: "variable", path: "b", escaped: false, position: 5 },
    ]);
  });
});

describe("variables", () => {
  test("substitutes variables and preserves untagged text", () => {
    expect(render("Hello {{name}}", { name: "Ada" })).toBe("Hello Ada");
    expect(render("Hello, world!")).toBe("Hello, world!");
    expect(render(" first\n  second ")).toBe(" first\n  second ");
  });

  test("walks a dot path", () => {
    expect(render("{{ user.profile.name }}", { user: { profile: { name: "Lin" } } })).toBe("Lin");
  });

  test("renders missing and intermediate nullish paths as empty text", () => {
    expect(render("a{{a}}/{{b}}/{{a.value}}/{{b.value}}/{{missing.value}}b", {
      a: null,
      b: undefined,
    })).toBe("a////b");
  });

  test("uses ordinary string conversion while retaining false and zero", () => {
    const value = { toString: () => "converted" };
    expect(render("{{value}}:{{enabled}}:{{count}}", { value, enabled: false, count: 0 }))
      .toBe("converted:false:0");
  });

  test("escapes all supported HTML characters", () => {
    expect(render("{{value}}", { value: `&<>"'` })).toBe("&amp;&lt;&gt;&quot;&#39;");
  });

  test("triple braces render raw text", () => {
    expect(render("{{{html}}}", { html: "<strong>& ok</strong>" })).toBe("<strong>& ok</strong>");
  });

  test("escaped and raw substitutions remain independent", () => {
    expect(render("{{html}}|{{{html}}}|{{html}}", { html: "<i>x</i>" })).toBe("&lt;i&gt;x&lt;/i&gt;|<i>x</i>|&lt;i&gt;x&lt;/i&gt;");
  });

  test("a missing raw path renders empty text", () => {
    expect(render("x{{{missing.path}}}y", {})).toBe("xy");
  });

});

describe("blocks", () => {
  test("renders a truthy if body", () => {
    expect(render("A{{#if ready}}yes{{/if}}B", { ready: true })).toBe("AyesB");
  });

  test("omits a false if body", () => {
    expect(render("A{{#if ready}}yes{{/if}}B", { ready: false })).toBe("AB");
  });

  test("uses ordinary JavaScript truthiness", () => {
    expect(render("{{#if count}}yes{{/if}}", { count: 0 })).toBe("");
  });

  test("iterates object items with item scope", () => {
    expect(render("{{#each users}}[{{name}}]{{/each}}", { users: [{ name: "A" }, { name: "B" }] })).toBe("[A][B]");
  });

  test("an empty collection renders no body", () => {
    expect(render("before{{#each items}}x{{/each}}after", { items: [] })).toBe("beforeafter");
  });

  test("a missing or non-array each value renders no body", () => {
    expect(render("{{#each missing}}x{{/each}}/{{#each value}}x{{/each}}", { value: "not an array" })).toBe("/");
  });

  test("resolves dot paths from an each item", () => {
    const context = { rows: [{ user: { name: "A" } }, { user: { name: "B" } }] };
    expect(render("{{#each rows}}{{user.name}}{{/each}}", context)).toBe("AB");
  });

  test("nests if inside each", () => {
    const context = { rows: [{ shown: true, name: "A" }, { shown: false, name: "B" }, { shown: 1, name: "C" }] };
    expect(render("{{#each rows}}{{#if shown}}{{name}}{{/if}}{{/each}}", context)).toBe("AC");
  });

  test("nests each inside if", () => {
    const context = { ready: true, groups: [{ values: [{ label: "a" }, { label: "b" }] }] };
    expect(render("{{#if ready}}{{#each groups}}{{#each values}}{{label}}{{/each}}{{/each}}{{/if}}", context)).toBe("ab");
  });

  test("supports nested blocks of the same kind", () => {
    const context = { outer: [{ inner: [{ value: "x" }, { value: "y" }] }] };
    expect(render("{{#if outer}}{{#if inner}}yes{{/if}}{{/if}}", { outer: true, inner: true })).toBe("yes");
    expect(render("{{#each outer}}({{#each inner}}{{value}}{{/each}}){{/each}}", context)).toBe("(xy)");
  });

  test("uses item-only scope without leaking parent fields", () => {
    expect(render("{{#each items}}{{parentOnly}}{{/each}}", {
      parentOnly: "leaked",
      items: [{}],
    })).toBe("");
  });

  test("does not evaluate a nested body when its parent is false", () => {
    let reads = 0;
    const context = {
      ready: false,
      get items(): unknown[] {
        reads += 1;
        return [{ value: "x" }];
      },
    };
    expect(render("{{#if ready}}{{#each items}}{{value}}{{/each}}{{/if}}", context)).toBe("");
    expect(reads).toBe(0);
  });

  test("trims whitespace in block tags", () => {
    expect(render("{{#if   ready }}ok{{/if}}", { ready: true })).toBe("ok");
    expect(render("{{#if\t ready }}ok{{/if}}", { ready: true })).toBe("ok");
    expect(render("{{#each\n rows }}{{name}}{{/each}}", { rows: [{ name: "A" }] })).toBe("A");
  });
});

describe("structural errors", () => {
  test("reports an unclosed if at its opening position", () => {
    expect(renderError("abc{{#if ready}}x").position).toBe(3);
  });

  test("reports an unclosed each at its opening position", () => {
    expect(renderError("x{{#each rows}}y").position).toBe(1);
  });

  test("reports a mismatched closing at the closing position", () => {
    expect(renderError("{{#if ok}}x{{/each}}").position).toBe(11);
  });

  test("reports crossed mismatches at the innermost closing position", () => {
    const reverse = "{{#if a}}{{#each b}}{{/if}}{{/each}}";
    expect(renderError(reverse).position).toBe(reverse.indexOf("{{/if}}"));

    const crossed = "{{#each a}}{{#if b}}{{/each}}{{/if}}";
    expect(renderError(crossed).position).toBe(crossed.indexOf("{{/each}}"));
  });

  test("reports the only outstanding outer block after its nested block closes", () => {
    const template = "x{{#if a}}y{{#each b}}z{{/each}}";
    expect(renderError(template).position).toBe(template.indexOf("{{#if a}}"));
  });

  test("reports an unexpected closing at its position", () => {
    expect(renderError("abc{{/if}}").position).toBe(3);
  });
});
