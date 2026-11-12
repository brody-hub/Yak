/**
 * Boot entry. App modules are loaded dynamically so a failure during import
 * (Better Auth, Express routes, etc.) still prints to Railway logs.
 */
console.error("[boot] process starting")

try {
  const { createApp } = await import("./app.js")
  const { checkDatabaseRole, closeDatabase } = await import("./db/index.js")
  const { env } = await import("./env.js")
  const { logger } = await import("./logger.js")

  console.error(`[boot] modules loaded, binding 0.0.0.0:${env.PORT}`)

  // Tenant isolation rests on Postgres row level security, which superusers
  // and BYPASSRLS roles skip entirely. Refuse to serve customers that way.
  const dbRole = await checkDatabaseRole()

  if (dbRole.bypassesRowSecurity) {
    if (env.isProduction) {
      console.error(
        `[boot] refusing to start: database role "${dbRole.role}" bypasses row level security. Connect as a plain role (see docs/DEPLOYMENT.md).`
      )
      await closeDatabase()
      process.exit(1)
    }

    console.error(
      `[boot] WARNING: database role "${dbRole.role}" bypasses row level security; tenant isolation is enforced by the application only in this environment`
    )
  } else {
    console.error(
      `[boot] database role "${dbRole.role}" is subject to row level security`
    )
  }

  // Optional first-boot path when SUPER_ADMIN_EMAIL is set and no super admin
  // exists yet.
  const { bootstrapSuperAdminFromEnv, resetSuperAdminFromEnv } =
    await import("./scripts/create-owner.js")
  const bootstrap = await bootstrapSuperAdminFromEnv()

  if (bootstrap?.status === "created") {
    console.error(`[boot] super admin created for ${bootstrap.email}`)
    if (bootstrap.inviteEmailSent) {
      console.error("[boot] temporary password emailed")
    } else if (!env.email.configured) {
      // Only without an email service. A failed send with email configured
      // is not compensated by printing a live credential to the deploy log.
      console.error(`[boot] temporary password: ${bootstrap.temporaryPassword}`)
      console.error("[boot] change it immediately after signing in")
    } else {
      console.error(
        "[boot] the invite email could not be sent; set SUPER_ADMIN_RESET_PASSWORD=true for one deploy once email works"
      )
    }
  } else if (bootstrap?.status === "exists") {
    console.error(`[boot] super admin already exists (${bootstrap.email})`)
  } else if (bootstrap?.status === "skipped") {
    console.error(`[boot] super admin bootstrap skipped: ${bootstrap.reason}`)
  }

  const reset = await resetSuperAdminFromEnv()

  if (reset?.status === "reset") {
    console.error(`[boot] super admin password reset for ${reset.email}`)
    if (reset.emailSent) {
      console.error("[boot] temporary password emailed")
    } else if (reset.temporaryPassword) {
      // Only without an email service. Rotate it as soon as you are in.
      console.error(`[boot] temporary password: ${reset.temporaryPassword}`)
      console.error("[boot] change it immediately after signing in")
    } else {
      console.error(
        "[boot] the password email could not be sent; set SUPER_ADMIN_RESET_PASSWORD again once email works"
      )
    }
  } else if (reset?.status === "skipped") {
    console.error(`[boot] super admin password reset skipped: ${reset.reason}`)
  }

  const app = createApp()

  const server = app.listen(env.PORT, "0.0.0.0", () => {
    console.error(`[boot] listening on 0.0.0.0:${env.PORT}`)
    logger.info(
      {
        port: env.PORT,
        env: env.NODE_ENV,
        appUrl: env.APP_URL,
        emailConfigured: env.email.configured,
        imagesConfigured: env.images.configured,
        stripeConfigured: env.stripe.configured,
        stripeMode: env.stripe.configured ? env.stripe.mode : null,
        databaseRole: dbRole.role,
      },
      `${env.APP_NAME} API listening`
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
} catch (error) {
  console.error("[boot] failed to start", error)
  process.exit(1)
}
