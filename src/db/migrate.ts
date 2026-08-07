import { migrate } from "drizzle-orm/node-postgres/migrator"

import { logger } from "../logger.js"
import { closeDatabase, db } from "./index.js"

async function main() {
  logger.info("Running database migrations")
  await migrate(db, { migrationsFolder: "./drizzle" })
  logger.info("Migrations complete")
}

main()
  .catch((error) => {
    logger.error({ err: error }, "Migration failed")
    process.exitCode = 1
  })
  .finally(async () => {
    await closeDatabase()
  })
