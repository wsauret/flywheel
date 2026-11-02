import { describe, expect, it } from "bun:test";
import { Redacted } from "effect";
import { join } from "node:path";
import { createAccountSocketRouter } from "../../../../src/orchestration/app-service/account-socket-router";
import { createAccountAttachResponseReader, encodeAccountAttach, newAccountAttachCredential } from "../../../../src/protocol/account-attach";
import { ServeStartupFailure } from "../../../../src/protocol/serve-handshake";

const encoder = new TextEncoder();
const remainBusy = async (): Promise<"busy"> => "busy";
// No module service serves these routers; a test that sends a module request supplies its own.
const noModules = async (): Promise<void> => { throw new Error("no module service in this test"); };
const identity = "b".repeat(64);
const clientRoot = "/opt/flywheel/webview";
const client = async () => ({ kind: "resolved", root: clientRoot, identity } as const);

describe("account socket router", () => {
  it("answers an authenticated cutover or restart through its own answer, before project canonicalization or opening", async () => {
    const credential = newAccountAttachCredential();
    const responses: string[] = [];
    const answered: string[] = [];
    let pathWork = 0;
    let projectOpens = 0;
    const answer = (intent: string, outcomes: Array<"busy" | "retiring">) => async (beforeRetire?: () => Promise<void>) => {
      answered.push(intent);
      const outcome = outcomes.shift() ?? "retiring";
      if (outcome === "retiring") await beforeRetire?.();
      return outcome;
    };
    const router = createAccountSocketRouter({
      credential: Redacted.make(credential),
      canonicalizeProjectRoot: (root) => {
        pathWork += 1;
        return root;
      },
      send: (_connection, bytes) => { responses.push(new TextDecoder().decode(bytes)); },
      client,
      answerCutover: answer("cutover", ["busy", "retiring"]),
      answerRestart: answer("restart", ["busy", "retiring"]),
      moduleRequest: noModules,
      openProject: async () => {
        projectOpens += 1;
        return { receive: async () => {}, release() {} };
      },
    });

    for (const intent of ["cutover", "restart"] as const) {
      expect(await router.receive(`${intent}-busy`, encoder.encode(encodeAccountAttach({ intent, credential })))).toBe("accepted");
      expect(await router.receive(`${intent}-retiring`, encoder.encode(encodeAccountAttach({ intent, credential })))).toBe("accepted");
    }

    expect(pathWork).toBe(0);
    expect(projectOpens).toBe(0);
    expect(answered).toEqual(["cutover", "cutover", "restart", "restart"]);
    expect(responses).toEqual([
      '{"flywheel":"account.cutover.busy"}\n',
      '{"flywheel":"account.cutover.retiring"}\n',
      '{"flywheel":"account.cutover.busy"}\n',
      '{"flywheel":"account.cutover.retiring"}\n',
    ]);
  });

  it("waits for admission, preserves following bytes, and gives each socket its own binding", async () => {
    const credential = newAccountAttachCredential();
    const opened: string[] = [];
    const received: Array<{ socket: number; bytes: Uint8Array }> = [];
    const released: number[] = [];
    const responses: string[] = [];
    const router = createAccountSocketRouter({
      credential: Redacted.make(credential),
      answerCutover: remainBusy,
      answerRestart: remainBusy,
      moduleRequest: noModules,
      client,
      canonicalizeProjectRoot: (root) => `/real${root}`,
      send: async (_connection, bytes) => {
        await Promise.resolve();
        responses.push(new TextDecoder().decode(bytes));
      },
      openProject: async (root, intent, connection, onStartupStep) => {
        opened.push(`${intent}:${root}`);
        onStartupStep?.({ step: "stored-facts", pass: { label: "memory facts", step: 1, total: 2 } });
        expect(String(connection)).toBe(opened.length === 1 ? "first" : "second");
        const socket = opened.length;
        return {
          receive: async (bytes) => {
            received.push({ socket, bytes });
          },
          release: () => { released.push(socket); },
        };
      },
    });

    const attach = encoder.encode(encodeAccountAttach({ intent: "runtime", projectRoot: "/one", credential }));
    const protocol = Uint8Array.of(9, 8, 7);
    await router.receive("first", attach.subarray(0, 5));
    expect(opened).toEqual([]);
    const combined = new Uint8Array(attach.length - 5 + protocol.length);
    combined.set(attach.subarray(5));
    combined.set(protocol, attach.length - 5);
    await router.receive("first", combined);
    await router.receive("first", Uint8Array.of(6));

    const duplicate = encoder.encode(encodeAccountAttach({ intent: "runtime", projectRoot: "/one", credential }));
    await router.receive("second", duplicate);
    await router.receive("second", Uint8Array.of(5));
    expect(opened).toEqual(["runtime:/real/one", "runtime:/real/one"]);
    expect(received).toEqual([
      { socket: 1, bytes: protocol },
      { socket: 1, bytes: Uint8Array.of(6) },
      { socket: 2, bytes: Uint8Array.of(5) },
    ]);
    expect(responses).toEqual([
      '{"flywheel":"account.attach.starting"}\n',
      '{"flywheel":"serve.startup.phase","label":"Upgrading stored facts, pass 1 of 2: memory facts","progress":{"step":7,"total":13}}\n',
      '{"flywheel":"account.attach.ready"}\n',
      '{"flywheel":"account.attach.starting"}\n',
      '{"flywheel":"serve.startup.phase","label":"Upgrading stored facts, pass 1 of 2: memory facts","progress":{"step":7,"total":13}}\n',
      '{"flywheel":"account.attach.ready"}\n',
    ]);
    router.close("first");
    router.close("second");
    expect(released).toEqual([1, 2]);
  });

  it("keeps different project handlers isolated", async () => {
    const credential = newAccountAttachCredential();
    const routed = new Map<string, number[]>();
    const router = createAccountSocketRouter({
      credential: Redacted.make(credential),
      answerCutover: remainBusy,
      answerRestart: remainBusy,
      moduleRequest: noModules,
      client,
      canonicalizeProjectRoot: (root) => root,
      openProject: async (root) => ({
        receive: async (bytes) => {
          routed.set(root, [...(routed.get(root) ?? []), ...bytes]);
        },
        release: () => {},
      }),
    });
    await router.receive("a", encoder.encode(encodeAccountAttach({ intent: "runtime", projectRoot: "/a", credential })));
    await router.receive("b", encoder.encode(encodeAccountAttach({ intent: "runtime", projectRoot: "/b", credential })));
    await router.receive("a", Uint8Array.of(1));
    await router.receive("b", Uint8Array.of(2));
    expect(routed).toEqual(new Map([["/a", [1]], ["/b", [2]]]));
  });

  it("closes rejected connections without opening a project", async () => {
    let opens = 0;
    const router = createAccountSocketRouter({
      credential: Redacted.make(newAccountAttachCredential()),
      answerCutover: remainBusy,
      answerRestart: remainBusy,
      moduleRequest: noModules,
      client,
      canonicalizeProjectRoot: (root) => root,
      openProject: async () => {
        opens += 1;
        return { receive: async () => {}, release: () => {} };
      },
    });
    const accepted = await router.receive("bad", encoder.encode(encodeAccountAttach({
      intent: "runtime",
      projectRoot: "/a",
      credential: newAccountAttachCredential(),
    })));
    expect(accepted).toBe("rejected");
    expect(opens).toBe(0);
  });

  it("releases a binding acquired after close exactly once", async () => {
    const credential = newAccountAttachCredential();
    const opened = Promise.withResolvers<{
      receive: (bytes: Uint8Array) => Promise<void>;
      release: () => void;
    }>();
    let releases = 0;
    const router = createAccountSocketRouter({
      credential: Redacted.make(credential),
      answerCutover: remainBusy,
      answerRestart: remainBusy,
      moduleRequest: noModules,
      client,
      canonicalizeProjectRoot: (root) => root,
      send: () => {},
      openProject: () => opened.promise,
    });
    const admission = router.receive("closing", encoder.encode(encodeAccountAttach({
      intent: "runtime",
      projectRoot: "/project",
      credential,
    })));

    await Promise.resolve();
    router.close("closing");
    opened.resolve({ receive: async () => {}, release: () => { releases += 1; } });

    expect(await admission).toBe("rejected");
    router.close("closing");
    expect(releases).toBe(1);
  });

  it("queues later runtime bytes while the starting response is in flight", async () => {
    const credential = newAccountAttachCredential();
    const sent = Promise.withResolvers<void>();
    const received: Uint8Array[] = [];
    const router = createAccountSocketRouter({
      credential: Redacted.make(credential),
      answerCutover: remainBusy,
      answerRestart: remainBusy,
      moduleRequest: noModules,
      client,
      canonicalizeProjectRoot: (root) => root,
      send: () => sent.promise,
      openProject: async () => ({
        receive: async (bytes) => { received.push(bytes); },
        release: () => {},
      }),
    });
    const admission = router.receive("opening", encoder.encode(encodeAccountAttach({
      intent: "runtime",
      projectRoot: "/project",
      credential,
    })));
    expect(await router.receive("opening", Uint8Array.of(4, 5))).toBe("pending");
    sent.resolve();
    await admission;

    expect(received).toEqual([Uint8Array.of(4, 5)]);
  });

  it("reports an authenticated project-open failure before rejecting", async () => {
    const credential = newAccountAttachCredential();
    const responses: string[] = [];
    const router = createAccountSocketRouter({
      credential: Redacted.make(credential),
      answerCutover: remainBusy,
      answerRestart: remainBusy,
      moduleRequest: noModules,
      client,
      canonicalizeProjectRoot: (root) => root,
      send: (_connection, bytes) => { responses.push(new TextDecoder().decode(bytes)); },
      openProject: async () => { throw new Error("preparation failed"); },
    });

    expect(await router.receive("failed", encoder.encode(encodeAccountAttach({
      intent: "runtime",
      projectRoot: "/project",
      credential,
    })))).toBe("rejected");
    expect(responses).toEqual([
      '{"flywheel":"account.attach.starting"}\n',
      '{"flywheel":"account.attach.failed","error":"preparation failed"}\n',
    ]);
  });

  it("names the refusal a failed project open carries, however deep its owners wrapped it", async () => {
    const credential = newAccountAttachCredential();
    const responses: string[] = [];
    const refusal = { kind: "state-from-newer-release", stateEpoch: 99, readableEpoch: 2 } as const;
    const router = createAccountSocketRouter({
      credential: Redacted.make(credential),
      answerCutover: remainBusy,
      answerRestart: remainBusy,
      moduleRequest: noModules,
      client,
      canonicalizeProjectRoot: (root) => root,
      send: (_connection, bytes) => { responses.push(new TextDecoder().decode(bytes)); },
      openProject: async () => { throw new Error("project state is unavailable", { cause: new ServeStartupFailure("newer state", refusal) }); },
    });

    expect(await router.receive("failed", encoder.encode(encodeAccountAttach({ intent: "runtime", projectRoot: "/project", credential })))).toBe("rejected");
    const failure = createAccountAttachResponseReader().push(encoder.encode(responses[1]));
    expect(failure).toEqual({ kind: "failed", error: "project state is unavailable: newer state", refusal });
  });

  it("passes browser demand without routing protocol bytes", async () => {
    const credential = newAccountAttachCredential();
    const demands: string[] = [];
    const received: Uint8Array[] = [];
    const router = createAccountSocketRouter({
      credential: Redacted.make(credential),
      answerCutover: remainBusy,
      answerRestart: remainBusy,
      moduleRequest: noModules,
      client,
      canonicalizeProjectRoot: (root) => `/real${root}`,
      openProject: async (root, intent) => {
        demands.push(`${intent}:${root}`);
        return { receive: async (bytes) => { received.push(bytes); }, release: () => {} };
      },
    });

    const result = await router.receive("browser", encoder.encode(encodeAccountAttach({
      intent: "browser",
      projectRoot: "/project",
      credential,
    })));
    await router.receive("browser", Uint8Array.of(1, 2, 3));

    expect(result).toBe("accepted");
    expect(demands).toEqual(["browser:/real/project"]);
    expect(received).toEqual([]);
  });

  it("answers a client attach with the host's directory under the client root and opens no project", async () => {
    const credential = newAccountAttachCredential();
    const responses: string[] = [];
    let opens = 0;
    const router = createAccountSocketRouter({
      credential: Redacted.make(credential),
      answerCutover: remainBusy,
      answerRestart: remainBusy,
      moduleRequest: noModules,
      client,
      canonicalizeProjectRoot: (root) => root,
      send: (_connection, bytes) => { responses.push(new TextDecoder().decode(bytes)); },
      openProject: async () => {
        opens += 1;
        return { receive: async () => {}, release: () => {} };
      },
    });

    expect(await router.receive("client", encoder.encode(encodeAccountAttach({ intent: "client", host: "editor", credential })))).toBe("accepted");
    expect(opens).toBe(0);
    expect(responses).toEqual([`${JSON.stringify({ flywheel: "account.client", dir: join(clientRoot, "editor"), identity })}\n`]);
  });

  it("admits every accepted attach before working on its request, and no partial or refused one", async () => {
    const credential = newAccountAttachCredential();
    const admitted: string[] = [];
    const build = Promise.withResolvers<void>();
    const opening = Promise.withResolvers<void>();
    const router = createAccountSocketRouter({
      credential: Redacted.make(credential),
      answerCutover: remainBusy,
      answerRestart: remainBusy,
      moduleRequest: noModules,
      client: async () => {
        await build.promise;
        return client();
      },
      canonicalizeProjectRoot: (root) => root,
      admitted: (connection) => { admitted.push(String(connection)); },
      openProject: async () => {
        await opening.promise;
        return { receive: async () => {}, release: () => {} };
      },
    });
    const clientAttach = encoder.encode(encodeAccountAttach({ intent: "client", host: "editor", credential }));
    const answered = router.receive("client", clientAttach);
    const opened = router.receive("runtime", encoder.encode(encodeAccountAttach({ intent: "runtime", projectRoot: "/one", credential })));
    expect(await router.receive("partial", clientAttach.subarray(0, 5))).toBe("pending");
    expect(await router.receive("refused", encoder.encode(encodeAccountAttach({ intent: "client", host: "editor", credential: newAccountAttachCredential() })))).toBe("rejected");
    // Neither the client build nor the project open has settled.
    expect(admitted).toEqual(["client", "runtime"]);
    build.resolve();
    opening.resolve();
    expect(await answered).toBe("accepted");
    expect(await opened).toBe("accepted");
    expect(admitted).toEqual(["client", "runtime"]);
  });

  it("rejects a client attach followed by protocol bytes", async () => {
    const credential = newAccountAttachCredential();
    const responses: string[] = [];
    const router = createAccountSocketRouter({
      credential: Redacted.make(credential),
      answerCutover: remainBusy,
      answerRestart: remainBusy,
      moduleRequest: noModules,
      client,
      canonicalizeProjectRoot: (root) => root,
      send: (_connection, bytes) => { responses.push(new TextDecoder().decode(bytes)); },
      openProject: async () => ({ receive: async () => {}, release: () => {} }),
    });
    const attach = encoder.encode(encodeAccountAttach({ intent: "client", host: "editor", credential }));
    const combined = new Uint8Array(attach.length + 1);
    combined.set(attach);
    combined.set(Uint8Array.of(7), attach.length);

    expect(await router.receive("client", combined)).toBe("rejected");
    expect(responses).toEqual([]);
  });

  it("reports a client the runtime cannot serve as an attach failure", async () => {
    const credential = newAccountAttachCredential();
    const responses: string[] = [];
    let opens = 0;
    const router = createAccountSocketRouter({
      credential: Redacted.make(credential),
      answerCutover: remainBusy,
      answerRestart: remainBusy,
      moduleRequest: noModules,
      client: async () => ({ kind: "failed", error: "the web client is not at /opt/webview" }),
      canonicalizeProjectRoot: (root) => root,
      send: (_connection, bytes) => { responses.push(new TextDecoder().decode(bytes)); },
      openProject: async () => {
        opens += 1;
        return { receive: async () => {}, release: () => {} };
      },
    });

    expect(await router.receive("client", encoder.encode(encodeAccountAttach({ intent: "client", host: "editor", credential })))).toBe("accepted");
    expect(opens).toBe(0);
    expect(responses).toEqual(['{"flywheel":"account.attach.failed","error":"the web client is not at /opt/webview"}\n']);
  });

  it("serves a module request without opening a project: its answers stream until it ends, and a close withdraws it", async () => {
    const credential = newAccountAttachCredential();
    const responses: string[] = [];
    const requests: unknown[] = [];
    const leave = Promise.withResolvers<void>();
    const waiting = Promise.withResolvers<AbortSignal>();
    let opens = 0;
    let pathWork = 0;
    const router = createAccountSocketRouter({
      credential: Redacted.make(credential),
      answerCutover: remainBusy,
      answerRestart: remainBusy,
      moduleRequest: async (module, request, answer, signal) => {
        requests.push({ module, request });
        if (request.type === "fail") throw new Error("the remote module is off for this account");
        await answer({ step: 1 });
        if (request.type === "wait") {
          waiting.resolve(signal);
          signal.addEventListener("abort", () => leave.resolve(), { once: true });
          await leave.promise;
          await answer({ step: 2 });
        }
      },
      client,
      canonicalizeProjectRoot: (root) => { pathWork += 1; return root; },
      send: (connection, bytes) => { responses.push(`${String(connection)} ${new TextDecoder().decode(bytes)}`); },
      openProject: async () => {
        opens += 1;
        return { receive: async () => {}, release: () => {} };
      },
    });
    const attach = (type: string) => encoder.encode(encodeAccountAttach({ intent: "module", module: "remote", request: { type }, credential }));

    expect(await router.receive("done", attach("once"))).toBe("accepted");
    expect(await router.receive("failed", attach("fail"))).toBe("accepted");
    const answered = router.receive("waiting", attach("wait"));
    const withdrawn = await waiting.promise;
    router.close("waiting");
    expect(await answered).toBe("accepted");

    expect(withdrawn.aborted).toBe(true);
    expect(requests).toEqual([{ module: "remote", request: { type: "once" } }, { module: "remote", request: { type: "fail" } }, { module: "remote", request: { type: "wait" } }]);
    expect(responses).toEqual([
      'done {"flywheel":"account.module.answer","payload":{"step":1}}\n',
      'done {"flywheel":"account.module.end"}\n',
      'failed {"flywheel":"account.attach.failed","error":"the remote module is off for this account"}\n',
      'waiting {"flywheel":"account.module.answer","payload":{"step":1}}\n',
    ]);
    expect(opens).toBe(0);
    expect(pathWork).toBe(0);
  });
});
