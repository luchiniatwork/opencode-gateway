import { Database } from "bun:sqlite";
import { mkdir } from "node:fs/promises";
import { dirname } from "node:path";

export interface GatewayDatabase {
  readonly path: string;
  readonly db: Database;
  close(): void;
}

export interface OpenGatewayDatabaseOptions {
  createParentDir?: boolean;
}

export async function openGatewayDatabase(
  databasePath: string,
  options: OpenGatewayDatabaseOptions = {},
): Promise<GatewayDatabase> {
  if (databasePath !== ":memory:" && options.createParentDir !== false) {
    await mkdir(dirname(databasePath), { recursive: true });
  }

  const db = new Database(databasePath, { create: true });
  let closed = false;

  db.run("PRAGMA foreign_keys = ON");

  return {
    path: databasePath,
    db,
    close(): void {
      if (closed) return;

      closed = true;
      db.close();
    },
  };
}
