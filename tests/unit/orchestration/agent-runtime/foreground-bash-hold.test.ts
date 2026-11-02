import { describe, expect, it } from "bun:test";

import { createForegroundBashHoldController } from "../../../../src/orchestration/agent-runtime/foreground-bash-hold.js";

describe("foreground Bash hold controller", () => {
  it("publishes active raw tool call IDs and releases one hold", async () => {
    const publications: (readonly string[])[] = [];
    const controller = createForegroundBashHoldController((ids) => publications.push(ids));
    const hold = controller.register("toolu_raw");

    expect(publications).toEqual([["toolu_raw"]]);
    expect(controller.release("toolu_raw")).toBe(true);
    await expect(hold.released).resolves.toBe("user_detach");
    expect(publications).toEqual([["toolu_raw"], []]);
    expect(controller.release("toolu_raw")).toBe(false);
  });

  it("rejects a duplicate before mutation and preserves the first hold", async () => {
    const publications: (readonly string[])[] = [];
    const controller = createForegroundBashHoldController((ids) => publications.push(ids));
    const first = controller.register("duplicate");

    expect(() => controller.register("duplicate")).toThrow("duplicate");
    expect(publications).toEqual([["duplicate"]]);
    expect(controller.release("duplicate")).toBe(true);
    await expect(first.released).resolves.toBe("user_detach");
  });

  // A planned replacement's cut interrupts the turn only after this settles,
  // because an interrupt ends a command that is still in its hold.
  it("moves every held command to the background for a replacement and settles once each is tracked", async () => {
    const publications: (readonly string[])[] = [];
    const controller = createForegroundBashHoldController((ids) => publications.push(ids));
    const first = controller.register("toolu_first");
    const second = controller.register("toolu_second");
    first.running();
    second.running();

    let settled = false;
    const transfer = controller.transferForReplacement().then(() => { settled = true; });
    await expect(first.released).resolves.toBe("replacement");
    await expect(second.released).resolves.toBe("replacement");
    expect(publications.at(-1)).toEqual([]);

    // Work admitted after the cut transfers at once and never shows Detach.
    const late = controller.register("toolu_late");
    await expect(late.released).resolves.toBe("replacement");
    expect(publications.at(-1)).toEqual([]);

    first.cleanup();
    await Bun.sleep(1);
    expect(settled).toBe(false);
    second.cleanup();
    await transfer;
    expect(controller.release("toolu_late")).toBe(false);

    // A later pass, such as the stop's, waits for the late command too once
    // it runs.
    late.running();
    let lateSettled = false;
    const stopTransfer = controller.transferForReplacement().then(() => { lateSettled = true; });
    await Bun.sleep(1);
    expect(lateSettled).toBe(false);
    late.cleanup();
    await stopTransfer;
    controller.dispose();
  });

  // A launch that has not started has nothing to move, so the move never
  // waits for it; the cut's interrupt cancels it.
  it("releases a hold whose launch has not started without waiting for it", async () => {
    const controller = createForegroundBashHoldController(() => {});
    const queued = controller.register("toolu_queued");

    await controller.transferForReplacement();
    await expect(queued.released).resolves.toBe("replacement");

    queued.running();
    let settled = false;
    const stopTransfer = controller.transferForReplacement().then(() => { settled = true; });
    await Bun.sleep(1);
    expect(settled).toBe(false);
    queued.cleanup();
    await stopTransfer;
  });

  it("returns idempotent cleanup that cannot remove a later registration", () => {
    const publications: (readonly string[])[] = [];
    const controller = createForegroundBashHoldController((ids) => publications.push(ids));
    const first = controller.register("reused");

    first.cleanup();
    first.cleanup();
    const second = controller.register("reused");
    first.cleanup();

    expect(publications).toEqual([["reused"], [], ["reused"]]);
    expect(controller.release("reused")).toBe(true);
    second.cleanup();
    expect(publications).toEqual([["reused"], [], ["reused"], []]);
  });

  it("waits for natural settlement and rejects disposal while a hold is live", async () => {
    const controller = createForegroundBashHoldController(() => {});
    const hold = controller.register("live");

    expect(() => controller.dispose()).toThrow("live");
    let settled = false;
    const settlement = controller.awaitSettlement().then(() => { settled = true; });
    await Promise.resolve();
    expect(settled).toBe(false);

    hold.cleanup();
    await settlement;
    controller.dispose();
    expect(() => controller.register("late")).toThrow("disposed");
  });
});
