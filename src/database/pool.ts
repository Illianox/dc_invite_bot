import mysql from "mysql2/promise";
import { env } from "../config/env.js";

export const pool = mysql.createPool({
  host: env.MYSQL_HOST,
  port: env.MYSQL_PORT,
  user: env.MYSQL_USER,
  password: env.MYSQL_PASSWORD,
  database: env.MYSQL_DATABASE,
  waitForConnections: true,
  connectionLimit: 10,
  timezone: "Z",
  decimalNumbers: true
});

export async function checkDatabase(): Promise<number> {
  const startedAt = performance.now();
  await pool.query("SELECT 1");
  return Math.round(performance.now() - startedAt);
}
