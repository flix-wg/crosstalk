import { DatabaseSync } from "node:sqlite";
import type { Store, SqlTx, SqlValue } from "../core/index.js";

export function openStore(path: string): Store & { close(): void } {
  const db = new DatabaseSync(path);
  try {
    db.exec("PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=5000; PRAGMA foreign_keys=ON;");
  } catch (error) {
    db.close();
    throw error;
  }
  const tx: SqlTx = {
    run(sql, ...p) { return { changes: Number(db.prepare(sql).run(...p).changes) }; },
    // SQLite returns untyped rows; the storage port's caller owns the row shape.
    all<T>(sql: string, ...p: SqlValue[]): T[] {
      return db.prepare(sql).all(...p) as T[];
    },
    get<T>(sql: string, ...p: SqlValue[]): T | undefined {
      return db.prepare(sql).get(...p) as T | undefined;
    },
  };
  return {
    tx(fn) {
      db.exec("BEGIN IMMEDIATE");
      try {
        const result = fn(tx);
        if (result && typeof (result as { then?: unknown }).then === "function") {
          throw new TypeError("Store transactions must be synchronous");
        }
        db.exec("COMMIT");
        return result;
      } catch (error) {
        db.exec("ROLLBACK");
        throw error;
      }
    },
    close() { db.close(); },
  };
}
