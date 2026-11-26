import { describe, expect, test } from "bun:test"
import { Schema } from "effect"
import { inputTypeScript, jsonSchemaToTypeScript, outputTypeScript, type JsonSchema, type ToolSignature } from "../../../../../../src/orchestration/modules/code-mode/script/tool-schema.js"

// A raw JSON Schema signature in the shape an MCP adapter produces: render-only input schema
// whose property descriptions and constraints must surface as JSDoc in pretty signatures.
const listIssues: ToolSignature = {
  input: {
    type: "object",
    properties: {
      owner: { type: "string", description: "Repository owner" },
      after: { type: "string", description: "Cursor from the previous response's pageInfo" },
      perPage: { type: "number", description: "Results per page", default: 30 },
      labels: { type: "array", items: { type: "string" }, description: "Filter by labels", minItems: 1, maxItems: 10 },
      state: { type: "string", enum: ["open", "closed"] },
    },
    required: ["owner"],
  },
  output: {},
}

// An Effect Schema signature whose field annotations must flow through the emitted JSON Schema.
const lookupOrder: ToolSignature = {
  input: Schema.Struct({
    id: Schema.String.annotate({ description: "Order identifier" }),
    verbose: Schema.optionalKey(Schema.Boolean),
  }),
  output: Schema.Struct({
    status: Schema.String.annotate({ description: "Current order status" }),
  }),
}

describe("pretty signature rendering", () => {
  test("described fields get JSDoc comments; undescribed and untagged fields get none", () => {
    expect(inputTypeScript(listIssues, true)).toBe(
      [
        "{",
        "  /** Repository owner */",
        "  owner: string,",
        "  /** Cursor from the previous response's pageInfo */",
        "  after?: string,",
        "  /**",
        "   * Results per page",
        "   * @default 30",
        "   */",
        "  perPage?: number,",
        "  /**",
        "   * Filter by labels",
        "   * @minItems 1",
        "   * @maxItems 10",
        "   */",
        "  labels?: Array<string>,",
        '  state?: "open" | "closed",',
        "}",
      ].join("\n"),
    )
  })

  test("compact mode output is unchanged by the pretty machinery", () => {
    expect(inputTypeScript(listIssues)).toBe(
      '{ owner: string; after?: string; perPage?: number; labels?: Array<string>; state?: "open" | "closed" }',
    )
    expect(inputTypeScript(lookupOrder)).toBe("{ id: string; verbose?: boolean }")
    expect(outputTypeScript(lookupOrder)).toBe("{ status: string }")
  })

  test("nested objects recurse with increasing indent and their own JSDoc", () => {
    const pretty = jsonSchemaToTypeScript(
      {
        type: "object",
        properties: {
          filter: {
            type: "object",
            description: "Search filter",
            properties: { state: { type: "string", description: "Issue state" } },
          },
        },
      },
      true,
    )
    expect(pretty).toBe(
      [
        "{",
        "  /** Search filter */",
        "  filter?: {",
        "    /** Issue state */",
        "    state?: string,",
        "  },",
        "}",
      ].join("\n"),
    )
  })

  test("Effect Schema annotations become JSDoc on input and output fields", () => {
    expect(inputTypeScript(lookupOrder, true)).toBe(
      ["{", "  /** Order identifier */", "  id: string,", "  verbose?: boolean,", "}"].join("\n"),
    )
    expect(outputTypeScript(lookupOrder, true)).toBe(
      ["{", "  /** Current order status */", "  status: string,", "}"].join("\n"),
    )
  })

  test("constraints TypeScript cannot express surface as JSDoc tags", () => {
    const pretty = jsonSchemaToTypeScript(
      {
        type: "object",
        properties: {
          legacy: { type: "string", deprecated: true },
          homepage: { type: "string", format: "uri" },
          tags: { type: "array", items: { type: "string" }, minItems: 2, maxItems: 5, default: ["a", "b"] },
        },
      },
      true,
    )
    expect(pretty).toContain("  /** @deprecated */\n  legacy?: string")
    expect(pretty).toContain("  /** @format uri */\n  homepage?: string")
    expect(pretty).toContain(
      [
        "  /**",
        '   * @default ["a","b"]',
        "   * @minItems 2",
        "   * @maxItems 5",
        "   */",
        "  tags?: Array<string>",
      ].join("\n"),
    )
  })

  test("skips an unserializable default rather than emitting a broken tag", () => {
    const pretty = jsonSchemaToTypeScript(
      { type: "object", properties: { size: { type: "number", default: 1n } } },
      true,
    )
    expect(pretty).toBe(["{", "  size?: number,", "}"].join("\n"))
  })

  test("neutralizes */ inside descriptions so nothing closes the comment early", () => {
    const pretty = jsonSchemaToTypeScript(
      { type: "object", properties: { note: { type: "string", description: "Ends */ early" } } },
      true,
    )
    expect(pretty).toContain("  /** Ends * / early */")
    expect(pretty).not.toContain("Ends */")
  })

  test("multiline descriptions become *-prefixed blocks with blank edges trimmed", () => {
    const pretty = jsonSchemaToTypeScript(
      {
        type: "object",
        properties: { query: { type: "string", description: "\nFirst line\n\nSecond line\n" } },
      },
      true,
    )
    expect(pretty).toBe(
      ["{", "  /**", "   * First line", "   *", "   * Second line", "   */", "  query?: string,", "}"].join("\n"),
    )
  })

  test("stays total on cyclic $refs and pathological nesting in both modes", () => {
    const cyclic = {
      $ref: "#/$defs/Node",
      $defs: { Node: { type: "object", properties: { child: { $ref: "#/$defs/Node" }, name: { type: "string" } } } },
    } as const
    expect(jsonSchemaToTypeScript(cyclic)).toBe("{ child?: unknown; name?: string }")
    expect(jsonSchemaToTypeScript(cyclic, true)).toContain("child?: unknown")

    let deep: JsonSchema = { type: "string" }
    for (let level = 0; level < 12; level += 1) deep = { type: "object", properties: { next: deep } }
    for (const pretty of [false, true]) {
      const rendered = jsonSchemaToTypeScript(deep, pretty)
      expect(rendered).toContain("unknown")
      expect(rendered).toContain("next?:")
    }
  })

  test("intersects ref and union siblings instead of discarding them", () => {
    expect(
      jsonSchemaToTypeScript({
        $ref: "#/$defs/User",
        properties: { active: { type: "boolean" } },
        required: ["active"],
        $defs: {
          User: { type: "object", properties: { id: { type: "string" } }, required: ["id"] },
        },
      }),
    ).toBe("{ id: string } & { active: boolean }")
    expect(
      jsonSchemaToTypeScript({
        type: "object",
        properties: { common: { type: "boolean" } },
        required: ["common"],
        anyOf: [
          { type: "object", properties: { name: { type: "string" } }, required: ["name"] },
          { type: "object", properties: { count: { type: "number" } }, required: ["count"] },
        ],
      }),
    ).toBe("({ name: string } | { count: number }) & { common: boolean }")
    expect(jsonSchemaToTypeScript({ $ref: "https://example.com/schema.json" })).toBe("unknown")
    expect(
      jsonSchemaToTypeScript({
        $ref: "#/$defs/User/properties/id",
        $defs: { User: { type: "object" }, id: { type: "string" } },
      }),
    ).toBe("unknown")
    expect(
      jsonSchemaToTypeScript({
        type: ["object", "null"],
        properties: { name: { type: "string" } },
      }),
    ).toBe("{ name?: string } | null")
  })
})

describe("non-identifier property names render as quoted keys", () => {
  // MCP-style schemas routinely carry property names that are not bare TS identifiers
  // (`foo-bar`, `@type`, dotted names); the rendered signature must quote them so the
  // model sees a valid TypeScript object type. Bare identifiers stay unquoted.
  const rawSchema = {
    type: "object",
    properties: {
      "foo-bar": { type: "string" },
      "@type": { type: "string" },
      "x.y": { type: "number", description: "Dotted name" },
      "123": { type: "number" },
      plain: { type: "boolean" },
    },
    required: ["@type"],
  } as const

  test("compact rendering quotes non-identifier keys and leaves identifiers bare", () => {
    expect(jsonSchemaToTypeScript(rawSchema)).toBe(
      '{ "123"?: number; "foo-bar"?: string; "@type": string; "x.y"?: number; plain?: boolean }',
    )
  })

  test("pretty rendering quotes non-identifier keys and keeps their JSDoc", () => {
    expect(jsonSchemaToTypeScript(rawSchema, true)).toBe(
      [
        "{",
        '  "123"?: number,',
        '  "foo-bar"?: string,',
        '  "@type": string,',
        "  /** Dotted name */",
        '  "x.y"?: number,',
        "  plain?: boolean,",
        "}",
      ].join("\n"),
    )
  })

  test("Effect Schema structs with non-identifier field names quote too", () => {
    const tool: ToolSignature = {
      input: Schema.Struct({ "foo-bar": Schema.String, plain: Schema.optionalKey(Schema.Number) }),
    }
    expect(inputTypeScript(tool)).toBe('{ "foo-bar": string; plain?: number }')
    expect(inputTypeScript(tool, true)).toBe(["{", '  "foo-bar": string,', "  plain?: number,", "}"].join("\n"))
  })
})

describe("union schemas render every alternative", () => {
  test("nullable numeric unions keep null", () => {
    const schema = {
      oneOf: [{ type: "number" }, { type: "null" }],
    } as const
    expect(jsonSchemaToTypeScript(schema)).toBe("number | null")
    expect(jsonSchemaToTypeScript(schema, true)).toBe("number | null")
  })

  test("tool input and output signatures preserve numeric unions", () => {
    const tool: ToolSignature = {
      input: {
        type: "object",
        properties: {
          value: { anyOf: [{ type: "string" }, { type: "number" }] },
        },
      } as const,
      output: { anyOf: [{ type: "number" }, { type: "boolean" }] } as const,
    }
    expect(inputTypeScript(tool)).toBe("{ value?: string | number }")
    expect(outputTypeScript(tool)).toBe("number | boolean")
  })

  test("allOf renders intersections with parenthesized union members", () => {
    const schema = {
      allOf: [{ type: "object", properties: { id: { type: "string" } } }, { type: ["string", "null"] }],
    } as const
    expect(jsonSchemaToTypeScript(schema)).toBe("{ id?: string } & (string | null)")
  })

  test("allOf does not discard an unresolved constraint", () => {
    expect(jsonSchemaToTypeScript({ allOf: [{ type: "string" }, { $ref: "https://example.com/external.json" }] })).toBe(
      "unknown",
    )
    expect(
      jsonSchemaToTypeScript({
        allOf: [{ type: "string" }, { allOf: [{ $ref: "https://example.com/external.json" }] }],
      }),
    ).toBe("unknown")
    expect(
      jsonSchemaToTypeScript({
        type: "string",
        allOf: [{ $ref: "#/$defs/Constraint" }],
        $defs: { Constraint: { description: "TypeScript-neutral constraint" } },
      }),
    ).toBe("string")
  })
})
