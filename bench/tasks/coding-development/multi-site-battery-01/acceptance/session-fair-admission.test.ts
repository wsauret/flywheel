import { expect, test } from "bun:test";
import { createSessionFairAdmission } from "../src/infra/session-fair-admission";

const settle = async () => {
  for (let turn = 0; turn < 5; turn += 1) await Promise.resolve();
};

test("session-fair-admission: a repeated release frees its permit only once", async () => {
  const admission = createSessionFairAdmission(1);
  const release = await admission.acquire("holder");
  const admitted: string[] = [];
  const queued = ["a", "b", "c"].map((session) => admission.acquire(session).then((granted) => { admitted.push(session); return granted; }));
  release();
  release();
  await settle();
  expect(admitted).toEqual(["a"]);
  const releaseA = await queued[0]!;
  releaseA();
  releaseA();
  await settle();
  expect(admitted).toEqual(["a", "b"]);
  (await queued[1]!)();
  (await queued[2]!)();
  expect(admitted).toEqual(["a", "b", "c"]);
});

test("session-fair-admission: a taken permit released twice creates no capacity", async () => {
  const admission = createSessionFairAdmission(2);
  const held = await admission.acquire("held");
  const taken = admission.take();
  const admitted: string[] = [];
  const queued = ["a", "b"].map((session) => admission.acquire(session).then((granted) => { admitted.push(session); return granted; }));
  taken();
  taken();
  await settle();
  expect(admitted).toEqual(["a"]);
  held();
  await settle();
  expect(admitted).toEqual(["a", "b"]);
  for (const next of queued) (await next)();
});

test("session-fair-admission: each single release admits the next session in turn", async () => {
  const admission = createSessionFairAdmission(1);
  const release = await admission.acquire("holder");
  const admitted: string[] = [];
  const queue = (session: string, name: string) => admission.acquire(session).then((granted) => { admitted.push(name); return granted; });
  const pending = [queue("a", "a1"), queue("a", "a2"), queue("b", "b1")];
  release();
  for (const next of [pending[0]!, pending[2]!, pending[1]!]) (await next)();
  expect(admitted).toEqual(["a1", "b1", "a2"]);
});
