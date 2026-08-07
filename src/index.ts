import { createApp } from "./app.js"
import { closeDatabase } from "./db/index.js"
import { env } from "./env.js"
import { logger } from "./logger.js"

const app = createApp()

const server = app.listen(env.PORT, () => {
  logger.info(
    {
      port: env.PORT,
      env: env.NODE_ENV,
      appUrl: env.APP_URL,
      emailConfigured: env.email.configured,
      imagesConfigured: env.images.configured,
    },
    `${env.TENANT_NAME} API listening`
  )
})

/**
 * Railway sends SIGTERM before replacing a container. Draining in-flight
 * requests first avoids 502s during a deploy.
 */
function shutdown(signal: string) {
  logger.info({ signal }, "Shutting down")

  const force = setTimeout(() => {
    logger.error("Graceful shutdown timed out, forcing exit")
    process.exit(1)
  }, 15_000)

  force.unref()

  server.close(async () => {
    await closeDatabase().catch((error: unknown) => {
      logger.warn({ err: error }, "Error while closing database pool")
    })

    logger.info("Shutdown complete")
    process.exit(0)
  })
}

process.on("SIGTERM", () => shutdown("SIGTERM"))
process.on("SIGINT", () => shutdown("SIGINT"))

process.on("unhandledRejection", (reason) => {
  logger.error({ err: reason }, "Unhandled promise rejection")
})

process.on("uncaughtException", (error) => {
  logger.fatal({ err: error }, "Uncaught exception")
  process.exit(1)
})
