import "dotenv/config"
import { defineConfig } from "drizzle-kit"

// `drizzle-kit generate` diffs the schema offline and never opens a
// connection, so a placeholder keeps migration generation possible without a
// live database. `push` and `studio` still require a real URL.
const url = process.env.DATABASE_URL ?? "postgresql://localhost:5432/placeholder"

export default defineConfig({
  schema: "./src/db/schema.ts",
  out: "./drizzle",
  dialect: "postgresql",
  dbCredentials: {
    url,
    ssl: process.env.DATABASE_SSL === "false" ? false : { rejectUnauthorized: false },
  },
  strict: true,
  verbose: true,
})
