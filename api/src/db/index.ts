import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import { config } from "../config";
import * as schema from "./schema";

export const pool = new Pool({
  connectionString: config.databaseUrl,
  // Production databases must use TLS (HIPAA: encryption in transit).
  ssl: config.databaseSsl ? { rejectUnauthorized: false } : undefined,
});

export const db = drizzle(pool, { schema });
export { schema };
