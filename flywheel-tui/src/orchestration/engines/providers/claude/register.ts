import { registerEngine } from "../../core/registry.js";
import { createClaudeEngine } from "./engine.js";

registerEngine(createClaudeEngine());
