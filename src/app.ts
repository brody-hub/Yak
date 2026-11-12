import { randomUUID } from "node:crypto"

import cookieParser from "cookie-parser"
import cors from "cors"
import express, { type Express } from "express"
import helmet from "helmet"
import { pinoHttp } from "pino-http"

import { checkDatabaseConnection } from "./db/index.js"
import { env } from "./env.js"
import { betterAuthHandler } from "./lib/auth-handler.js"
import { ForbiddenError } from "./lib/errors.js"
import { logger } from "./logger.js"
import { errorHandler, notFoundHandler } from "./middleware/error.js"
import { authLimiter } from "./middleware/rate-limit.js"
import { apiRouter, publicMetaRouter } from "./routes/index.js"

export function createApp(): Express {
  const app = express()

  // Railway terminates TLS at its edge, so the client IP and protocol arrive
  // in forwarded headers. Trusting exactly one hop keeps rate limiting keyed
  // on the real caller without letting a client spoof the chain.
  app.set("trust proxy", 1)
  app.disable("x-powered-by")

  app.use((req, res, next) => {
    req.id = req.get("x-request-id") ?? randomUUID()
    res.setHeader("X-Request-Id", req.id)
    next()
  })

  app.use(
    pinoHttp({
      logger,
      genReqId: (req) => (req as { id?: string }).id ?? randomUUID(),
      autoLogging: {
        ignore: (req) => req.url === "/health",
      },
      serializers: {
        // No query string (the Sideshift callback carries an authorization
        // code in it) and no headers beyond the user agent.
        req: (req) => ({
          id: req.id,
          method: req.method,
          url: String(req.url).split("?")[0],
          remoteAddress: req.remoteAddress,
          userAgent: req.headers?.["user-agent"],
        }),
      },
    })
  )

  app.use(
    helmet({
      // This process only ever serves JSON, so the browser-facing directives
      // that matter are the ones about who may read that JSON.
      contentSecurityPolicy: false,
      crossOriginResourcePolicy: { policy: "cross-origin" },
      crossOriginEmbedderPolicy: false,
    })
  )

  app.use(
    cors({
      origin(origin, callback) {
        // Same-origin and server-to-server callers send no Origin header.
        // Those are authenticated by API key, not by cookie, so there is no
        // CSRF surface to protect here.
        if (!origin || env.allowedOrigins.includes(origin)) {
          callback(null, true)
          return
        }

        logger.warn({ origin }, "Blocked cross-origin request")
        callback(new ForbiddenError("Origin not allowed"))
      },
      credentials: true,
      methods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
      allowedHeaders: [
        "Content-Type",
        "Authorization",
        "X-API-Key",
        "X-Request-Id",
        "Idempotency-Key",
      ],
      exposedHeaders: ["X-Request-Id"],
      maxAge: 86_400,
    })
  )

  // The database check is remembered briefly so an unauthenticated flood of
  // health probes cannot turn into a flood of database round trips.
  let health: { at: number; database: boolean } = { at: 0, database: false }

  app.get("/health", async (_req, res) => {
    if (Date.now() - health.at > 5_000) {
      health = { at: Date.now(), database: await checkDatabaseConnection() }
    }

    const { database } = health

    res.status(database ? 200 : 503).json({
      status: database ? "ok" : "degraded",
      database,
      uptime: Math.round(process.uptime()),
      timestamp: new Date().toISOString(),
    })
  })

  // Better Auth reads the raw request stream, so it has to be mounted before
  // the JSON body parser claims it. Only an allowlist of its endpoints is
  // reachable; see betterAuthHandler for why the request is rebuilt.
  app.use("/api/auth", authLimiter, betterAuthHandler)

  app.use(express.json({ limit: "1mb" }))
  app.use(cookieParser())

  app.use("/api", publicMetaRouter)
  app.use("/api", apiRouter)

  app.use(notFoundHandler)
  app.use(errorHandler)

  return app
}
