import { describe, expect, test } from "bun:test";
import { patchSemanticAssignment, rewriteSemanticAssignmentKeys, upsertSemanticAssignment } from "../../../../src/orchestration/config/config-assignment.js";

describe("semantic TOML assignments", () => {
  test("upserts quoted subtrees across table, dotted, and sealed inline ancestors", () => {
    for (const root of ["/scratch/project.a", "C:\\Users\\account\\project"]) {
      const project = JSON.stringify(root);
      const path = ["mcp", "projects", root, "servers", "account.name"];
      const sibling = 'other = { command = "keep", args = ["literal"] }';
      const sources = [
        "",
        `# keep\r\n[mcp.projects.${project}.servers]\r\n${sibling}\r\n`,
        `# keep\nmcp.projects.${project}.servers.other = { command = "keep", args = ["literal"] }\n`,
        '# keep\nmcp = { servers = { other = { command = "keep" } } } # tail\n',
        `# keep\nmcp = { projects = { ${project} = { servers = { ${sibling} } } } } # tail\n`,
        `# keep\n[mcp.projects.${project}.servers."account.name"]\ncommand = "old"\nargs = ["old"]\n[mcp.projects.${project}.servers.other]\ncommand = "keep"\n`,
        `# keep\nmcp.projects.${project}.servers = { "account.name" = { command = "old" }, ${sibling} } # tail\n`,
      ];
      for (const source of sources) {
        const updated = upsertSemanticAssignment(source, path, '{ command = "new", args = ["one", "two"] }');
        expect(Bun.TOML.parse(updated)).toMatchObject({
          mcp: { projects: { [root]: { servers: { "account.name": { command: "new", args: ["one", "two"] } } } } },
        });
        if (source.startsWith("# keep")) expect(updated.startsWith(source.startsWith("# keep\r\n") ? "# keep\r\n" : "# keep\n")).toBe(true);
        if (source.includes(sibling)) expect(updated).toContain(sibling);
        if (source.includes("# tail")) expect(updated).toContain("# tail");
        if (source.includes("\r\n")) expect(updated.replaceAll("\r\n", "")).not.toContain("\n");
        const enabled = upsertSemanticAssignment(updated, [...path, "enabled"], "false");
        expect(Bun.TOML.parse(enabled)).toMatchObject({
          mcp: { projects: { [root]: { servers: { "account.name": { command: "new", args: ["one", "two"], enabled: false } } } } },
        });
      }
    }
  });

  test("updates explicit, dotted, quoted, and inline authorities losslessly", () => {
    const fixtures = [
      ['# lead\n[web_search]\n  provider = "chatgpt" # keep\nother = 1\n', '# lead\n[web_search]\n  provider = "exa" # keep\nother = 1\n'],
      ['web_search.provider = \'chatgpt\'\r\nnext = true\r\n', 'web_search.provider = "exa"\r\nnext = true\r\n'],
      ['[\'web_search\']\n"provider" = "chatgpt"\n', '[\'web_search\']\n"provider" = "exa"\n'],
      ['web_search = { timeout = 5, provider = "chatgpt", retries = 2 } # keep\n', 'web_search = { timeout = 5, provider = "exa", retries = 2 } # keep\n'],
      ['web_search = {\n  timeout = 5, # keep\n  provider = "chatgpt",\n  retries = 2\n}\n', 'web_search = {\n  timeout = 5, # keep\n  provider = "exa",\n  retries = 2\n}\n'],
    ] as const;
    for (const [source, expected] of fixtures) {
      expect(patchSemanticAssignment(source, ["web_search", "provider"], '"exa"')).toBe(expected);
    }
  });

  test("decodes every legal basic quoted-key escape without changing surrounding bytes", () => {
    const fixtures = [
      ['["web\\u005fsearch"]\n"pro\\u0076ider" = "chatgpt" # keep\n', '["web\\u005fsearch"]\n"pro\\u0076ider" = "exa" # keep\n'],
      ['"web\\U0000005fsearch"."pro\\tvider" = "chatgpt"\n', '"web\\U0000005fsearch"."pro\\tvider" = "exa"\n'],
      ['web_search = { "pro\\bvider" = "chatgpt", keep = true }\n', 'web_search = { "pro\\bvider" = "exa", keep = true }\n'],
    ] as const;
    const paths = [["web_search", "provider"], ["web_search", "pro\tvider"], ["web_search", "pro\bvider"]] as const;
    for (const [index, [source, expected]] of fixtures.entries()) {
      expect(patchSemanticAssignment(source, paths[index] ?? [], '"exa"')).toBe(expected);
    }
  });

  test("does not carry a table context through an array-of-table header", () => {
    const source = '[web_search]\ntimeout=5\n[[other]]\nprovider="private"\n';
    expect(patchSemanticAssignment(source, ["web_search", "provider"], '"exa"')).toBeUndefined();
    expect(patchSemanticAssignment(source, ["other", "provider"], '"public"')).toBeUndefined();
  });

  test("refuses duplicate semantic authorities", () => {
    const source = 'web_search.provider = "exa"\n\n[web_search]\nprovider = "chatgpt"\n';
    expect(() => patchSemanticAssignment(source, ["web_search", "provider"], '"exa"')).toThrow("multiple authorities");
  });

  test("keeps assignment-looking text inside multiline basic strings", () => {
    const fixtures = [
      ['notes = """before \\"""\ntheme = "inside"\nafter"""\ntheme = "outside"\n', ["theme"]],
      ['root = { nested = { notes = """before \\"""\ntheme = "inside"\nafter""" }, theme = "outside" }\n', ["root", "theme"]],
      ['notes = """one quote""""\ntheme = "outside"\n', ["theme"]],
      ['notes = """two quotes"""""\ntheme = "outside"\n', ["theme"]],
    ] as const;
    for (const [source, path] of fixtures) {
      expect(() => Bun.TOML.parse(source)).not.toThrow();
      expect(patchSemanticAssignment(source, path, '"aura"')).toBe(source.replace('theme = "outside"', 'theme = "aura"'));
    }
  });

  test("keeps assignment-looking text inside multiline literal strings", () => {
    const source = "notes = '''before ''\ntheme = \"inside\"\nafter'''''\ntheme = \"outside\"\n";
    expect(() => Bun.TOML.parse(source)).not.toThrow();
    expect(patchSemanticAssignment(source, ["theme"], '"aura"')).toBe(source.replace('theme = "outside"', 'theme = "aura"'));
  });

  test("does not alter unterminated multiline strings", () => {
    const source = 'notes = """before \\"""\ntheme = "inside"\nafter';
    expect(patchSemanticAssignment(source, ["theme"], '"aura"')).toBeUndefined();
  });

  test("renames and removes semantic map keys in one lossless batch", () => {
    const fixtures = [
      [
        '[aliases] # retained\n"old-date" = "low"\n"old" = "high" # winner\n',
        '[aliases] # retained\n"current" = "high" # winner\n',
      ],
      [
        '["aliases"]\n"old-date" = "low"\n"old" = "high" # winner\n',
        '["aliases"]\n"current" = "high" # winner\n',
      ],
      [
        'aliases = { "old-date" = "low", "old" = "high" # winner\n}\n',
        'aliases = { "current" = "high" # winner\n}\n',
      ],
      [
        'aliases."old-date" = "low"\naliases."old" = "high" # winner\n',
        'aliases."current" = "high" # winner\n',
      ],
    ] as const;
    for (const [source, expected] of fixtures) {
      expect(rewriteSemanticAssignmentKeys(source, [
        { path: ["aliases", "old-date"] },
        { path: ["aliases", "old"], replacement: '"current"' },
      ])).toBe(expected);
    }
    expect(rewriteSemanticAssignmentKeys(
      'aliases = { "current" = "high", "old-date-a" = "low", "old-date-b" = "medium" }\n',
      [
        { path: ["aliases", "current"], replacement: '"current"' },
        { path: ["aliases", "old-date-a"] },
        { path: ["aliases", "old-date-b"] },
      ],
    )).toBe('aliases = { "current" = "high" }\n');
    expect(rewriteSemanticAssignmentKeys(
      'aliases = { "old-a" = "low", "old-b" = "medium", "keep" = "high" }\n',
      [
        { path: ["aliases", "old-a"] },
        { path: ["aliases", "old-b"] },
      ],
    )).toBe('aliases = { "keep" = "high" }\n');
    expect(rewriteSemanticAssignmentKeys(
      'aliases = { nested = { "old-a" = "low", "old-b" = "medium" } }\n',
      [
        { path: ["aliases", "nested", "old-a"] },
        { path: ["aliases", "nested", "old-b"] },
      ],
    )).toBe('aliases = { nested = { } }\n');
    expect(rewriteSemanticAssignmentKeys(
      't = { a = 1, b = { x = 2 }, c = 3 }\n',
      [
        { path: ["t", "b"] },
        { path: ["t", "b", "x"] },
      ],
    )).toBe('t = { a = 1, c = 3 }\n');
  });

  test("ignores section-looking text in multiline values and rejects duplicate authorities", () => {
    const source = 'notes = """[aliases]\n"old" = "inside"\n"""\n[aliases]\n"old" = """high\nstill high""" # winner\n';
    expect(rewriteSemanticAssignmentKeys(source, [
      { path: ["aliases", "old"], replacement: '"current"' },
    ])).toBe(source.replace('"old" = """high', '"current" = """high'));

    expect(() => rewriteSemanticAssignmentKeys(
      'aliases."old" = "low"\n[aliases]\n"old" = "high"\n',
      [{ path: ["aliases", "old"], replacement: '"current"' }],
    )).toThrow("multiple authorities");
  });
});
