import * as fs from "node:fs";
import { SubprocessHandoffSchema } from "../../../infra/handoff-schemas.js";

const NDJSON_RESULT_REGEX = /"type"\s*:\s*"result"[^}]*"subtype"\s*:\s*"success"|"type"\s*:\s*"completion"/;

const FALLBACK_CHECK_SIZE = 32_768;

export class CompletionDetector {
  private _hasSeenCompletion = false;

  get hasSeenCompletion(): boolean {
    return this._hasSeenCompletion;
  }

  check(chunk: string): boolean {
    if (this._hasSeenCompletion) return true;
    if (NDJSON_RESULT_REGEX.test(chunk)) {
      this._hasSeenCompletion = true;
    }
    return this._hasSeenCompletion;
  }

  checkFallback(fullOutput: string): boolean {
    if (this._hasSeenCompletion) return true;
    const tail = fullOutput.slice(-FALLBACK_CHECK_SIZE);
    if (NDJSON_RESULT_REGEX.test(tail)) {
      this._hasSeenCompletion = true;
    }
    return this._hasSeenCompletion;
  }

  checkHandoffFile(handoffPath: string): boolean {
    if (!handoffPath) return false;
    try {
      if (!fs.existsSync(handoffPath)) {
        return false;
      }

      const text = fs.readFileSync(handoffPath, "utf-8");
      if (text.trim().length === 0) {
        return false;
      }

      const parsed = JSON.parse(text) as unknown;
      return SubprocessHandoffSchema.safeParse(parsed).success;
    } catch {
      return false;
    }
  }

  reset(): void {
    this._hasSeenCompletion = false;
  }
}
