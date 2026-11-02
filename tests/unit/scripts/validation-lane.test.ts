import { describe, expect, it } from "bun:test";
import { existsSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { enterValidationLane, liveTickets, ticketName } from "../../../scripts/validation-lane.js";
import { temporaryDirectories } from "../../helpers/directories.js";

const temporaryDirectory = temporaryDirectories();

// A pid no process holds: pid_max on every supported platform is far below it.
const DEAD_PID = 2_000_000_000;

function laneDir(): string {
  return temporaryDirectory("flywheel-validation-lane-");
}

describe("validation lane", () => {
  it("orders tickets by arrival and removes a dead holder's ticket on sight", () => {
    const directory = laneDir();
    const dead = ticketName(1_000, DEAD_PID);
    const live = ticketName(2_000, process.pid);
    writeFileSync(join(directory, dead), JSON.stringify({ label: "lint", pid: DEAD_PID }));
    writeFileSync(join(directory, live), JSON.stringify({ label: "test", pid: process.pid }));
    expect(liveTickets(directory).map((ticket) => ticket.label)).toEqual(["test"]);
    expect(existsSync(join(directory, dead))).toBe(false);
  });

  it("admits the earliest live ticket and waits behind an earlier one until it leaves", async () => {
    const directory = laneDir();
    const reports: string[] = [];
    const holder = ticketName(Date.now() - 10_000, process.ppid);
    writeFileSync(join(directory, holder), JSON.stringify({ label: "lint", pid: process.ppid }));
    let admitted = false;
    const entering = enterValidationLane("test", { directory, report: (line) => reports.push(line), pollMs: 5 }).then((leave) => {
      admitted = true;
      return leave;
    });
    await Bun.sleep(20);
    expect(admitted).toBe(false);
    expect(reports[0]).toMatch(/^validation lane: test waiting for lint \(pid \d+, \d+s in\)$/);
    rmSync(join(directory, holder));
    const leave = await entering;
    expect(admitted).toBe(true);
    expect(liveTickets(directory)).toHaveLength(1);
    leave();
    expect(liveTickets(directory)).toHaveLength(0);
  });

  it("admits immediately when the lane is empty and says nothing", async () => {
    const directory = laneDir();
    const reports: string[] = [];
    const leave = await enterValidationLane("lint", { directory, report: (line) => reports.push(line) });
    expect(reports).toEqual([]);
    expect(liveTickets(directory).map((ticket) => ticket.pid)).toEqual([process.pid]);
    leave();
  });
});
