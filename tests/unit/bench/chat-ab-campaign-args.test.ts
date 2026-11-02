import { describe, expect, it } from "bun:test";
import { parseArgs, parsePairedArgs } from "../../../bench/chat-ab/campaign-args.js";

describe("chat A/B campaign options", () => {
  it("selects challenge mode for single and paired campaigns without changing the default", () => {
    for (const parse of [parseArgs, parsePairedArgs]) {
      expect(parse(["--model", "model", "--challenge"]).challenge).toBe(true);
      expect(parse(["--model", "model"]).challenge).toBeUndefined();
    }
  });

  it("has no campaign spend cap or in-flight reserve", () => {
    expect(() => parseArgs(["--auth-profile", "Personal", "--cap-usd", "40"])).toThrow("Unknown option: --cap-usd");
    expect(() => parseArgs(["--auth-profile", "Personal", "--reserve-usd", "12"])).toThrow("Unknown option: --reserve-usd");
  });

  it("takes source treatments for single and paired Chat campaigns", () => {
    expect(parseArgs(["--source", "HEAD", "--model", "model", "--effort", "high", "--auth-profile", "Personal"]).chat).toMatchObject({ source: "HEAD", model: "model", effort: "high" });
    expect(parsePairedArgs(["--model", "model", "--a-source", "HEAD", "--b-source", "candidate", "--a-arm", "baseline", "--b-arm", "delegate"]).chat).toMatchObject({ model: "model", aSource: "HEAD", bSource: "candidate", aArm: "baseline", bArm: "delegate" });
    expect(parsePairedArgs(["--model", "model", "--arm", "delegate"]).chat).toMatchObject({ model: "model", arm: "delegate" });
  });

  it("selects Claude Code explicitly and refuses Flywheel skill arms", () => {
    expect(parseArgs(["--model", "claude-sonnet-5-5", "--subject", "claude-code"]).chat).toMatchObject({ subject: "claude-code" });
    expect(parsePairedArgs(["--model", "claude-sonnet-5-5", "--a-source", "HEAD", "--b-subject", "claude-code"]).chat).toMatchObject({ bSubject: "claude-code" });
    expect(parsePairedArgs(["--model", "claude-sonnet-5-5", "--subject", "claude-code", "--arm", "delegate", "--a-subject", "flywheel", "--b-arm", "baseline"]).chat).toMatchObject({ subject: "claude-code", arm: "delegate", aSubject: "flywheel", bArm: "baseline" });
    expect(() => parseArgs(["--model", "model", "--subject", "claude-code", "--arm", "delegate"])).toThrow("baseline");
    expect(() => parsePairedArgs(["--model", "model", "--b-subject", "claude-code", "--b-arm", "delegate"])).toThrow("baseline");
    expect(() => parseArgs(["--model", "model", "--subject", "unknown"])).toThrow("subject");
  });
});
