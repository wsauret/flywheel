export interface QueryResult {
  rowCount: number;
}

export interface Connection {
  query(sql: string, params: readonly unknown[]): Promise<QueryResult>;
}

export interface Pool {
  acquire(): Promise<Connection>;
  release(connection: Connection): void;
}

export class Database {
  constructor(private readonly pool: Pool) {}

  /** Run `work` in one transaction on one connection. Commits after `work`
   *  resolves and rolls back when `work` or the commit throws. */
  async transaction<T>(work: (tx: Connection) => Promise<T>): Promise<T> {
    const connection = await this.pool.acquire();
    try {
      await connection.query("BEGIN", []);
      const result = await work(connection);
      await connection.query("COMMIT", []);
      return result;
    } catch (error) {
      await connection.query("ROLLBACK", []);
      throw error;
    } finally {
      this.pool.release(connection);
    }
  }
}
