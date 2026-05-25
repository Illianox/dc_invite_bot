import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { RowDataPacket } from "mysql2/promise";
import { pool } from "../database/pool.js";
import { env } from "../config/env.js";

const migrationDirectory = fileURLToPath(new URL("../database/migrations", import.meta.url));

async function migrate(): Promise<void> {
  if (env.MYSQL_DATABASE !== "blacklist_referralbot") {
    throw new Error("Refusing to run migrations outside MYSQL_DATABASE=blacklist_referralbot.");
  }
  const connection = await pool.getConnection();
  try {
    await connection.query(
      "CREATE TABLE IF NOT EXISTS schema_migrations (version VARCHAR(100) PRIMARY KEY, applied_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP)"
    );
    const [rows] = await connection.query<Array<RowDataPacket & { version: string }>>("SELECT version FROM schema_migrations");
    const applied = new Set(rows.map((row) => row.version));
    const files = (await readdir(migrationDirectory)).filter((file) => file.endsWith(".sql")).sort();

    for (const file of files) {
      if (applied.has(file)) continue;
      const sql = await readFile(join(migrationDirectory, file), "utf8");
      await connection.beginTransaction();
      try {
        for (const statement of sql.split(";").map((item) => item.trim()).filter(Boolean)) {
          await connection.query(statement);
        }
        await connection.query("INSERT INTO schema_migrations (version) VALUES (?)", [file]);
        await connection.commit();
        console.log(`Applied migration ${file}`);
      } catch (error) {
        await connection.rollback();
        throw error;
      }
    }
  } finally {
    connection.release();
    await pool.end();
  }
}

void migrate().catch((error) => {
  console.error("Migration failed", error);
  process.exitCode = 1;
});
