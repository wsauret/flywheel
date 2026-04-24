import { WorkerHandoffSchema } from "../../infra/handoff-schemas.js";
import { WORK_STEP_FIELDS } from "../queue/steps/work/fields.js";
import { registerHandoffType } from "./registry.js";

registerHandoffType({
  name: "work-handoff",
  schema: WorkerHandoffSchema,
  fields: WORK_STEP_FIELDS,
  description:
    "Structured handoff written by work and sprint steps after implementing code changes.",
});
