import { createApp } from "./app.js"
import { closeDatabase } from "./db/index.js"
import { env } from "./env.js"
import { logger } from "./logger.js"

// Plain stderr so a crash before the logger is ready still shows up in Railway.
console.error(`[boot] starting ${env.TENANT_NAME} on port ${env.PORT}`)

let app
try {
  app = createApp()
} catch (error) {
  console.error("[boot] createApp failed", error)
  process.exit(1)
}

const server = app.listen(env.PORT, "0.0.0.0", () => {
  console.error(`[boot] listening on 0.0.0.0:${env.PORT}`)
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
