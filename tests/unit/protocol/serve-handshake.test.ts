import { describe, expect, it } from "bun:test";
import { createServeStatusReader, decodeServeListeningVersions, decodeServeStartRefusal, decodeServeStatusLine, encodeServeStartFailure, encodeServeStatusRecord, readServeDiagnostic, type ServeStartRefusal, type ServeStatusRecord } from "../../../src/protocol/serve-handshake";
import { decodeServeStatusLine as decodeV009StatusLine } from "../../fixtures/serve-handshake-v0-0-9";

describe("serve handshake", () => {
  it.each<ServeStatusRecord>([
    { flywheel: "serve.startup.phase", label: "Opening project" },
    { flywheel: "serve.startup.phase", label: "Migrating", progress: { step: 2, total: 4 } },
    { flywheel: "serve.startup.failed", error: "failed" },
    { flywheel: "serve.startup.refused", refusal: { kind: "claim-settling", path: "/Users/me/.flywheel/serve/serve.start.lock.reclaim.9a77" } },
    { flywheel: "serve.startup.refused", refusal: { kind: "address-access", path: "/Users/me/.flywheel/serve/serve.sock", code: "EACCES" } },
    { flywheel: "serve.startup.refused", refusal: { kind: "port-in-use", port: 41000 } },
    { flywheel: "serve.listening", version: "1.2.3", protocolVersion: 7, pid: 42, lane: "installed" },
    { flywheel: "serve.already-listening", version: "1.2.3", protocolVersion: 7, pid: 42, lane: "dev" },
  ])("round trips $flywheel without publishing the socket or credential", (record) => {
    const line = encodeServeStatusRecord(record);
    expect(line).not.toContain("socket");
    expect(line).not.toContain("token");
    expect(line).not.toContain("credential");
    expect(decodeServeStatusLine(line)).toEqual(record);
  });

  it("ignores malformed and unrecognized lines", () => {
    expect(decodeServeStatusLine("not json")).toBeUndefined();
    expect(decodeServeStatusLine('{"flywheel":"serve.listening","version":"1"}')).toBeUndefined();
    expect(decodeServeStatusLine('{"flywheel":"other","token":"secret"}')).toBeUndefined();
    expect(decodeServeStatusLine('{"flywheel":"serve.listening","version":"1","protocolVersion":1,"pid":1}')).toBeUndefined();
    expect(decodeServeStatusLine('{"flywheel":"serve.listening","version":"1","protocolVersion":1,"pid":1,"lane":"other"}')).toBeUndefined();
  });

  const REFUSALS: ServeStartRefusal[] = [
    { kind: "address-access", path: "/Users/me/.flywheel/serve/serve.sock", code: "EACCES" },
    { kind: "port-in-use", port: 41000 },
    { kind: "state-from-newer-release", stateEpoch: 99, readableEpoch: 2 },
  ];
  const lines = (text: string) => text.split("\n").filter((line) => line.length > 0);

  it.each<ServeStartRefusal>(REFUSALS)("reads a refused start's failure with the $kind refusal the record before it named", (refusal) => {
    const read = createServeStatusReader();
    expect(lines(encodeServeStartFailure("start refused", refusal)).map(read)).toEqual([undefined, { flywheel: "serve.startup.failed", error: "start refused", refusal }]);
  });

  it("decodes only the refusals it knows, in their exact shape", () => {
    expect(REFUSALS.map((refusal) => decodeServeStartRefusal(JSON.parse(JSON.stringify(refusal))))).toEqual(REFUSALS);
    expect(decodeServeStartRefusal({ kind: "port-in-use", port: "41000" })).toBeUndefined();
    expect(decodeServeStartRefusal({ kind: "port-in-use", port: 41000, path: "/x" })).toBeUndefined();
    expect(decodeServeStartRefusal({ kind: "claim-settling" })).toBeUndefined();
    expect(decodeServeStartRefusal({ kind: "later-kind", port: 41000 })).toBeUndefined();
    expect(decodeServeStartRefusal("port-in-use")).toBeUndefined();
  });

  // An earlier build writes the failure alone; its client shows the lane's reset.
  it("reads a failure in the shape earlier builds write with no refusal", () => {
    const read = createServeStatusReader();
    expect(read(encodeServeStatusRecord({ flywheel: "serve.startup.failed", error: "Failed to acquire lock" }))).toEqual({ flywheel: "serve.startup.failed", error: "Failed to acquire lock" });
  });

  // An older terminal starts this build's service during an update.
  it.each<ServeStartRefusal>(REFUSALS)("keeps a failure the $kind refusal explains readable by the reader release v0.0.9 shipped", (refusal) => {
    expect(lines(encodeServeStartFailure("start refused", refusal)).map(decodeV009StatusLine)).toEqual([undefined, { flywheel: "serve.startup.failed", error: "start refused" }]);
  });

  // Public release v0.0.10 prints this record. It predates `lane`, so the
  // strict decoder refuses it, and a client still has to learn which release
  // is serving to say why it cannot use it.
  const V0_0_10_LISTENING = '{"flywheel":"serve.listening","pid":4242,"version":"0.0.10","protocolVersion":4}';

  it("reads the version and protocol of a listening record the strict decoder refuses", () => {
    expect(decodeServeStatusLine(V0_0_10_LISTENING)).toBeUndefined();
    expect(decodeServeListeningVersions(V0_0_10_LISTENING)).toEqual({ version: "0.0.10", protocolVersion: 4 });
  });

  it("reads the versions of a current listening record", () => {
    const line = encodeServeStatusRecord({ flywheel: "serve.already-listening", version: "1.2.3", protocolVersion: 7, pid: 42, lane: "installed" });
    expect(decodeServeListeningVersions(line)).toEqual({ version: "1.2.3", protocolVersion: 7 });
  });

  it("reads versions only from listening records", () => {
    expect(decodeServeListeningVersions("not json")).toBeUndefined();
    expect(decodeServeListeningVersions('{"flywheel":"serve.startup.failed","error":"x","version":"1.0.0"}')).toBeUndefined();
    expect(decodeServeListeningVersions('{"flywheel":"serve.listening","protocolVersion":4}')).toBeUndefined();
    expect(decodeServeListeningVersions('{"flywheel":"serve.listening","version":"1.0.0"}')).toEqual({ version: "1.0.0", protocolVersion: undefined });
  });

  it("reads the level and the message of a structured record the serve command writes on stderr", () => {
    const record = (type: string, payload: { readonly service?: string; readonly message?: string; readonly code?: number } = { service: "process-supervisor", message: "launcher scope closing" }) => JSON.stringify({ ts: 1, type, payload });
    expect(readServeDiagnostic(record("log.debug"))).toEqual({ level: "debug", text: "launcher scope closing" });
    expect(readServeDiagnostic(record("log.info"))?.level).toBe("info");
    expect(readServeDiagnostic(record("log.warn"))?.level).toBe("warn");
    // An older release's refusal of `serve ensure` reads as its words, not its JSON.
    expect(readServeDiagnostic(record("log.error", { service: "default", message: "Unknown serve option: ensure" }))).toEqual({ level: "error", text: "Unknown serve option: ensure" });
    // A diagnostic record that is not a log call carries no level of its own,
    // and one with no message keeps its whole line.
    const exit = record("process.exit", { code: 0 });
    expect(readServeDiagnostic(exit)).toEqual({ level: "debug", text: exit });
  });

  it("reads nothing from a line that is not a structured record", () => {
    expect(readServeDiagnostic("flywheel: failed to start: Unknown serve option: ensure")).toBeUndefined();
    expect(readServeDiagnostic('"log.info"')).toBeUndefined();
    expect(readServeDiagnostic('{"message":"no type"}')).toBeUndefined();
    expect(readServeDiagnostic(encodeServeStatusRecord({ flywheel: "serve.startup.failed", error: "x" }))).toBeUndefined();
  });
});
