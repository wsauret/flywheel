/**
 * Engine registry.
 *
 * All engines are registered at import time. Use `getEngine(id)` to look up
 * by config value, `getAllEngines()` to list available engines.
 */

import type { Engine } from "./types";
import { claudeEngine } from "../providers/claude/index";
import { opencodeEngine } from "../providers/opencode/index";

const engines = new Map<string, Engine>();

function register(engine: Engine): void {
  engines.set(engine.metadata.id, engine);
}

// Register all built-in engines
register(claudeEngine);
register(opencodeEngine);

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

/**
 * Get all registered engines.
 */
export function getAllEngines(): Engine[] {
  return Array.from(engines.values());
}

/**
 * Check if an engine ID is valid.
 */
export function isValidEngine(id: string): boolean {
  return engines.has(id);
}

/**
 * Check if an engine's CLI binary is available on the system.
 */
export function isEngineAvailable(id: string): boolean {
  const engine = engines.get(id);
  if (!engine) return false;
  try {
    return Bun.which(engine.metadata.cliBinary) !== null;
  } catch {
    return false;
  }
}

/**
 * Get install instructions for an engine. Returns undefined if engine is not registered.
 */
export function getEngineInstallInstructions(id: string): string | undefined {
  const engine = engines.get(id);
  return engine?.metadata.installCommand;
}
