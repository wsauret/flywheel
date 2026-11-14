// The publication rules of reviewer benchmark fixtures built from recorded
// reviews: the scan that refuses a fixture which would publish a private
// detail. The scrub of other coding agents' names is the shared loader in
// src/orchestration/modules/development/benchmark/harness-names.ts.
// scripts/build-review-fixtures.ts is the one caller.

/** The private details of the machine that builds fixtures. */
export interface PrivateIdentity {
  home: string;
  user: string;
  machines: readonly string[];
  authProfiles: readonly string[];
  /** Names of private repositories and checkouts. */
  repositories: readonly string[];
}

function escape(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function alternatives(names: readonly string[]): string {
  return names.filter(Boolean).map(escape).join("|") || "(?!)";
}

/** Reserved names that RFC 2606 and RFC 6761 keep out of real use, so an address there names nobody. */
const RESERVED_EMAIL_DOMAIN = /@(?:[\w-]+\.)*(?:example\.(?:com|net|org)|invalid|test|example|localhost)$/i;

/** The exposure categories, each a pattern that one line must not match. */
export function exposurePatterns(identity: PrivateIdentity): ReadonlyMap<string, RegExp> {
  const profiles = alternatives(identity.authProfiles);
  return new Map([
    ["credential", /sk-[A-Za-z0-9_-]{20,}|gh[pousr]_[A-Za-z0-9]{20,}|github_pat_\w{20,}|AKIA[0-9A-Z]{16}|xox[abprs]-[A-Za-z0-9-]{10,}|-----BEGIN [A-Z ]*PRIVATE KEY|eyJ[\w-]{20,}\.[\w-]{20,}\.|(?:api[_-]?key|secret|password|passwd|token)["']?\s*[:=]\s*["'][\w+/=-]{24,}["']|Bearer [\w.=-]{24,}/i],
    ["home path", new RegExp(`${escape(identity.home)}|/Users/${escape(identity.user)}\\b|/home/${escape(identity.user)}\\b|[A-Z]:\\\\+Users\\\\+${escape(identity.user)}\\b`, "i")],
    ["machine name", new RegExp(`\\b(?:${alternatives(identity.machines)})\\b`, "i")],
    ["email", /[\w.%+-]+@[\w.-]+\.[a-z]{2,}\b/i],
    ["auth profile", new RegExp(`(?:AUTH_PROFILE=|--auth-profile[ =]|[Aa]uth[ _-]?[Pp]rofile(?:["']?\\s*[:=]\\s*| ))["']?(?:${profiles})\\b|\\b(?:${profiles}) (?:auth )?profile\\b`)],
    ["private repository", new RegExp(alternatives(identity.repositories))],
    ["session path", /\.flywheel\/sessions\/[0-9a-f]{12}/],
  ]);
}

/** The count of lines of `lines` that match each exposure category. An email
 *  address in a reserved domain is not an exposure. */
export function exposures(patterns: ReadonlyMap<string, RegExp>, lines: Iterable<string>): Map<string, number> {
  const found = new Map<string, number>();
  for (const line of lines) {
    for (const [category, pattern] of patterns) {
      const match = category === "email"
        ? [...line.matchAll(new RegExp(pattern.source, "gi"))].some(([address]) => !RESERVED_EMAIL_DOMAIN.test(address))
        : pattern.test(line);
      if (match) found.set(category, (found.get(category) ?? 0) + 1);
    }
  }
  return found;
}

/** The lines of a unified diff that a fixture would newly publish: every
 *  line except a body line whose text the pinned public tree already holds in
 *  the same file. `publicLines` gives that file's lines.
 *  @yields {string} Each line of `patch` that the fixture newly publishes, in order. */
export function* publishedDiffLines(patch: string, publicLines: (path: string) => ReadonlySet<string>): Generator<string> {
  let known: ReadonlySet<string> = new Set();
  for (const line of patch.split("\n")) {
    if (line.startsWith("diff --git ")) {
      const path = /^diff --git a\/(.+) b\/\1$/.exec(line)?.[1];
      known = path === undefined ? new Set() : publicLines(path);
    }
    if (/^[ +-]/.test(line) && !/^(?:\+\+\+|---) /.test(line) && known.has(line.slice(1))) continue;
    yield line;
  }
}
