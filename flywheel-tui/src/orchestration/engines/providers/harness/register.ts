import { registerEngine } from "../../core/registry.js";
import { createHarnessEngine } from "./engine.js";

registerEngine(createHarnessEngine());
