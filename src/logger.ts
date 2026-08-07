import { pino } from "pino"

import { env } from "./env.js"

/**
 * Values that must never reach the log sink. Session tokens and API keys are
 * bearer credentials; leaking them into logs is equivalent to leaking the
 * account.
 */
const redactPaths = [
  "req.headers.cookie",
  "req.headers.authorization",
  "req.headers['x-api-key']",
  "res.headers['set-cookie']",
  "*.password",
  "*.apiKey",
  "*.webhookUrl",
  "*.secret",
]

export const logger = pino({
  level: env.isProduction ? "info" : "debug",
  redact: { paths: redactPaths, censor: "[redacted]" },
  transport: env.isProduction
    ? undefined
    : {
        target: "pino-pretty",
        options: { colorize: true, translateTime: "HH:MM:ss" },
      },
})

export type Logger = typeof logger
