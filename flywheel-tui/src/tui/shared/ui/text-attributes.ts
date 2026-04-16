/**
 * Shared text attribute constants.
 *
 * Avoids duplicate `createTextAttributes()` calls across components.
 * Each call creates a new object — hoisting them here is both a
 * performance optimization and a consistency guarantee.
 */

import { createTextAttributes } from "@opentui/core"

export const BOLD = createTextAttributes({ bold: true })
export const DIM = createTextAttributes({ dim: true })
export const ITALIC = createTextAttributes({ italic: true })
export const BOLD_DIM = createTextAttributes({ bold: true, dim: true })
