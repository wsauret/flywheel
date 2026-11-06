import type { CapturedTool } from "./claude-engine-session.js";
import { McpConnectorError } from "./errors.js";

/** Why a capture answered no tools. Each kind refuses the whole capture: a partial answer is never returned. */
export type ConnectorToolsRefusal = "unmasked-credential" | "truncated" | "unreadable" | "no-definitions";

/** A refused capture. The message is the reason a person sees; it never holds captured content. */
export class ConnectorToolsRefusedError extends McpConnectorError {
  constructor(readonly kind: ConnectorToolsRefusal) {
    super("tools_unreadable", "Flywheel cannot read this connector's tools");
    this.name = "ConnectorToolsRefusedError";
  }
}

/** Reads one connector's tool definitions from the discovery engine's Anthropic SDK debug log on stderr: the
 *  `sending request` block of the token count that the engine sends for `get_context_usage`. */
export interface DebugToolCapture {
  /** Takes every stderr line of the discovery engine. A line that arrives while no capture runs is dropped unread. */
  onLine(line: string): void;
  /** Runs `request` (the caller's `get_context_usage` call, whose answer is not read) and answers the tools named `mcp__<engineServer>__*` from
   *  the first closed count block that holds one. `engineServer` is the engine's sanitized server key, such as
   *  `claude_ai_Claude_Docs`. The block can close before or after `request` settles, because stdout control answers
   *  and stderr lines are not ordered; `timeoutMs` bounds the whole capture, `request` included. The tools answer
   *  only once both happened, so every line until `request` settled, the response lines of the count too, passed the
   *  credential check.
   *
   *  Rejects with `ConnectorToolsRefusedError`: `unmasked-credential` when any line seen during the capture holds a
   *  credential header value other than the SDK mask `***` or a token shape; `truncated` when a count block holds an
   *  inspection cut; `unreadable` when a count block does not convert to JSON or a tool in it is malformed;
   *  `no-definitions` when no count block with the server's tools closed in time. A rejection of `request` passes
   *  through. Every outcome drops the captured lines. Calls run one at a time: a second call waits for the first. */
  capture(engineServer: string, request: () => Promise<void>, timeoutMs?: number): Promise<readonly CapturedTool[]>;
}

const DEFAULT_TIMEOUT_MS = 10_000;
const BLOCK_START = /^\[Anthropic SDK DEBUG\] \[log_\w+\] sending request \{$/u;
const COUNT_PATH = /^ {4}path: "\/v1\/messages\/count_tokens[?"]/u;
/** A credential header key, bare or quoted at the start of a line (inspect style) or quoted anywhere (JSON style).
 *  The quote before a key must not be escaped, so a key that a string value only mentions does not match. */
const CREDENTIAL_KEY = /(?:^\s*"?|(?<!\\)")(?:proxy-authorization|authorization|x-api-key|api-key|set-cookie|cookie)"?\s*:\s*/giu;
const MASKED_VALUE = "\"***\"";
const UNMASKED_TOKEN = /sk-ant-|Bearer (?!\*\*\*(?:$|[\s"',]))/u;

interface Run {
  readonly prefix: string;
  readonly outcome: PromiseWithResolvers<readonly CapturedTool[]>;
  /** The open `sending request` block; its lines are the only lines kept. */
  block: string[] | undefined;
  /** The server's tools once a count block held them, which answer when `request` has settled too. */
  tools: readonly CapturedTool[] | undefined;
  requestSettled: boolean;
  finished: boolean;
}

export function createDebugToolCapture(): DebugToolCapture {
  let run: Run | undefined;
  let queue: Promise<unknown> = Promise.resolve();

  const finish = (current: Run, outcome: { readonly tools: readonly CapturedTool[] } | { readonly refusal: ConnectorToolsRefusal }) => {
    current.finished = true;
    current.block = undefined;
    current.tools = undefined;
    if ("tools" in outcome) current.outcome.resolve(outcome.tools);
    else current.outcome.reject(new ConnectorToolsRefusedError(outcome.refusal));
  };

  const onLine = (line: string): void => {
    const current = run;
    if (current === undefined || current.finished) return;
    if (holdsCredential(line)) {
      finish(current, { refusal: "unmasked-credential" });
      return;
    }
    if (current.tools !== undefined) return;
    if (current.block === undefined) {
      if (BLOCK_START.test(line)) current.block = [line];
      return;
    }
    current.block.push(line);
    if (line !== "}") return;
    const block = current.block;
    current.block = undefined;
    if (!block.some((entry) => COUNT_PATH.test(entry))) return;
    const read = serverTools(block, current.prefix);
    if (typeof read === "string") finish(current, { refusal: read });
    else if (read.length > 0) {
      current.tools = read;
      if (current.requestSettled) finish(current, { tools: read });
    }
  };

  const runCapture = async (engineServer: string, request: () => Promise<void>, timeoutMs: number) => {
    const current: Run = { prefix: `mcp__${engineServer}__`, outcome: Promise.withResolvers(), block: undefined, tools: undefined, requestSettled: false, finished: false };
    run = current;
    const timer = setTimeout(() => { if (!current.finished) finish(current, { refusal: "no-definitions" }); }, timeoutMs);
    const requested = request().then(() => {
      current.requestSettled = true;
      if (current.tools !== undefined && !current.finished) finish(current, { tools: current.tools });
    });
    try {
      const [, tools] = await Promise.all([requested, current.outcome.promise]);
      return tools;
    } finally {
      clearTimeout(timer);
      current.finished = true;
      current.block = undefined;
      run = undefined;
    }
  };

  return {
    onLine,
    capture(engineServer, request, timeoutMs = DEFAULT_TIMEOUT_MS) {
      const next = queue.then(() => runCapture(engineServer, request, timeoutMs));
      queue = next.catch(() => undefined);
      return next;
    },
  };
}

function holdsCredential(line: string): boolean {
  if (UNMASKED_TOKEN.test(line)) return true;
  for (const match of line.matchAll(CREDENTIAL_KEY)) {
    if (!line.startsWith(MASKED_VALUE, match.index + match[0].length)) return true;
  }
  return false;
}

/** The tools of one closed count block whose names start with `prefix`, or the refusal the block earns. Every tool
 *  of the block must be well formed, also one of another server, because a malformed one means the format is not the
 *  one this reader knows. */
function serverTools(block: readonly string[], prefix: string): readonly CapturedTool[] | ConnectorToolsRefusal {
  let request: unknown;
  try {
    request = JSON.parse(inspectionJson(["{", ...block.slice(1)].join("\n")));
  } catch (error) {
    return error instanceof ConnectorToolsRefusedError ? error.kind : "unreadable";
  }
  const options = isRecord(request) ? request["options"] : undefined;
  const body = isRecord(options) ? options["body"] : undefined;
  const tools = isRecord(body) ? body["tools"] : undefined;
  if (!Array.isArray(tools)) return "unreadable";
  const answer: CapturedTool[] = [];
  for (const tool of tools) {
    if (!isRecord(tool) || typeof tool["name"] !== "string" || !isRecord(tool["input_schema"])) return "unreadable";
    const description = tool["description"];
    if (description !== undefined && typeof description !== "string") return "unreadable";
    if (tool["name"].startsWith(prefix)) answer.push({ name: tool["name"], ...(description === undefined ? {} : { description }), input_schema: tool["input_schema"] });
  }
  return answer;
}

/** One token of Bun's console inspection of plain JSON data. A string keeps its escapes byte for byte, so
 *  `JSON.parse` decodes it; Bun writes value escapes in JSON form (`\n`, `\u000b`, `\ud800`). An inspection cut comes
 *  before every other alternative, because `[Object ...]` also starts with a bracket. A bare key is an identifier
 *  directly before its colon, which comes before the literals so that a key such as `true:` stays a key. */
const INSPECTION_TOKEN = /(?<space>\s+)|(?<cut>\.\.\. \d+ more items?|\[(?:Object|Array) \.\.\.\]|\[Circular\b|<ref \*\d+>)|(?<key>[A-Za-z_$][\w$]*)(?=:)|(?<close>[}\]])|(?<json>"(?:[^"\\\n]|\\.)*"|[{[,:]|-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?(?![\w$.])|(?:true|false|null)(?![\w$]))/uy;

/** The JSON text of Bun's console inspection of plain JSON data. Bare keys become quoted keys and trailing commas
 *  drop; a token that JSON does not hold (`undefined`, `NaN`, a class tag) throws `unreadable`, and an inspection
 *  cut throws `truncated`. What the tokens cannot show, such as an unescaped control character that Bun leaves in a
 *  quoted key, fails in `JSON.parse`. */
function inspectionJson(text: string): string {
  let json = "";
  INSPECTION_TOKEN.lastIndex = 0;
  while (INSPECTION_TOKEN.lastIndex < text.length) {
    const groups = INSPECTION_TOKEN.exec(text)?.groups;
    if (groups === undefined) throw new ConnectorToolsRefusedError("unreadable");
    if (groups["cut"] !== undefined) throw new ConnectorToolsRefusedError("truncated");
    if (groups["key"] !== undefined) json += `"${groups["key"]}"`;
    else if (groups["close"] !== undefined) json = `${json.endsWith(",") ? json.slice(0, -1) : json}${groups["close"]}`;
    else if (groups["json"] !== undefined) json += groups["json"];
  }
  return json;
}

function isRecord(value: unknown): value is { readonly [key: string]: unknown } {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
