/** @jsxImportSource @opentui/solid */

import { createSimpleContext } from "./helper.js"
import { createTickPool } from "./tick-pool.js"

export const { use: useTickPool, provider: TickPoolProvider } = createSimpleContext({
  name: "TickPool",
  init: () => createTickPool(),
})
