import { runGuest } from "./invocation-guest.js"

// The Worker entry. Its basename is unique because the packaged build names
// each entry by its basename alone.
runGuest(globalThis)
