/** The program of the throwaway launchd job whose starts fail, which
 *  launchd-registration-reload.test.ts registers with a StandardErrorPath.
 *  The test bundles it into its temporary root before the job loads, so
 *  launchd never runs a file from the checkout. Each start opens its own log
 *  and bounds the error log as a start of the account service does, so no
 *  record of the bound reaches its standard error. It records its start and
 *  its exit code as marker lines, and writes its number to its standard
 *  error. It exits 1, which KeepAlive restarts, until the test writes the
 *  `succeed` marker file. Then it exits 0, which parks the job.
 *
 *  argv: <error log> <markers directory> */
import { appendFileSync, existsSync, readFileSync, writeSync } from "node:fs"
import { join } from "node:path"

import { keepServiceErrorLogBounded } from "../../../src/cli/startup.js"
import { Log } from "../../../src/infra/log.js"

const [errorLog, markers] = process.argv.slice(2)
if (errorLog === undefined || markers === undefined) throw new Error("usage: _launchd-error-log-job.ts <error log> <markers directory>")
await Log.init({ dir: markers, print: false })
keepServiceErrorLogBounded(errorLog)
const events = join(markers, "events.log")
appendFileSync(events, "start\n")
const start = readFileSync(events, "utf8").split("\n").filter((event) => event === "start").length
writeSync(2, `start ${start}\n`)
const code = existsSync(join(markers, "succeed")) ? 0 : 1
appendFileSync(events, `exit ${code}\n`)
process.exit(code)
