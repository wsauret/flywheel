import { describe, expect, test } from "bun:test"
import type { CodeModeToolDescriptor } from "../../../../../../src/orchestration/modules/code-mode/descriptors.js"
import { prepareToolCatalog } from "../../../../../../src/orchestration/modules/code-mode/script/tool-catalog.js"
import type { JsonSchema } from "../../../../../../src/orchestration/modules/code-mode/script/tool-schema.js"

const IDENTIFIER: JsonSchema = { type: "object", properties: { id: { type: "string" } }, required: ["id"] }

const tool = (name: string, description: string, inputSchema: JsonSchema = IDENTIFIER): CodeModeToolDescriptor => ({
  name,
  path: name.split("."),
  description,
  inputSchema,
})

const paths = (catalog: ReturnType<typeof prepareToolCatalog>, request: Parameters<ReturnType<typeof prepareToolCatalog>["search"]>[0]) =>
  catalog.search(request).items.map((item) => item.path)

describe("Code Mode catalog", () => {
  test("orders tools by dotted name whatever order the descriptors arrive in", () => {
    const names = ["zeta.zeta", "zeta.alpha", "alpha.zeta", "alpha.alpha"]
    const forward = prepareToolCatalog(names.map((name) => tool(name, name)))
    const backward = prepareToolCatalog(names.toReversed().map((name) => tool(name, name)))
    expect(forward.tools).toStrictEqual(backward.tools)
    expect(forward.tools.map((item) => item.path)).toEqual(["alpha.alpha", "alpha.zeta", "zeta.alpha", "zeta.zeta"])
  })

  test("renders field JSDoc, bracket notation, and the bridged result type in each signature", () => {
    const listIssues = tool("github.list_issues", "List issues in a repository", {
      type: "object",
      properties: {
        owner: { type: "string", description: "Repository owner" },
        perPage: { type: "number", description: "Results per page", default: 30 },
      },
      required: ["owner"],
    })
    const resolve = tool("context7.resolve-library-id", "Resolve a Context7 library ID", {
      type: "object",
      properties: { libraryName: { type: "string" } },
      required: ["libraryName"],
    })
    const [context7, github] = prepareToolCatalog([listIssues, resolve]).tools
    expect(github?.signature).toStartWith([
      "tools.github.list_issues(input: {",
      "  /** Repository owner */",
      "  owner: string,",
      "  /**",
      "   * Results per page",
      "   * @default 30",
      "   */",
      "  perPage?: number,",
      "}): Promise<{",
    ].join("\n"))
    expect(github?.signature).toContain("content: unknown,")
    expect(context7?.signature).toStartWith('tools.context7["resolve-library-id"](input: {\n  libraryName: string,\n}): Promise<{')
  })
})

describe("searchCatalog ranking", () => {
  test("ranks complete tools for a long query and returns callable paths", () => {
    const catalog = prepareToolCatalog([
      tool("thread.uploadFile", "Upload one readable local file to the current Discord thread"),
      tool("thread.generateImage", "Generate an image and upload it to the current Discord thread"),
      tool("orders.lookup", "Look up an order by ID"),
    ])
    const result = catalog.search({ query: "send message attachment upload file to current Discord thread", limit: 2 })
    expect(result.items.map((item) => item.path)).toEqual(["tools.thread.uploadFile", "tools.thread.generateImage"])
    expect(result.items[0]?.signature).toBe(catalog.tools.find((item) => item.path === "thread.uploadFile")?.signature)
    expect(result).toMatchObject({ remaining: 0, next: null })
    expect(paths(catalog, { query: "file" })[0]).toBe("tools.thread.uploadFile")
    expect(paths(catalog, { query: "image" })[0]).toBe("tools.thread.generateImage")
  })

  test("defaults to 10 results with a next offset and resolves exact tool paths", () => {
    const catalog = prepareToolCatalog(Array.from({ length: 14 }, (_, index) => tool(`many.tool${index}`, `Numbered tool ${index}`)))
    expect(catalog.search({})).toMatchObject({ remaining: 4, next: { offset: 10 } })
    expect(catalog.search({}).items).toHaveLength(10)
    for (const query of ["many.tool13", "tools.many.tool13"]) {
      expect(catalog.search({ query })).toMatchObject({ items: [{ path: "tools.many.tool13", description: "Numbered tool 13" }], remaining: 0, next: null })
    }
  })

  test("resolves an exact bracket-notation path", () => {
    const catalog = prepareToolCatalog([tool("context7.resolve-library-id", "Resolve a library ID"), tool("other.thing", "Other")])
    expect(paths(catalog, { query: 'tools.context7["resolve-library-id"]' })).toEqual(['tools.context7["resolve-library-id"]'])
    expect(paths(catalog, { query: "resolve library" })).toEqual(['tools.context7["resolve-library-id"]'])
  })

  test("scopes to one namespace subtree and browses it alphabetically", () => {
    const catalog = prepareToolCatalog([
      tool("github.list_issues", "List issues"),
      tool("github.create_issue", "Create an issue"),
      tool("linear.list_issues", "List Linear issues"),
      tool("slack.admin.invite", "Invite"),
      tool("slack.admin.users.list", "List users"),
      tool("slack.administrator.list", "List administrators"),
    ])
    expect(paths(catalog, { query: "", namespace: "github" })).toEqual(["tools.github.create_issue", "tools.github.list_issues"])
    expect(paths(catalog, { query: "issues", namespace: "linear" })).toEqual(["tools.linear.list_issues"])
    expect(paths(catalog, { namespace: "slack.admin" })).toEqual(["tools.slack.admin.invite", "tools.slack.admin.users.list"])
  })

  test("matches input parameter names and partial words", () => {
    const catalog = prepareToolCatalog([
      tool("files.upload", "Send a document to the workspace", {
        type: "object",
        properties: { attachment: { type: "string", description: "Local path of the payload to send" } },
        required: ["attachment"],
      }),
      tool("files.other", "Rename the workspace"),
    ])
    expect(paths(catalog, { query: "attachment" })).toEqual(["tools.files.upload"])
    expect(paths(catalog, { query: "docum" })).toEqual(["tools.files.upload"])
  })

  test("a plural term matches singular-only text, and a path match outranks it", () => {
    const catalog = prepareToolCatalog([
      tool("tracker.fetch_all", "Fetch every open issue in the project"),
      tool("github.list_issues", "List issues"),
      tool("misc.rename", "Rename the workspace"),
    ])
    expect(paths(catalog, { query: "issues", namespace: "tracker" })).toEqual(["tools.tracker.fetch_all"])
    expect(paths(catalog, { query: "issues" })).toEqual(["tools.github.list_issues", "tools.tracker.fetch_all"])
  })

  test("an empty query pages through everything alphabetically", () => {
    const catalog = prepareToolCatalog([tool("zeta.last", "Last"), tool("alpha.beta", "Middle"), tool("alpha.aardvark", "First")])
    expect(catalog.search({})).toMatchObject({ remaining: 0, next: null })
    expect(paths(catalog, {})).toEqual(["tools.alpha.aardvark", "tools.alpha.beta", "tools.zeta.last"])
    expect(catalog.search({ limit: 1, offset: 1 })).toMatchObject({ items: [{ path: "tools.alpha.beta" }], remaining: 1, next: { offset: 2 } })
    expect(catalog.search({ limit: 1, offset: 3 })).toStrictEqual({ items: [], remaining: 0, next: null })
  })
})
