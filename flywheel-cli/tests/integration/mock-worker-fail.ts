#!/usr/bin/env bun
/**
 * Mock worker that fails (no completion marker, non-zero exit).
 */
console.log("Starting work...");
console.log("ERROR: something went wrong");
process.exit(1);
