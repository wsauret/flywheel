/** One validation lane per user per machine.
 *
 *  `bun run lint`, `bun run test`, every `bun run test:integration:*` mode, and
 *  `bun run test:perf` each fan out across every core, so two of them running
 *  at once from different sessions or worktrees saturate the machine and stall
 *  every interactive Flywheel process on it. The lane admits one gate at a
 *  time, in arrival order: a gate that arrives while another holds the lane
 *  waits, says who it is waiting for, and starts its own clocks only once it
 *  has been admitted, so waiting never counts against a duration budget.
 *
 *  The queue is a directory of ticket files. A ticket's name orders it (its
 *  arrival time in milliseconds, then its pid), and the earliest ticket whose
 *  process is still alive is the holder. There is no separate owner file: a
 *  holder that exits or dies leaves a ticket nobody answers for, and the next
 *  scan removes it, so a crash never wedges the lane. The lane lives in the
 *  user's temp directory, which is the machine-wide scope every worktree and
 *  clone shares. */

import { mkdirSync, readdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isProcessAlive } from "../src/infra/process-liveness.js";

export interface LaneTicket {
  readonly name: string;
  readonly pid: number;
  readonly label: string;
  readonly enteredAt: number;
}

const TICKET_PATTERN = /^(\d{13,})-(\d+)\.json$/;
const POLL_MS = 500;
const REPORT_EVERY_MS = 5_000;

function defaultLaneDirectory(): string {
  return join(tmpdir(), "flywheel-validation-lane");
}

export function ticketName(enteredAt: number, pid: number): string {
  return `${String(enteredAt).padStart(13, "0")}-${pid}.json`;
}

/** The live tickets in arrival order. A ticket whose process is gone is
 *  removed on sight, by whichever waiter sees it first; two waiters removing
 *  the same dead ticket is fine, absence is the outcome both wanted. */
export function liveTickets(directory: string): LaneTicket[] {
  const tickets: LaneTicket[] = [];
  for (const name of readdirSync(directory).sort()) {
    const match = TICKET_PATTERN.exec(name);
    if (!match) continue;
    const pid = Number(match[2]);
    if (!isProcessAlive(pid)) {
      try { unlinkSync(join(directory, name)); } catch { /* another waiter removed it first */ }
      continue;
    }
    let label = "?";
    try {
      const record: unknown = JSON.parse(readFileSync(join(directory, name), "utf8"));
      if (typeof record === "object" && record !== null && "label" in record && typeof record.label === "string") label = record.label;
    } catch { /* a ticket mid-rename reads empty; its name still orders it */ }
    tickets.push({ name, pid, label, enteredAt: Number(match[1]) });
  }
  return tickets;
}

/** Enter the lane and resolve once admitted. The returned function leaves the
 *  lane; it also runs at process exit so a gate that exits from a signal
 *  handler or a failure path still hands the lane on. */
export async function enterValidationLane(
  label: string,
  options: { readonly directory?: string; readonly report?: (line: string) => void; readonly pollMs?: number } = {},
): Promise<() => void> {
  const directory = options.directory ?? defaultLaneDirectory();
  const report = options.report ?? ((line) => process.stderr.write(`${line}\n`));
  mkdirSync(directory, { recursive: true });
  const mine = ticketName(Date.now(), process.pid);
  // Written under a name the pattern rejects, then renamed: a scan never sees a
  // half-written ticket under a name that would order it.
  const staging = join(directory, `staging-${process.pid}`);
  writeFileSync(staging, JSON.stringify({ label, pid: process.pid }));
  renameSync(staging, join(directory, mine));

  let left = false;
  const leave = (): void => {
    if (left) return;
    left = true;
    process.off("exit", leave);
    try { unlinkSync(join(directory, mine)); } catch { /* already swept as dead, or removed by us */ }
  };
  process.on("exit", leave);

  let lastReport = 0;
  const waitingSince = Date.now();
  for (;;) {
    const queue = liveTickets(directory);
    const position = queue.findIndex((ticket) => ticket.name === mine);
    if (position === -1) throw new Error(`validation lane ticket ${mine} disappeared while waiting`);
    if (position === 0) {
      if (lastReport !== 0) report(`validation lane: admitted ${label} after ${Math.round((Date.now() - waitingSince) / 1000)}s`);
      return leave;
    }
    const now = Date.now();
    if (now - lastReport >= REPORT_EVERY_MS) {
      lastReport = now;
      const holder = queue[0]!;
      const ahead = position === 1 ? "" : `, ${position - 1} more ahead`;
      report(`validation lane: ${label} waiting for ${holder.label} (pid ${holder.pid}, ${Math.round((now - holder.enteredAt) / 1000)}s in)${ahead}`);
    }
    await Bun.sleep(options.pollMs ?? POLL_MS);
  }
}
