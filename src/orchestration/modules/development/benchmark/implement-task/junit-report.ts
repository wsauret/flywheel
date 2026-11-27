/** One acceptance test's outcome in a Bun JUnit report. */
export type TestOutcome = "pass" | "fail";

const XML_ENTITIES = new Map([["&amp;", "&"], ["&lt;", "<"], ["&gt;", ">"], ["&quot;", "\""], ["&apos;", "'"]]);

function unescapeXml(value: string): string {
  return value.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (entity, name: string) => {
    if (name.startsWith("#x") || name.startsWith("#X")) return String.fromCodePoint(Number.parseInt(name.slice(2), 16));
    if (name.startsWith("#")) return String.fromCodePoint(Number(name.slice(1)));
    return XML_ENTITIES.get(entity) ?? entity;
  });
}

function attribute(tag: string, name: string): string | undefined {
  const value = new RegExp(`\\s${name}="([^"]*)"`).exec(tag)?.[1];
  return value === undefined ? undefined : unescapeXml(value);
}

/** The name Bun (1.4.0 through 1.4.4) gives the test it reports for a beforeAll or afterAll
 *  hook that throws. The test belongs to the hook's scope: its file or describe. */
const HOOK_FAILURE = "(unnamed)";

/** Reads Bun's JUnit report (`bun test --reporter=junit`). Bun writes one
 *  outer suite per file, named by the file's path, and one nested suite per
 *  describe; a test's `classname` holds only part of that path, so the id is
 *  built from the suite nesting. A failed, skipped, or todo test fails: the
 *  acceptance suite is fixed, so a skip can only come from the agent's change.
 *  A throwing beforeAll or afterAll hook fails every test of its scope. Bun
 *  leaves out the tests of a file that does not load and of a throwing
 *  beforeAll, so a caller that lists its tests fails them as unreported. */
export function parseJUnitReport(xml: string): Map<string, TestOutcome> {
  const outcomes = new Map<string, TestOutcome>();
  const failedHookScopes: string[] = [];
  const suites: string[] = [];
  let open: string | undefined;
  const settle = (id: string, outcome: TestOutcome) => {
    if (id.endsWith(` > ${HOOK_FAILURE}`)) {
      if (outcome === "fail") failedHookScopes.push(id.slice(0, -HOOK_FAILURE.length));
      return;
    }
    if (outcomes.has(id)) throw new Error(`two acceptance tests share the id ${id}`);
    outcomes.set(id, outcome);
  };
  for (const [tag, closing, element, selfClosing] of xml.matchAll(/<(\/?)(testsuite|testcase|failure|error|skipped)\b[^>]*?(\/?)>/g)) {
    if (element === "testsuite") {
      if (closing) suites.pop();
      else if (!selfClosing) {
        const name = attribute(tag, "name") ?? "";
        // The outer suite is the file path, which Bun on Windows writes with backslashes; ids use forward slashes on every platform.
        suites.push(suites.length === 0 ? name.replaceAll("\\", "/") : name);
      }
    } else if (element === "testcase") {
      if (closing) {
        if (open !== undefined) settle(open, "pass");
        open = undefined;
        continue;
      }
      const id = [...suites, attribute(tag, "name") ?? ""].join(" > ");
      if (selfClosing) settle(id, "pass");
      else open = id;
    } else if (open !== undefined && !closing) {
      settle(open, "fail");
      open = undefined;
    }
  }
  for (const id of outcomes.keys()) {
    if (failedHookScopes.some((scope) => id.startsWith(scope))) outcomes.set(id, "fail");
  }
  return outcomes;
}
