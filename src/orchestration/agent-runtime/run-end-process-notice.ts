/**
 * The notice for managed commands that a run which cannot wait for input
 * leaves running: a run that can wait parks on them as owed work instead.
 * The host closes its background owner once such a run completes, and that
 * close ends every managed command, so a server the agent started without
 * persist_after_exit stops before anything that relies on it runs.
 * Where the agent can launch a persistent command, the model hears once per
 * command, before the run completes, that the command ends with the run, and
 * can launch it again to persist. A command named once is not named again.
 */
import { Log } from "../../infra/log.js";
import type { BackgroundProcessRecord } from "./background-work-processes.js";

const log = Log.create({ service: "agent-loop" });

/** Answers the notice for running managed commands that no earlier notice
 *  named, or undefined when there are none. */
export type RunEndProcessNotice = (records: readonly BackgroundProcessRecord[], providerSessionKey: string) => string | undefined;

export function createRunEndProcessNotice(): RunEndProcessNotice {
  const named = new Set<string>();
  return (records, providerSessionKey) => {
    const running = records.filter((record) => record.kind === "background_command" && record.status === "running" && !named.has(record.id));
    if (running.length === 0) return undefined;
    for (const record of running) named.add(record.id);
    log.info("run completes over running managed commands; telling the model they end with it", { processIds: running.map((record) => record.id), providerSessionKey });
    const list = running.map((record) => `- ${record.id}: ${record.description}`).join("\n");
    return `[run-end notice] Finishing this run stops these managed processes:\n${list}\nIf a process must outlive this run, stop it with process action stop and wait for its confirmed exit. Then launch it again with persist_after_exit=true and check that it still does what the work needs. Otherwise, finish.`;
  };
}
