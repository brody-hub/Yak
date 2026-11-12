import "dotenv/config"
import { z } from "zod"

const emptyToUndefined = (value: unknown) =>
  typeof value === "string" && value.trim() === "" ? undefined : value

const urlNoTrailingSlash = z
  .string()
  .url()
  .transform((value) => value.replace(/\/+$/, ""))

const schema = z.object({
  // Required, no default: a deployment that forgot to set it would otherwise
  // run with development behaviour (debug logging, non-Secure cookies).
  NODE_ENV: z.enum(["development", "test", "production"], {
    message: "NODE_ENV must be set to development, test, or production",
  }),
  PORT: z.coerce.number().int().positive().default(8080),
  // Rate limits are on in every environment unless this is set explicitly,
  // for hot reload loops in development.
  RATE_LIMIT_DISABLED: z
    .preprocess(emptyToUndefined, z.enum(["true", "false"]).default("false"))
    .transform((value) => value === "true"),

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

  // Product name shown on the login screen and in account emails. Each
  // customer's own brand comes from their tenant's settings instead.
  APP_NAME: z.preprocess(emptyToUndefined, z.string().min(1).default("Yak")),
  // Session cookie prefix. Defaults to the old TENANT_SLUG so upgrading a
  // single-customer deployment does not sign everyone out.
  AUTH_COOKIE_PREFIX: z.preprocess(
    emptyToUndefined,
    z
      .string()
      .regex(
        /^[a-z0-9-]+$/,
        "AUTH_COOKIE_PREFIX must be lowercase alphanumeric or dashes"
      )
      .optional()
  ),
  // Deprecated: from the single-customer days. Only read as a fallback.
  TENANT_SLUG: z.preprocess(emptyToUndefined, z.string().optional()),

  CLOUDFLARE_ACCOUNT_ID: z.preprocess(emptyToUndefined, z.string().optional()),
  CLOUDFLARE_EMAIL_API_TOKEN: z.preprocess(
    emptyToUndefined,
    z.string().optional()
  ),
  EMAIL_FROM: z.preprocess(emptyToUndefined, z.string().email().optional()),
  EMAIL_FROM_NAME: z.preprocess(emptyToUndefined, z.string().optional()),

  R2_ACCESS_KEY_ID: z.preprocess(emptyToUndefined, z.string().optional()),
  R2_SECRET_ACCESS_KEY: z.preprocess(emptyToUndefined, z.string().optional()),
  R2_BUCKET: z.preprocess(emptyToUndefined, z.string().optional()),
  R2_JURISDICTION: z.preprocess(emptyToUndefined, z.string().optional()),
  R2_URL_TTL: z.coerce.number().int().positive().default(3600),

  // Ingest API ceilings, in requests per minute per API key.
  INGEST_RATE_LIMIT_PER_MINUTE: z.preprocess(
    emptyToUndefined,
    z.coerce.number().int().positive().default(600)
  ),
  EVENT_INGEST_RATE_LIMIT_PER_MINUTE: z.preprocess(
    emptyToUndefined,
    z.coerce.number().int().positive().default(300)
  ),

  // Sideshift's origin. Only overridden to point at a local mock in testing.
  SIDESHIFT_URL: z.preprocess(
    emptyToUndefined,
    urlNoTrailingSlash.default("https://app.sideshift.app")
  ),

  // Public self-serve sign up at /signup. Off unless set explicitly, and only
  // takes effect once email is configured, since a new owner has to confirm
  // their address before they can sign in.
  SIGNUP_ENABLED: z
    .preprocess(emptyToUndefined, z.enum(["true", "false"]).default("false"))
    .transform((value) => value === "true"),

  // First-boot super admin, created only when no super admin exists yet.
  SUPER_ADMIN_EMAIL: z.preprocess(
    emptyToUndefined,
    z.string().email().optional()
  ),
  SUPER_ADMIN_NAME: z.preprocess(emptyToUndefined, z.string().optional()),

  // Stripe subscriptions for the paid tiers. Live keys are refused outside
  // production so a test deployment cannot charge anyone.
  STRIPE_SECRET_KEY: z.preprocess(
    emptyToUndefined,
    z
      .string()
      .regex(
        /^(sk|rk)_(test|live)_[A-Za-z0-9]+$/,
        "STRIPE_SECRET_KEY does not look like a Stripe secret key"
      )
      .optional()
  ),
  STRIPE_PUBLISHABLE_KEY: z.preprocess(
    emptyToUndefined,
    z
      .string()
      .regex(
        /^pk_(test|live)_[A-Za-z0-9]+$/,
        "STRIPE_PUBLISHABLE_KEY does not look like a Stripe publishable key"
      )
      .optional()
  ),
  STRIPE_WEBHOOK_SECRET: z.preprocess(
    emptyToUndefined,
    z
      .string()
      .regex(
        /^whsec_[A-Za-z0-9]+$/,
        "STRIPE_WEBHOOK_SECRET does not look like a Stripe webhook secret"
      )
      .optional()
  ),
})

const parsed = schema.safeParse(process.env)

if (!parsed.success) {
  const issues = parsed.error.issues
    .map((issue) => `  - ${issue.path.join(".")}: ${issue.message}`)
    .join("\n")

  throw new Error(`Invalid environment configuration:\n${issues}`)
}

const raw = parsed.data

const stripeMode = raw.STRIPE_SECRET_KEY?.includes("_live_") ? "live" : "test"

if (stripeMode === "live" && raw.NODE_ENV !== "production") {
  throw new Error(
    "Invalid environment configuration:\n  - STRIPE_SECRET_KEY: a live key is only accepted when NODE_ENV=production"
  )
}

if (
  raw.STRIPE_PUBLISHABLE_KEY &&
  raw.STRIPE_SECRET_KEY &&
  raw.STRIPE_PUBLISHABLE_KEY.includes("_live_") !== (stripeMode === "live")
) {
  throw new Error(
    "Invalid environment configuration:\n  - STRIPE_PUBLISHABLE_KEY: must be from the same mode (test or live) as STRIPE_SECRET_KEY"
  )
}

const extraOrigins = (raw.CORS_ORIGINS ?? "")
  .split(",")
  .map((origin) => origin.trim().replace(/\/+$/, ""))
  .filter(Boolean)

export const env = {
  ...raw,
  isProduction: raw.NODE_ENV === "production",
  isDevelopment: raw.NODE_ENV === "development",
  rateLimitDisabled: raw.RATE_LIMIT_DISABLED && raw.NODE_ENV !== "production",
  /** Origins allowed to make credentialed requests against the panel API. */
  allowedOrigins: Array.from(new Set([raw.APP_URL, ...extraOrigins])),
  encryptionKey: Buffer.from(raw.ENCRYPTION_KEY, "base64"),
  cookiePrefix:
    raw.AUTH_COOKIE_PREFIX ??
    (raw.TENANT_SLUG && /^[a-z0-9-]+$/.test(raw.TENANT_SLUG)
      ? raw.TENANT_SLUG
      : "yak"),
  email: {
    configured: Boolean(
      raw.CLOUDFLARE_ACCOUNT_ID &&
      raw.CLOUDFLARE_EMAIL_API_TOKEN &&
      raw.EMAIL_FROM
    ),
    accountId: raw.CLOUDFLARE_ACCOUNT_ID,
    apiToken: raw.CLOUDFLARE_EMAIL_API_TOKEN,
    from: raw.EMAIL_FROM,
    fromName: raw.EMAIL_FROM_NAME ?? raw.APP_NAME,
  },
  r2: {
    configured: Boolean(
      raw.CLOUDFLARE_ACCOUNT_ID &&
      raw.R2_ACCESS_KEY_ID &&
      raw.R2_SECRET_ACCESS_KEY &&
      raw.R2_BUCKET
    ),
    accountId: raw.CLOUDFLARE_ACCOUNT_ID,
    accessKeyId: raw.R2_ACCESS_KEY_ID,
    secretAccessKey: raw.R2_SECRET_ACCESS_KEY,
    bucket: raw.R2_BUCKET,
    jurisdiction: raw.R2_JURISDICTION,
    urlTtlSeconds: raw.R2_URL_TTL,
  },
  stripe: {
    /** All three keys present. Billing code checks this before doing anything. */
    configured: Boolean(
      raw.STRIPE_SECRET_KEY &&
      raw.STRIPE_PUBLISHABLE_KEY &&
      raw.STRIPE_WEBHOOK_SECRET
    ),
    mode: stripeMode,
    secretKey: raw.STRIPE_SECRET_KEY,
    publishableKey: raw.STRIPE_PUBLISHABLE_KEY,
    webhookSecret: raw.STRIPE_WEBHOOK_SECRET,
  },
  /**
   * Whether /signup accepts new accounts: switched on, and able to send the
   * verification email a new owner needs before they can sign in. Outside
   * production the link is logged instead, so the flow can be tested locally.
   */
  signupEnabled:
    raw.SIGNUP_ENABLED &&
    (raw.NODE_ENV !== "production" ||
      Boolean(
        raw.CLOUDFLARE_ACCOUNT_ID &&
        raw.CLOUDFLARE_EMAIL_API_TOKEN &&
        raw.EMAIL_FROM
      )),
  /** Alias of `r2.configured` for boot logs that still say "images". */
  images: {
    configured: Boolean(
      raw.CLOUDFLARE_ACCOUNT_ID &&
      raw.R2_ACCESS_KEY_ID &&
      raw.R2_SECRET_ACCESS_KEY &&
      raw.R2_BUCKET
    ),
  },
} as const

export type Env = typeof env
