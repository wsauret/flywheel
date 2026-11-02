import { describe, expect, it } from "bun:test";
import { Redacted } from "effect";
import { encodeServeStatusRecord } from "../../../src/protocol/serve-handshake";
import {
  createAccountAttachReader,
  createAccountAttachResponseReader,
  createAccountModuleAnswerReader,
  encodeAccountAttach,
  encodeAccountAttachResponse,
  isClientIdentity,
  newAccountAttachCredential,
} from "../../../src/protocol/account-attach";

const encoder = new TextEncoder();
const identity = "a".repeat(64);
const bundle = { dir: "/opt/flywheel/webview/editor", identity };

describe("AccountAttach", () => {
  it("reports every split or coalesced startup phase and preserves trailing RPC bytes", () => {
    const phases = [{ label: "Preparing workspace state" }, { label: "Upgrading stored facts", progress: { step: 2, total: 3 } }];
    const wire = encoder.encode(
      encodeAccountAttachResponse({ kind: "starting" })
      + phases.map((phase) => encodeServeStatusRecord({ flywheel: "serve.startup.phase", ...phase })).join("")
      + encodeAccountAttachResponse({ kind: "ready" })
    );
    for (const split of [0, 73, wire.length - 4]) {
      const reported: unknown[] = [];
      const reader = createAccountAttachResponseReader((phase) => reported.push(phase));
      if (split > 0) expect(["pending", "starting"]).toContain(reader.push(wire.subarray(0, split)).kind);
      const rest = new Uint8Array(wire.length - split + 3);
      rest.set(wire.subarray(split));
      rest.set([9, 8, 7], wire.length - split);
      expect(reader.push(rest)).toEqual({ kind: "ready", remainder: Uint8Array.of(9, 8, 7) });
      expect(reported).toEqual(phases);
    }
    expect(createAccountAttachResponseReader().push(wire)).toEqual({ kind: "ready", remainder: new Uint8Array(0) });
    const reader = createAccountAttachResponseReader();
    expect(reader.push(encoder.encode('{"flywheel":"serve.startup.phase","label":"bad","progress":{"step":4,"total":3}}\n')).kind).toBe("failed");
  });
  it("mints independent CSPRNG credentials", () => {
    const first = newAccountAttachCredential();
    const second = newAccountAttachCredential();
    expect(first).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(second).not.toBe(first);
  });

  it("accepts a split bounded JSON line and preserves every byte after its delimiter", () => {
    const credential = newAccountAttachCredential();
    const canonicalized: string[] = [];
    const reader = createAccountAttachReader({
      credential: Redacted.make(credential),
      canonicalizeProjectRoot: (root) => {
        canonicalized.push(root);
        return `/canonical${root}`;
      },
    });
    const frame = encoder.encode(encodeAccountAttach({ intent: "runtime", projectRoot: "/project", credential }));
    expect(reader.push(frame.subarray(0, 7))).toEqual({ kind: "pending" });
    const payload = Uint8Array.of(0, 255, 10, 4);
    const joined = new Uint8Array(frame.length - 7 + payload.length);
    joined.set(frame.subarray(7));
    joined.set(payload, frame.length - 7);
    const result = reader.push(joined);
    expect(result).toEqual({
      kind: "accepted",
      intent: "runtime",
      projectRoot: "/canonical/project",
      remainder: payload,
    });
    expect(canonicalized).toEqual(["/project"]);
  });

  it("rejects the credential before canonicalizing the project root", () => {
    let pathWork = 0;
    const reader = createAccountAttachReader({
      credential: Redacted.make(newAccountAttachCredential()),
      canonicalizeProjectRoot: (root) => {
        pathWork += 1;
        return root;
      },
    });
    const result = reader.push(encoder.encode(encodeAccountAttach({
      intent: "runtime",
      projectRoot: "/must-not-be-touched",
      credential: newAccountAttachCredential(),
    })));
    expect(result).toEqual({ kind: "rejected" });
    expect(pathWork).toBe(0);
  });

  it("authenticates a project-root-less cutover or restart without canonicalizing a path", () => {
    const credential = newAccountAttachCredential();
    let pathWork = 0;
    const canonicalizeProjectRoot = (root: string): string => {
      pathWork += 1;
      return root;
    };
    for (const intent of ["cutover", "restart"] as const) {
      const reader = createAccountAttachReader({ credential: Redacted.make(credential), canonicalizeProjectRoot });

      expect(reader.push(encoder.encode(encodeAccountAttach({
        intent,
        credential,
      })))).toEqual({ kind: "accepted", intent, remainder: new Uint8Array() });
    }
    expect(pathWork).toBe(0);
  });

  it("authenticates a project-root-less client attach and names its host", () => {
    const credential = newAccountAttachCredential();
    let pathWork = 0;
    const reader = createAccountAttachReader({
      credential: Redacted.make(credential),
      canonicalizeProjectRoot: (root) => {
        pathWork += 1;
        return root;
      },
    });

    expect(reader.push(encoder.encode(encodeAccountAttach({
      intent: "client",
      host: "editor",
      credential,
    })))).toEqual({ kind: "accepted", intent: "client", host: "editor", remainder: new Uint8Array() });
    expect(pathWork).toBe(0);
  });

  it("recognizes a client identity as sixty-four lowercase hex digits", () => {
    expect(isClientIdentity(identity)).toBe(true);
    expect(isClientIdentity(identity.toUpperCase())).toBe(false);
    expect(isClientIdentity(identity.slice(1))).toBe(false);
  });

  it("requires an explicit supported intent", () => {
    const credential = newAccountAttachCredential();
    const reader = createAccountAttachReader({
      credential: Redacted.make(credential),
      canonicalizeProjectRoot: (root) => root,
    });
    expect(reader.push(encoder.encode(`${JSON.stringify({
      flywheel: "account.attach",
      projectRoot: "/project",
      credential,
    })}\n`))).toEqual({ kind: "rejected" });
  });

  it("rejects an over-limit line before a delimiter", () => {
    const reader = createAccountAttachReader({
      credential: Redacted.make(newAccountAttachCredential()),
      canonicalizeProjectRoot: (root) => root,
    });
    expect(reader.push(new Uint8Array(4097).fill(32))).toEqual({ kind: "rejected" });
  });

  it("reads starting and ready responses while preserving coalesced protocol bytes", () => {
    const reader = createAccountAttachResponseReader();
    const starting = encoder.encode(encodeAccountAttachResponse({ kind: "starting" }));
    const ready = encoder.encode(encodeAccountAttachResponse({ kind: "ready" }));
    const protocol = Uint8Array.of(0, 255, 10, 4);
    const combined = new Uint8Array(ready.length + protocol.length);
    combined.set(ready);
    combined.set(protocol, ready.length);

    expect(reader.push(starting)).toEqual({ kind: "starting" });
    expect(reader.push(combined)).toEqual({ kind: "ready", remainder: protocol });
  });

  it("reads an explicit failed response", () => {
    const reader = createAccountAttachResponseReader();
    expect(reader.push(encoder.encode(encodeAccountAttachResponse({
      kind: "failed",
      error: "project preparation failed",
    })))).toEqual({ kind: "failed", error: "project preparation failed" });
  });

  it("reads the client bundle response and refuses a malformed identity", () => {
    expect(createAccountAttachResponseReader().push(encoder.encode(
      encodeAccountAttachResponse({ kind: "client", bundle }),
    ))).toEqual({ kind: "client", bundle });
    expect(createAccountAttachResponseReader().push(encoder.encode(
      `${JSON.stringify({ flywheel: "account.client", dir: "/opt", identity: "short" })}\n`,
    ))).toEqual({ kind: "failed", error: "Account attach response is malformed" });
  });

  it("reads explicit cutover outcomes", () => {
    expect(createAccountAttachResponseReader().push(encoder.encode(
      encodeAccountAttachResponse({ kind: "busy" }),
    ))).toEqual({ kind: "busy" });
    expect(createAccountAttachResponseReader().push(encoder.encode(
      encodeAccountAttachResponse({ kind: "retiring" }),
    ))).toEqual({ kind: "retiring" });
  });

  it("authenticates a project-root-less module attach and carries its request unread", () => {
    const credential = newAccountAttachCredential();
    let pathWork = 0;
    const reader = createAccountAttachReader({
      credential: Redacted.make(credential),
      canonicalizeProjectRoot: (root) => {
        pathWork += 1;
        return root;
      },
    });
    const request = { type: "remote.pair.open", relayUrl: "wss://relay.example.test" };

    expect(reader.push(encoder.encode(encodeAccountAttach({ intent: "module", module: "remote", request, credential }))))
      .toEqual({ kind: "accepted", intent: "module", module: "remote", request, remainder: new Uint8Array() });
    expect(pathWork).toBe(0);
    expect(createAccountAttachReader({ credential: Redacted.make(credential), canonicalizeProjectRoot: (root) => root })
      .push(encoder.encode(`${JSON.stringify({ flywheel: "account.attach", intent: "module", module: "remote", request: "pair", credential })}\n`)))
      .toEqual({ kind: "rejected" });
  });

  it("reads split and coalesced module answers through the end, and a failure as the last event", () => {
    const answers = encoder.encode([
      encodeAccountAttachResponse({ kind: "answer", payload: { type: "pairing" } }),
      encodeAccountAttachResponse({ kind: "answer", payload: { type: "paired", label: "Phone" } }),
      encodeAccountAttachResponse({ kind: "end" }),
    ].join(""));
    const reader = createAccountModuleAnswerReader();

    expect(reader.push(answers.subarray(0, 10))).toEqual([]);
    expect(reader.push(answers.subarray(10))).toEqual([
      { kind: "answer", payload: { type: "pairing" } },
      { kind: "answer", payload: { type: "paired", label: "Phone" } },
      { kind: "end" },
    ]);
    expect(createAccountModuleAnswerReader().push(encoder.encode(encodeAccountAttachResponse({ kind: "failed", error: "the remote module is off" }))))
      .toEqual([{ kind: "failed", error: "the remote module is off" }]);
    expect(createAccountModuleAnswerReader().push(encoder.encode(encodeAccountAttachResponse({ kind: "ready" }))))
      .toEqual([{ kind: "failed", error: "Account module answer is malformed" }]);
  });
});
