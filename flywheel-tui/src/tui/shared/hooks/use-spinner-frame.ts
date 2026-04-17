import { createSignal, createEffect, onCleanup } from "solid-js";
import type { Accessor } from "solid-js";
import { SPINNER_FRAMES, SPINNER_INTERVAL } from "../components/spinner.js";

export function useSpinnerFrame(isActive: Accessor<boolean>): Accessor<string> {
  const [frame, setFrame] = createSignal(SPINNER_FRAMES[0]!);
  createEffect(() => {
    if (!isActive()) return;
    const id = setInterval(() => {
      setFrame((prev) => {
        const idx = SPINNER_FRAMES.indexOf(prev);
        return SPINNER_FRAMES[(idx + 1) % SPINNER_FRAMES.length]!;
      });
    }, SPINNER_INTERVAL);
    onCleanup(() => clearInterval(id));
  });
  return frame;
}
