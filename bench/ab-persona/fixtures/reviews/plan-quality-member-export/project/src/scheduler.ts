export type Job = () => Promise<void>;

export interface Scheduler {
  /** Run `job` every night at 02:00 club time. A thrown error is logged and the job runs again the next night. */
  nightly(name: string, job: Job): void;
}
