/** The log path a generated background script writes to, whichever shell wrote
 *  it. The POSIX script redirects with `exec >'<path>'`; the Windows script
 *  opens the file and points its standard handles at it. A fixture that seeds
 *  a background log has to read the path back out of the script it was
 *  handed, so it recognizes both. */
export function backgroundLogPath(scriptContent: string): string | undefined {
  return scriptContent.match(/^exec >'([^']+)'/m)?.[1]
    ?? scriptContent.match(/\[System\.IO\.File\]::Open\('([^']+)'/)?.[1];
}
