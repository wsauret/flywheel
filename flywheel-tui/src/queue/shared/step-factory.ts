import { randomUUID } from "crypto";
import type { Step, StepType } from "../types";

export function makeStep(type: StepType, title: string, extra?: Partial<Step>): Step {
  return {
    id: randomUUID(),
    type,
    title,
    status: "pending",
    ...extra,
  };
}

export function makeGateStep(title: string): Step {
  return makeStep("gate", title);
}
