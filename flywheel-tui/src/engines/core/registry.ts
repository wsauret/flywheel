/**
 * Engine registry.
 *
 * All engines are registered at import time. Use `getEngine(id)` to look up
 * by config value.
 */

import type { Engine } from "./types";
import { claudeEngine } from "../providers/claude.js";
import { opencodeEngine } from "../providers/opencode.js";
import { droidEngine } from "../providers/droid.js";

const engines = new Map<string, Engine>();

function register(engine: Engine): void {
  engines.set(engine.metadata.id, engine);
}

// Register all built-in engines
register(claudeEngine);
register(opencodeEngine);
register(droidEngine);

/**
 * Get an engine by ID. Throws if not found.
 */
export function getEngine(id: string): Engine {
  const engine = engines.get(id);
  if (!engine) {
    const available = Array.from(engines.keys()).join(", ");
    throw new Error(`Unknown engine "${id}". Available engines: ${available}`);
  }
  return engine;
}


