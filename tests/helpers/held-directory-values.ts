/** Whether a confirmed directory watch holds derived values on this platform.
 *  Windows computes every read until a native run proves its watch, so a case
 *  there asserts that every request reads and that nothing is held. */
export const HOLDS_DIRECTORY_VALUES = process.platform !== "win32"
