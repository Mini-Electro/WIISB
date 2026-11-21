import { PGlite } from "@electric-sql/pglite";
import { drizzle as embeddedDrizzle } from "drizzle-orm/pglite";
import { drizzle as postgresDrizzle } from "drizzle-orm/node-postgres";
import { sql, type SQL } from "drizzle-orm";
import pg from "pg";
import { readFile, mkdir, readdir } from "node:fs/promises";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

export interface Query {
  query<T = any>(text: string, params?: any[]): Promise<T[]>;
}
function statement(text: string, params: any[]): SQL {
  const parts: SQL[] = [];
  let previous = 0;
  for (const match of text.matchAll(/\$(\d+)/g)) {
    parts.push(
      sql.raw(text.slice(previous, match.index)),
      sql`${params[Number(match[1]) - 1]}`,
    );
    previous = match.index! + match[0].length;
  }
  parts.push(sql.raw(text.slice(previous)));
  return sql.join(parts, sql.raw(""));
}
function connection(orm: any): Query {
  return {
    async query<T>(text: string, params: any[] = []) {
      const result = await orm.execute(statement(text, params));
      return result.rows as T[];
    },
  };
}
export class Database implements Query {
  private embedded?: PGlite;
  private pool?: pg.Pool;
  private orm: any;
  private queue: Promise<unknown> = Promise.resolve();
  async open(url?: string, directory?: string) {
    if (url) {
      this.pool = new pg.Pool({ connectionString: url, max: 12 });
      this.orm = postgresDrizzle(this.pool);
    } else {
      if (directory) await mkdir(directory, { recursive: true });
      this.embedded = new PGlite(directory);
      await this.embedded.waitReady;
      this.orm = embeddedDrizzle(this.embedded);
    }
    await this.query(
      "CREATE TABLE IF NOT EXISTS schema_migrations (version text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())",
    );
    const migrations = resolve(
      dirname(fileURLToPath(import.meta.url)),
      "../migrations",
    );
    for (const file of (await readdir(migrations))
      .filter((f) => /^\d+_.+\.sql$/.test(f))
      .sort()) {
      const version = file.split("_")[0];
      if (
        (
          await this.query("SELECT 1 FROM schema_migrations WHERE version=$1", [
            version,
          ])
        ).length
      )
        continue;
      const migration = await readFile(resolve(migrations, file), "utf8");
      await this.transaction(async (tx) => {
        for (const part of migration
          .split(";")
          .map((s) => s.trim())
          .filter(Boolean))
          await tx.query(part);
        await tx.query("INSERT INTO schema_migrations(version) VALUES($1)", [
          version,
        ]);
      });
    }
    return this;
  }
  private serial<T>(fn: () => Promise<T>): Promise<T> {
    const job = this.queue.then(fn, fn);
    this.queue = job.catch(() => {});
    return job;
  }
  query<T = any>(text: string, params: any[] = []): Promise<T[]> {
    return this.embedded
      ? this.serial(() => connection(this.orm).query<T>(text, params))
      : connection(this.orm).query<T>(text, params);
  }
  transaction<T>(fn: (tx: Query) => Promise<T>): Promise<T> {
    const run = () => this.orm.transaction((orm: any) => fn(connection(orm)));
    return this.embedded ? this.serial(run) : run();
  }
  async close() {
    await this.queue;
    await this.embedded?.close();
    await this.pool?.end();
  }
}
