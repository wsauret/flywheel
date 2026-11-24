export interface MatrixCell<Variant, Fixture> {
  readonly variant: Variant;
  readonly fixture: Fixture;
  readonly repeat: number;
}

export interface MatrixIdentity {
  readonly variant: string;
  readonly fixture: string;
  readonly repeat: number;
}

export const DEFAULT_BENCHMARK_CONCURRENCY = 4;

function matrixKey(cell: MatrixIdentity): string {
  return `${cell.variant}\u0000${cell.fixture}\u0000${cell.repeat}`;
}

/** Plans one serial lane per variant. Lanes run concurrently without fixture barriers. */
export function planMatrix<Variant, Fixture>(
  variants: readonly Variant[],
  fixtures: readonly Fixture[],
  repeats: number,
): readonly (readonly MatrixCell<Variant, Fixture>[])[] {
  if (!Number.isInteger(repeats) || repeats < 1) throw new Error(`Repeats must be a positive integer, got ${repeats}`);
  if (variants.length === 0) throw new Error("A matrix requires at least one variant");
  if (fixtures.length === 0) throw new Error("A matrix requires at least one fixture");
  return variants.map((variant) => {
    const lane: MatrixCell<Variant, Fixture>[] = [];
    for (let repeat = 0; repeat < repeats; repeat++) {
      for (const fixture of fixtures) lane.push({ variant, fixture, repeat });
    }
    return lane;
  });
}

/** Builds the strict completion index. Duplicate successful rows are corruption. */
export function completionIndex<Row>(records: readonly Row[], identity: (record: Row) => MatrixIdentity): ReadonlySet<string> {
  const completed = new Set<string>();
  for (const record of records) {
    const key = matrixKey(identity(record));
    if (completed.has(key)) throw new Error(`Duplicate completed matrix cell: ${key}`);
    completed.add(key);
  }
  return completed;
}

function failureWrite<Cell>(
  onError: (cell: Cell, error: unknown) => Promise<void> | void,
  cell: Cell,
  error: unknown,
): () => Promise<void> {
  return async () => { await onError(cell, error); };
}

/** Runs serial lanes through one fair concurrency queue and serializes durable writes. */
export async function runGroups<Cell, Result>(
  groups: readonly (readonly Cell[])[],
  run: (cell: Cell) => Promise<Result>,
  persist: (cell: Cell, result: Result) => Promise<void>,
  onError: (cell: Cell, error: unknown) => Promise<void> | void,
  signal?: AbortSignal,
  concurrency = DEFAULT_BENCHMARK_CONCURRENCY,
): Promise<number> {
  if (!(concurrency > 0) || !Number.isInteger(concurrency)) throw new Error("Matrix concurrency must be a positive integer");
  const lanes = groups.filter((group) => group.length > 0);
  const positions = lanes.map(() => 0);
  const ready = lanes.map((_, index) => index);
  let failed = 0;
  let writes = Promise.resolve();
  const writeErrors: unknown[] = [];
  const enqueue = (write: () => Promise<void>): Promise<boolean> => {
    const settled = writes.then(async () => {
      try {
        await write();
        return true;
      } catch (error) {
        writeErrors.push(error);
        return false;
      }
    });
    writes = settled.then(() => {});
    return settled;
  };
  const worker = async (): Promise<void> => {
    while (true) {
      if (signal?.aborted) return;
      const laneIndex = ready.shift();
      if (laneIndex === undefined) return;
      const lane = lanes[laneIndex];
      const position = positions[laneIndex];
      if (lane === undefined || position === undefined) continue;
      const cell = lane[position];
      if (cell === undefined) continue;
      const nextPosition = position + 1;
      positions[laneIndex] = nextPosition;
      let persisted: boolean;
      try {
        const result = await run(cell);
        persisted = await enqueue(() => persist(cell, result));
      } catch (error) {
        failed++;
        persisted = await enqueue(failureWrite(onError, cell, error));
      }
      if (persisted && !signal?.aborted && nextPosition < lane.length) ready.push(laneIndex);
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, lanes.length) }, worker));
  await writes;
  if (writeErrors.length > 0) throw writeErrors[0];
  return failed;
}

export interface MatrixRunOptions<Cell extends MatrixIdentity, Result> {
  readonly groups: readonly (readonly Cell[])[];
  readonly completed: ReadonlySet<string>;
  readonly run: (cell: Cell) => Promise<Result>;
  readonly persist: (cell: Cell, result: Result) => Promise<void>;
  readonly onError: (cell: Cell, error: unknown) => Promise<void> | void;
  readonly signal?: AbortSignal;
  readonly concurrency?: number;
}

/** Runs only incomplete cells against one completion index shared by every group. */
export async function runMatrix<Cell extends MatrixIdentity, Result>(options: MatrixRunOptions<Cell, Result>): Promise<number> {
  const concurrency = options.concurrency ?? DEFAULT_BENCHMARK_CONCURRENCY;
  if (!(concurrency > 0) || !Number.isInteger(concurrency)) throw new Error("Matrix concurrency must be a positive integer");
  const pending = options.groups
    .map((group) => group.filter((cell) => !options.completed.has(matrixKey(cell))))
    .filter((group) => group.length > 0);
  return runGroups(pending, options.run, options.persist, options.onError, options.signal, concurrency);
}
