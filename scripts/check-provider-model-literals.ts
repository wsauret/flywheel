import { readdir } from "node:fs/promises";
import { relative, resolve } from "node:path";

export interface ProviderModelLiteralViolation {
  readonly file: string;
  readonly line: number;
  readonly rule: "no-maintained-model-list" | "no-maintained-vendor-aliases" | "no-model-id-routing-branch";
  readonly detail: string;
}

const PROVIDER_SOURCE = /^(?:src\/infra\/llm\/|src\/orchestration\/(?:app-service\/|config\/|agent-runtime\/llm\/|custom-provider-modules\.ts|modules\/provider-[^/]+\/))/;
const EXCLUDED_FILES = new Set(["src/infra/llm/models-bundled.txt"]);
const MODEL_NAMES = /^(?:model|modelId|wireModel|wireModelId|canonical|normalizedModel)$/i;
const AUTHORITY_NAMES = /(?:prefix|allowlist|denylist|pattern)/i;
const SCOPED_EXCEPTION = /provider-model-literal-allow:\s*(?:display|identity|payload)\s+--\s+\S/;

/** Finds maintained provider membership and model-ID routing policy in production provider sources. */
export async function findProviderModelLiteralViolations(repoRoot: string): Promise<readonly ProviderModelLiteralViolation[]> {
  const files = await productionProviderFiles(resolve(repoRoot, "src"));
  const violations: ProviderModelLiteralViolation[] = [];
  for (const absoluteFile of files) {
    const file = relative(repoRoot, absoluteFile).replaceAll("\\", "/");
    if (!PROVIDER_SOURCE.test(file) || EXCLUDED_FILES.has(file)) continue;
    const source = await Bun.file(absoluteFile).text();
    const report = (offset: number, rule: ProviderModelLiteralViolation["rule"], detail: string) => {
      const line = source.slice(0, offset).split("\n").length;
      const sourceLine = source.split("\n")[line - 1] ?? "";
      if (SCOPED_EXCEPTION.test(sourceLine)) return;
      if (!violations.some((entry) => entry.file === file && entry.line === line && entry.rule === rule)) {
        violations.push({ file, line, rule, detail });
      }
    };
    for (const match of source.matchAll(/\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*(?::[^=]+)?=\s*(?:new\s+(?:Set|Map)(?:<[^>]+>)?\s*\(|[[{/])/g)) {
      const name = match[1] ?? "";
      const normalized = name.replaceAll("_", "");
      const standaloneRoutingPattern = /(?:anthropic|openai|google|opencode)/i.test(normalized) && /(?:re|regex|pattern)$/i.test(normalized);
      if (!/catalogids?/i.test(normalized) && ((/model/i.test(normalized) && AUTHORITY_NAMES.test(normalized)) || standaloneRoutingPattern)) {
        report(match.index, "no-maintained-model-list", name);
      }
      if (/vendor/i.test(normalized) && /alias/i.test(normalized)) report(match.index, "no-maintained-vendor-aliases", name);
    }
    for (const match of source.matchAll(/\bdetectModelFamily\s*\(/g)) report(match.index, "no-model-id-routing-branch", match[0]);
    for (const match of source.matchAll(/\b([A-Za-z_$][\w$]*(?:\s*\.\s*(?:toLowerCase|toUpperCase)\s*\(\s*\))?)\s*\.\s*(startsWith|endsWith|includes|match)\s*\(\s*(["'`/][\s\S]*?["'`/])\s*\)/g)) {
      if (MODEL_NAMES.test((match[1] ?? "").replace(/\s*\..*$/, ""))) report(match.index, "no-model-id-routing-branch", match[0]);
    }
    for (const match of source.matchAll(/\b([A-Za-z_$][\w$]*(?:PATTERN|PATTERNS|RE|REGEX)[\w$]*)\s*\.\s*test\s*\(\s*([A-Za-z_$][\w$]*)\s*,?\s*\)/gi)) {
      if (MODEL_NAMES.test(match[2] ?? "")) report(match.index, "no-model-id-routing-branch", match[0]);
    }
    for (const match of source.matchAll(/\b([A-Za-z_$][\w$]*)\s*(===|!==|==|!=)\s*(["'`][^"'`]+["'`])/g)) {
      if (MODEL_NAMES.test(match[1] ?? "") && match[3] !== "\"string\"" && match[3] !== "'string'") report(match.index, "no-model-id-routing-branch", match[0]);
    }
  }
  return violations.toSorted((a, b) => a.file.localeCompare(b.file) || a.line - b.line || a.rule.localeCompare(b.rule));
}

async function productionProviderFiles(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true }).catch(() => []);
  const files = await Promise.all(entries.map((entry) => {
    const path = resolve(directory, entry.name);
    return entry.isDirectory() ? productionProviderFiles(path) : entry.isFile() && entry.name.endsWith(".ts") ? [path] : [];
  }));
  return files.flat().toSorted();
}

export function assertNoProviderModelLiterals(violations: readonly ProviderModelLiteralViolation[]): void {
  if (violations.length === 0) return;
  throw new Error(`Provider model literal policy failed:\n${violations.map((violation) => `${violation.file}:${violation.line} ${violation.rule} ${violation.detail}`).join("\n")}`);
}

if (import.meta.main) {
  const repoRoot = resolve(import.meta.dir, "..");
  assertNoProviderModelLiterals(await findProviderModelLiteralViolations(repoRoot));
  console.log("Provider model literal policy passed");
}
