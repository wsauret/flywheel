/**
 * Tool registry with concurrency-aware batch execution.
 *
 * Shared tools run in parallel; exclusive tools wait for all prior
 * tasks to complete before executing.
 */

import type { z } from "zod";
import type { HarnessTool, ToolCall, ToolContext, ToolResult } from "./types.js";

/** Internal type alias for accessing Zod schema internals. */
interface ZodDef {
  typeName?: string;
  description?: string;
  shape?: () => Record<string, z.ZodType>;
  innerType?: z.ZodType;
  values?: string[];
  type?: z.ZodType; // ZodArray element type
  options?: z.ZodType[]; // ZodUnion options
  left?: z.ZodType; // ZodIntersection
  right?: z.ZodType; // ZodIntersection
  schema?: z.ZodType; // ZodEffects (refine/transform/superRefine)
}

function getDef(schema: z.ZodType): ZodDef {
  return (schema as unknown as { _def: ZodDef })._def;
}

/** Converts a Zod schema to a plain JSON Schema object for the LLM API. */
function zodToJsonSchema(schema: z.ZodType): object {
  return zodTypeToJsonSchema(schema);
}

function zodTypeToJsonSchema(schema: z.ZodType): object {
  const def = getDef(schema);
  const description = def.description;
  const base: Record<string, unknown> = {};
  if (description) base.description = description;

  // Unwrap wrappers
  if ((def.typeName === "ZodOptional" || def.typeName === "ZodDefault") && def.innerType) {
    return { ...zodTypeToJsonSchema(def.innerType), ...base };
  }

  // Unwrap ZodNullable
  if (def.typeName === "ZodNullable" && def.innerType) {
    return { ...zodTypeToJsonSchema(def.innerType), ...base };
  }

  // Unwrap ZodEffects (refine, superRefine, transform, pipe)
  if (def.typeName === "ZodEffects" && def.schema) {
    return { ...zodTypeToJsonSchema(def.schema), ...base };
  }

  // Primitives
  if (def.typeName === "ZodString") return { type: "string", ...base };
  if (def.typeName === "ZodNumber") return { type: "number", ...base };
  if (def.typeName === "ZodBoolean") return { type: "boolean", ...base };
  if (def.typeName === "ZodEnum" && def.values) {
    return { type: "string", enum: def.values, ...base };
  }
  if (def.typeName === "ZodLiteral") {
    const val = (def as unknown as { value: unknown }).value;
    return { type: typeof val as string, const: val, ...base };
  }

  // Object
  if (def.typeName === "ZodObject" && typeof def.shape === "function") {
    const shape = def.shape();
    const properties: Record<string, unknown> = {};
    const required: string[] = [];
    for (const [key, value] of Object.entries(shape)) {
      properties[key] = zodTypeToJsonSchema(value);
      if (!isOptional(value)) {
        required.push(key);
      }
    }
    return {
      type: "object" as const,
      properties,
      ...(required.length > 0 ? { required } : {}),
      ...base,
    };
  }

  // Array
  if (def.typeName === "ZodArray" && def.type) {
    return { type: "array", items: zodTypeToJsonSchema(def.type), ...base };
  }

  // Union
  if (def.typeName === "ZodUnion" && def.options) {
    const anyOf = def.options.map((opt) => zodTypeToJsonSchema(opt));
    return { anyOf, ...base };
  }

  // Discriminated union
  if (def.typeName === "ZodDiscriminatedUnion" && def.options) {
    const anyOf = def.options.map((opt) => zodTypeToJsonSchema(opt));
    return { anyOf, ...base };
  }

  // Intersection
  if (def.typeName === "ZodIntersection" && def.left && def.right) {
    const allOf = [zodTypeToJsonSchema(def.left), zodTypeToJsonSchema(def.right)];
    return { allOf, ...base };
  }

  // Fallback for unknown types — use object with no properties
  return { type: "object", ...base };
}

function isOptional(schema: z.ZodType): boolean {
  const def = getDef(schema);
  return def.typeName === "ZodOptional" || def.typeName === "ZodDefault";
}

export interface ToolRegistry {
  register(tool: HarnessTool): void;
  get(name: string): HarnessTool | undefined;
  getAll(): HarnessTool[];
  toLLMDefinitions(): Array<{ name: string; description: string; input_schema: object }>;
  executeBatch(calls: ToolCall[], context: ToolContext): Promise<ToolResult[]>;
}

export function createToolRegistry(): ToolRegistry {
  const tools = new Map<string, HarnessTool>();

  return {
    register(tool: HarnessTool): void {
      tools.set(tool.name, tool);
    },

    get(name: string): HarnessTool | undefined {
      return tools.get(name);
    },

    getAll(): HarnessTool[] {
      return [...tools.values()];
    },

    toLLMDefinitions(): Array<{ name: string; description: string; input_schema: object }> {
      return [...tools.values()].map((tool) => ({
        name: tool.name,
        description: tool.description,
        input_schema: zodToJsonSchema(tool.inputSchema),
      }));
    },

    async executeBatch(calls: ToolCall[], context: ToolContext): Promise<ToolResult[]> {
      const results: ToolResult[] = new Array(calls.length);

      // Concurrency scheduling:
      // - Shared tools accumulate and run in parallel
      // - Exclusive tools flush prior tasks, then run alone
      let lastExclusive: Promise<void> = Promise.resolve();
      let sharedTasks: Promise<void>[] = [];
      const allTasks: Promise<void>[] = [];

      for (let i = 0; i < calls.length; i++) {
        const call = calls[i]!;
        const tool = tools.get(call.name);
        if (!tool) {
          results[i] = { content: `Unknown tool: ${call.name}`, isError: true };
          continue;
        }

        const concurrency = tool.concurrency;
        const start =
          concurrency === "exclusive"
            ? Promise.all([lastExclusive, ...sharedTasks])
            : lastExclusive;

        const idx = i;
        const task = start.then(async () => {
          try {
            results[idx] = await tool.execute(call.input, context);
          } catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            results[idx] = { content: message, isError: true };
          }
        });

        allTasks.push(task);
        if (concurrency === "exclusive") {
          lastExclusive = task;
          sharedTasks = [];
        } else {
          sharedTasks.push(task);
        }
      }

      await Promise.allSettled(allTasks);
      return results;
    },
  };
}
