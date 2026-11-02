import wrangler from "./worker/wrangler.jsonc"

/** Reports the hosted relay's Durable Object duration from Cloudflare's
 *  GraphQL Analytics API and fails when an object looks like it stopped
 *  hibernating.
 *
 *  An object that hibernates between frames bills almost no duration; one that
 *  stays awake bills wall-clock time, about $4 a month of duration for each
 *  such object. `relay/worker/test/relay-hibernation.test.ts` guards the code
 *  paths before a deploy, and this script reads the duration production used.
 *  Its cost column is the gross price of that duration, before the account's
 *  included allocation and Cloudflare's rounding.
 *
 *  It authenticates with the existing wrangler login and never prints the
 *  token. `CLOUDFLARE_ACCOUNT_ID` selects the account when the login reaches
 *  several. It reads only the namespace of the relay's runtime class, so the
 *  bug-report inbox is not counted. It exits non-zero, naming each object and
 *  day, when one object was active longer than `AWAKE_HOURS_LIMIT` in a
 *  complete UTC day. The analytics API allows few queries a minute, so the
 *  whole report is one GraphQL query. */

const API = "https://api.cloudflare.com/client/v4"
const WINDOW_DAYS = 7
const TOP_OBJECTS = 5
// No person streams 20 hours a day, while an object that cannot hibernate reads close to 24.
const AWAKE_HOURS_LIMIT = 20
const USD_PER_MILLION_GB_S = 12.5
const MONTHLY_INCLUDED_GB_S = 400_000
const MICROSECONDS_PER_HOUR = 3_600_000_000

const worker: { name: string; durable_objects: { bindings: { name: string; class_name: string }[] } } = wrangler
const workerName = worker.name
const className = worker.durable_objects.bindings.find((binding) => binding.name === "RELAY_RUNTIME")?.class_name
if (className === undefined) throw new Error("worker/wrangler.jsonc binds no RELAY_RUNTIME Durable Object")

interface DayRow {
  dimensions: { date: string; objectId: string }
  sum: { activeTime: number; duration: number }
}

function wranglerToken(): string {
  const result = Bun.spawnSync(["bunx", "wrangler", "auth", "token", "--json"], { cwd: import.meta.dir, stdout: "pipe", stderr: "pipe", windowsHide: true })
  if (result.exitCode !== 0) throw new Error("Could not read the wrangler login token; run `bunx wrangler login` in relay/ first")
  const login: { token: string } = JSON.parse(result.stdout.toString())
  return login.token
}

const headers = { Authorization: `Bearer ${wranglerToken()}`, "Content-Type": "application/json" }

async function rest<T>(path: string): Promise<T> {
  const body: { success: boolean; result: T; errors: { message: string }[] | null } = await (await fetch(`${API}${path}`, { headers })).json()
  if (!body.success) throw new Error(`Cloudflare API ${path} failed: ${body.errors?.map((error) => error.message).join("; ")}`)
  return body.result
}

async function accountId(): Promise<string> {
  const configured = process.env.CLOUDFLARE_ACCOUNT_ID
  if (configured) return configured
  const accounts = await rest<{ id: string; name: string }[]>("/accounts")
  if (accounts.length !== 1) throw new Error(`The wrangler login reaches ${accounts.length} accounts (${accounts.map((account) => account.name).join(", ")}); set CLOUDFLARE_ACCOUNT_ID to choose one`)
  return accounts[0]!.id
}

const account = await accountId()
const namespaces = await rest<{ id: string; script: string; class: string }[]>(`/accounts/${account}/workers/durable_objects/namespaces`)
const namespace = namespaces.find((candidate) => candidate.script === workerName && candidate.class === className)
if (namespace === undefined) throw new Error(`No Durable Object namespace for class ${className} of Worker ${workerName} in account ${account}`)

const today = new Date().toISOString().slice(0, 10)
const days = Array.from({ length: WINDOW_DAYS }, (_, index) => new Date(Date.parse(today) - (WINDOW_DAYS - 1 - index) * 86_400_000).toISOString().slice(0, 10))
const monthStart = `${today.slice(0, 7)}-01`

const query = `query($account: string!, $namespace: string!, $windowStart: Date!, $monthStart: Date!) { viewer { accounts(filter: { accountTag: $account }) {
  days: durableObjectsPeriodicGroups(filter: { namespaceId: $namespace, date_geq: $windowStart }, limit: 10000) { dimensions { date objectId } sum { activeTime duration } }
  month: durableObjectsPeriodicGroups(filter: { namespaceId: $namespace, date_geq: $monthStart }, limit: 1) { sum { duration } }
} } }`
const response: { data: { viewer: { accounts: { days: DayRow[]; month: { sum: { duration: number } }[] }[] } } | null; errors: { message: string }[] | null } = await (
  await fetch(`${API}/graphql`, { method: "POST", headers, body: JSON.stringify({ query, variables: { account, namespace: namespace.id, windowStart: days[0], monthStart } }) })
).json()
if (response.errors) throw new Error(`Cloudflare GraphQL Analytics failed: ${response.errors.map((error) => error.message).join("; ")}`)
const { days: rows, month } = response.data!.viewer.accounts[0]!

const gbSeconds = (value: number) => value.toLocaleString("en-US", { maximumFractionDigits: 1 })
const hours = (activeTime: number) => activeTime / MICROSECONDS_PER_HOUR

console.log(`${className} of ${workerName}: Durable Object duration by UTC day`)
console.log("Day          Objects  GB-s          Gross cost")
for (const day of days) {
  const dayRows = rows.filter((row) => row.dimensions.date === day)
  const duration = dayRows.reduce((total, row) => total + row.sum.duration, 0)
  const cost = `$${((duration / 1_000_000) * USD_PER_MILLION_GB_S).toFixed(4)}`
  console.log(`${day}   ${String(dayRows.length).padStart(7)}  ${gbSeconds(duration).padStart(12)}  ${cost}${day === today ? "  (today, incomplete)" : ""}`)
}

const monthDuration = month[0]?.sum.duration ?? 0
console.log(`\nMonth to date: ${gbSeconds(monthDuration)} GB-s of the ${gbSeconds(MONTHLY_INCLUDED_GB_S)} GB-s monthly included allocation (${((monthDuration / MONTHLY_INCLUDED_GB_S) * 100).toFixed(1)}%)`)

const activeByObject = new Map<string, number>()
for (const row of rows) activeByObject.set(row.dimensions.objectId, (activeByObject.get(row.dimensions.objectId) ?? 0) + row.sum.activeTime)
console.log(`\nTop ${TOP_OBJECTS} objects by active hours since ${days[0]}:`)
for (const [objectId, activeTime] of [...activeByObject].sort((a, b) => b[1] - a[1]).slice(0, TOP_OBJECTS)) {
  console.log(`  ${objectId.slice(0, 12)}  ${hours(activeTime).toFixed(1)} h`)
}

const awake = rows.filter((row) => row.dimensions.date !== today && hours(row.sum.activeTime) > AWAKE_HOURS_LIMIT)
if (awake.length > 0) {
  console.error(`\n${awake.length} object-days were active more than ${AWAKE_HOURS_LIMIT} hours, so these objects likely stopped hibernating:`)
  for (const row of awake) console.error(`  ${row.dimensions.date}  ${row.dimensions.objectId}  ${hours(row.sum.activeTime).toFixed(1)} h`)
  process.exitCode = 1
} else {
  console.log(`\nNo object was active more than ${AWAKE_HOURS_LIMIT} hours in a complete UTC day.`)
}
