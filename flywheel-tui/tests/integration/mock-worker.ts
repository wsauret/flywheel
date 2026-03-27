#!/usr/bin/env bun
/**
 * Mock worker process for integration testing.
 * Reads stdin, prints some output, then prints the completion marker.
 * Simulates a successful worker execution.
 */

// Read stdin (the prompt will come via args, not stdin, but we handle it)
const prompt = process.argv.slice(2).join(" ");

// Simulate some work output
console.log(JSON.stringify({ type: "text", content: "Starting work..." }));
console.log(JSON.stringify({ type: "text", content: `Processing step: ${prompt.slice(0, 80)}...` }));
console.log(JSON.stringify({ type: "text", content: "Work completed." }));

// Print completion marker
console.log("<promise>COMPLETE</promise>");

process.exit(0);
