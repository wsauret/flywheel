interface CompressionResult {
  output: string;
  compressed: boolean;
  originalLines: number;
  compressedLines: number;
}

const TEST_RUNNER_PATTERNS: ReadonlyArray<RegExp> = [
  /^bun\s+(run\s+)?test/,
  /^(npx\s+)?jest/,
  /^(npx\s+)?vitest/,
  /^pytest/,
  /^(npx\s+)?mocha/,
];

const FAILURE_PATTERNS: ReadonlyArray<RegExp> = [
  /fail/i,
  /error/i,
  /expected/i,
  /received/i,
  /^\s+at\s/,
  /[✗✘×]|FAIL/,
  /\d+\s*(pass|fail|skip)|tests?:/i,
];

const ERROR_WARNING_PATTERN = /error|warning|warn/i;

const CONTEXT_LINES_BEFORE = 5;
const LAST_LINES_KEEP = 3;
const GENERIC_HEAD = 30;
const GENERIC_TAIL = 40;
const GENERIC_THRESHOLD = 200;

function isTestRunner(command: string): boolean {
  return TEST_RUNNER_PATTERNS.some(p => p.test(command));
}

function matchesFailurePattern(line: string): boolean {
  return FAILURE_PATTERNS.some(p => p.test(line));
}

function buildNotice(originalLines: number, compressedLines: number): string {
  const percent = Math.round((1 - compressedLines / originalLines) * 100);
  return `[Output compressed: ${originalLines} lines -> ${compressedLines} lines (${percent}% reduction)]`;
}

function compressTestOutput(lines: string[], originalLines: number): CompressionResult {
  const failureIndices = new Set<number>();
  for (let i = 0; i < lines.length; i++) {
    if (matchesFailurePattern(lines[i]!)) {
      failureIndices.add(i);
    }
  }

  if (failureIndices.size === 0) {
    return { output: lines.join("\n"), compressed: false, originalLines, compressedLines: originalLines };
  }

  const keepIndices = new Set<number>();

  for (const idx of failureIndices) {
    keepIndices.add(idx);
    const contextStart = Math.max(0, idx - CONTEXT_LINES_BEFORE);
    for (let j = contextStart; j < idx; j++) {
      keepIndices.add(j);
    }
  }

  for (let i = Math.max(0, lines.length - LAST_LINES_KEEP); i < lines.length; i++) {
    keepIndices.add(i);
  }

  if (keepIndices.size >= originalLines) {
    return { output: lines.join("\n"), compressed: false, originalLines, compressedLines: originalLines };
  }

  const kept = lines.filter((_, i) => keepIndices.has(i));
  const compressedLines = kept.length;
  const notice = buildNotice(originalLines, compressedLines);
  return { output: `${notice}\n\n${kept.join("\n")}`, compressed: true, originalLines, compressedLines };
}

function compressGenericOutput(lines: string[], originalLines: number): CompressionResult {
  const headEnd = GENERIC_HEAD;
  const tailStart = lines.length - GENERIC_TAIL;

  const headSet = new Set<number>();
  for (let i = 0; i < headEnd; i++) headSet.add(i);

  const tailSet = new Set<number>();
  for (let i = tailStart; i < lines.length; i++) tailSet.add(i);

  const errorLines: string[] = [];
  for (let i = headEnd; i < tailStart; i++) {
    if (ERROR_WARNING_PATTERN.test(lines[i]!)) {
      errorLines.push(lines[i]!);
    }
  }

  const omitted = tailStart - headEnd - errorLines.length;
  const head = lines.slice(0, headEnd);
  const tail = lines.slice(tailStart);

  const parts: string[] = [...head];
  if (errorLines.length > 0) {
    parts.push(`\n[... ${omitted} lines omitted ...]\n`);
    parts.push(...errorLines);
    parts.push(`\n[... continuing to last ${GENERIC_TAIL} lines ...]\n`);
  } else {
    parts.push(`\n[... ${omitted + errorLines.length} lines omitted ...]\n`);
  }
  parts.push(...tail);

  const joined = parts.join("\n");
  const compressedLines = joined.split("\n").length;
  const notice = buildNotice(originalLines, compressedLines);
  return { output: `${notice}\n\n${joined}`, compressed: true, originalLines, compressedLines };
}

export function compressBashOutput(command: string, stdout: string): CompressionResult {
  if (process.env.FLYWHEEL_RAW_OUTPUT === "1") {
    const lines = stdout.split("\n");
    return { output: stdout, compressed: false, originalLines: lines.length, compressedLines: lines.length };
  }

  const lines = stdout.split("\n");
  const originalLines = lines.length;

  if (isTestRunner(command)) {
    return compressTestOutput(lines, originalLines);
  }

  if (originalLines > GENERIC_THRESHOLD) {
    return compressGenericOutput(lines, originalLines);
  }

  return { output: stdout, compressed: false, originalLines, compressedLines: originalLines };
}
