/**
 * Engine lookup.
 *
 * Single engine (Claude). Validates the engine ID from config and returns it.
 */

import type { Engine } from "./types.js";
import { claudeEngine } from "../providers/claude.js";

export function getEngine(id: string): Engine {
  if (id !== claudeEngine.metadata.id) {
    throw new Error(`Unknown engine "${id}". Available engines: ${claudeEngine.metadata.id}`);
  }
  return claudeEngine;
}
