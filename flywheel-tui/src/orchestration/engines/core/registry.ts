import type { Engine } from "./types.js";

const engines = new Map<string, Engine>();

export function registerEngine(engine: Engine): void {
  engines.set(engine.metadata.id, engine);
}

export function getEngine(id: string): Engine {
  const engine = engines.get(id);
  if (!engine) {
    const available = [...engines.keys()].join(", ");
    throw new Error(`Unknown engine "${id}". Available engines: ${available}`);
  }
  return engine;
}
