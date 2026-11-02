import { expect, test } from "bun:test";
import { join } from "node:path";

function python(args: readonly string[]): void {
  const result = Bun.spawnSync(["python3", "-B", ...args], {
    cwd: process.cwd(),
    windowsHide: true,
    stdout: "pipe",
    stderr: "pipe",
  });
  expect(result.exitCode, `${result.stdout.toString()}\n${result.stderr.toString()}`).toBe(0);
}

function originalTest(name: string): void {
  python(["-m", "pytest", `${join(import.meta.dir, "pipeline.py")}::${name}`, "-v", "-p", "no:cacheprovider"]);
}

test("default calls with different inputs do not share seen ids", () => {
  python(["-c", `
from src.events import Event
from src.processor import process_events

first = [Event(41, "first", "First", priority=1)]
second = [
    Event(41, "second", "Second", priority=2),
    Event(42, "second", "New", priority=3),
    Event(42, "second", "Duplicate", priority=0),
]
assert process_events(first) == first
assert process_events(second) == [second[1], second[0]]
`]);
});

test("the original test_process_twice scenario passes", () => {
  originalTest("test_process_twice");
});

test.each(["test_basic_processing", "test_shared_dedup", "test_summary_report"])(
  "existing passing test %s still passes",
  (name) => originalTest(name),
);
