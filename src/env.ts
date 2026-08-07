import "dotenv/config"
import { z } from "zod"

const emptyToUndefined = (value: unknown) =>
  typeof value === "string" && value.trim() === "" ? undefined : value

const urlNoTrailingSlash = z
  .string()
  .url()
  .transform((value) => value.replace(/\/+$/, ""))

const schema = z.object({
  NODE_ENV: z
    .enum(["development", "test", "production"])
    .default("development"),
  PORT: z.coerce.number().int().positive().default(8080),

  API_URL: urlNoTrailingSlash,
  APP_URL: urlNoTrailingSlash,
  CORS_ORIGINS: z.preprocess(emptyToUndefined, z.string().optional()),

  DATABASE_URL: z.string().min(1),
  DATABASE_SSL: z
    .preprocess(emptyToUndefined, z.enum(["true", "false"]).default("true"))
    .transform((value) => value === "true"),

  BETTER_AUTH_SECRET: z
    .string()
    .min(32, "BETTER_AUTH_SECRET must be at least 32 characters"),
  ENCRYPTION_KEY: z
    .string()
    .min(1)
    .refine(
      (value) => Buffer.from(value, "base64").length === 32,
      "ENCRYPTION_KEY must be 32 bytes encoded as base64 (openssl rand -base64 32)"
    ),

  TENANT_NAME: z.string().min(1).default("Stand"),
  TENANT_SLUG: z
    .string()
    .regex(/^[a-z0-9-]+$/, "TENANT_SLUG must be lowercase alphanumeric or dashes")
    .default("stand"),

  CLOUDFLARE_ACCOUNT_ID: z.preprocess(emptyToUndefined, z.string().optional()),
  CLOUDFLARE_EMAIL_API_TOKEN: z.preprocess(
    emptyToUndefined,
    z.string().optional()
  ),
  EMAIL_FROM: z.preprocess(emptyToUndefined, z.string().email().optional()),
  EMAIL_FROM_NAME: z.preprocess(emptyToUndefined, z.string().optional()),

  CLOUDFLARE_IMAGES_API_TOKEN: z.preprocess(
    emptyToUndefined,
    z.string().optional()
  ),
  CLOUDFLARE_IMAGES_ACCOUNT_HASH: z.preprocess(
    emptyToUndefined,
    z.string().optional()
  ),
  CLOUDFLARE_IMAGES_SIGNING_KEY: z.preprocess(
    emptyToUndefined,
    z.string().optional()
  ),
  CLOUDFLARE_IMAGES_URL_TTL: z.coerce.number().int().positive().default(3600),

  OWNER_EMAIL: z.preprocess(emptyToUndefined, z.string().email().optional()),
  OWNER_NAME: z.preprocess(emptyToUndefined, z.string().optional()),
})

const parsed = schema.safeParse(process.env)

if (!parsed.success) {
  const issues = parsed.error.issues
    .map((issue) => `  - ${issue.path.join(".")}: ${issue.message}`)
    .join("\n")

  throw new Error(`Invalid environment configuration:\n${issues}`)
}

const raw = parsed.data

const extraOrigins = (raw.CORS_ORIGINS ?? "")
  .split(",")
  .map((origin) => origin.trim().replace(/\/+$/, ""))
  .filter(Boolean)

export const env = {
  ...raw,
  isProduction: raw.NODE_ENV === "production",
  isDevelopment: raw.NODE_ENV === "development",
  /** Origins allowed to make credentialed requests against the panel API. */
  allowedOrigins: Array.from(new Set([raw.APP_URL, ...extraOrigins])),
  encryptionKey: Buffer.from(raw.ENCRYPTION_KEY, "base64"),
  email: {
    configured: Boolean(
      raw.CLOUDFLARE_ACCOUNT_ID && raw.CLOUDFLARE_EMAIL_API_TOKEN && raw.EMAIL_FROM
    ),
    accountId: raw.CLOUDFLARE_ACCOUNT_ID,
    apiToken: raw.CLOUDFLARE_EMAIL_API_TOKEN,
    from: raw.EMAIL_FROM,
    fromName: raw.EMAIL_FROM_NAME ?? raw.TENANT_NAME,
  },
  images: {
    configured: Boolean(
      raw.CLOUDFLARE_ACCOUNT_ID &&
        raw.CLOUDFLARE_IMAGES_API_TOKEN &&
        raw.CLOUDFLARE_IMAGES_ACCOUNT_HASH
    ),
    accountId: raw.CLOUDFLARE_ACCOUNT_ID,
    apiToken: raw.CLOUDFLARE_IMAGES_API_TOKEN,
    accountHash: raw.CLOUDFLARE_IMAGES_ACCOUNT_HASH,
    signingKey: raw.CLOUDFLARE_IMAGES_SIGNING_KEY,
    urlTtlSeconds: raw.CLOUDFLARE_IMAGES_URL_TTL,
  },
} as const

export type Env = typeof env
