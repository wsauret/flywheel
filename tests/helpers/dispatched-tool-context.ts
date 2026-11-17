import type { CreateNestedToolDispatchBatch, DispatchedToolContext, ToolContext } from "../../src/orchestration/agent-runtime/tools/types.js";

/** A nested dispatch factory for a call that runs no nested calls: a tool that opens a batch fails the test. */
const noNestedToolDispatch: CreateNestedToolDispatchBatch = () => {
  throw new Error("This test call runs no nested tool calls.");
};

/** A fixture context completed as the dispatch seam completes one: a call id (the fixture's own, else `call-1`) and a
 *  nested dispatch factory (the fixture's own, else one that refuses). */
export function dispatchedToolContext(context: ToolContext & Partial<DispatchedToolContext>): DispatchedToolContext {
  return { ...context, toolUseId: context.toolUseId ?? "call-1", createNestedToolDispatchBatch: context.createNestedToolDispatchBatch ?? noNestedToolDispatch };
}
