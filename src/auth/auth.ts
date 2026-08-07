import { betterAuth } from "better-auth"
import { drizzleAdapter } from "better-auth/adapters/drizzle"
import { admin as adminPlugin } from "better-auth/plugins"
import { eq } from "drizzle-orm"

import { db } from "../db/index.js"
import * as schema from "../db/schema.js"
import { env } from "../env.js"
import { logger } from "../logger.js"
import {
  sendPasswordChangedEmail,
  sendPasswordResetEmail,
} from "../services/email.js"

const SESSION_TTL_SECONDS = 60 * 60 * 24 * 7
const SESSION_REFRESH_SECONDS = 60 * 60 * 24

export const auth = betterAuth({
  appName: env.TENANT_NAME,
  baseURL: env.API_URL,
  basePath: "/api/auth",
  secret: env.BETTER_AUTH_SECRET,
  trustedOrigins: env.allowedOrigins,

  database: drizzleAdapter(db, {
    provider: "pg",
    schema: {
      user: schema.user,
      session: schema.session,
      account: schema.account,
      verification: schema.verification,
    },
  }),

  emailAndPassword: {
    enabled: true,
    // This panel is invite only. Accounts are created by an owner or admin
    // through POST /api/system-users, never by the person signing in.
    disableSignUp: true,
    requireEmailVerification: false,
    minPasswordLength: 12,
    maxPasswordLength: 128,
    resetPasswordTokenExpiresIn: 60 * 60,
    // A password reset is the remediation for a compromised account, so every
    // other session for that user has to die with it.
    revokeSessionsOnPasswordReset: true,
    sendResetPassword: async ({ user, token }) => {
      await sendPasswordResetEmail({
        to: user.email,
        resetUrl: `${env.APP_URL}/reset-password?token=${encodeURIComponent(token)}`,
      })
    },
    onPasswordReset: async ({ user }) => {
      // Completing a reset satisfies the forced-change requirement that an
      // invite puts on the account.
      await db
        .update(schema.user)
        .set({ mustChangePassword: false, updatedAt: new Date() })
        .where(eq(schema.user.id, user.id))

      await sendPasswordChangedEmail({ to: user.email }).catch((error) => {
        logger.warn({ err: error }, "Password change notification failed")
      })
    },
  },

  user: {
    additionalFields: {
      permissions: {
        type: "string[]",
        required: false,
        defaultValue: [],
        // Never settable through a Better Auth endpoint; only our own
        // permission-checked routes may change it.
        input: false,
      },
      mustChangePassword: {
        type: "boolean",
        required: false,
        defaultValue: false,
        input: false,
      },
      avatarImageId: { type: "string", required: false, input: false },
      invitedByUserId: { type: "string", required: false, input: false },
      invitedAt: { type: "date", required: false, input: false },
      lastLoginAt: { type: "date", required: false, input: false },
    },
  },

  session: {
    expiresIn: SESSION_TTL_SECONDS,
    updateAge: SESSION_REFRESH_SECONDS,
    // Sensitive operations require a session established in the last 15
    // minutes rather than a week-old cookie.
    freshAge: 60 * 15,
    // Sessions are read from the database on every request so that revoking
    // access or changing permissions takes effect immediately instead of
    // after a cached cookie expires.
    cookieCache: { enabled: false },
  },

  advanced: {
    // The panel and this API are served from different hosts on Railway, so
    // the session cookie has to be cross-site in production.
    useSecureCookies: env.isProduction,
    defaultCookieAttributes: {
      httpOnly: true,
      sameSite: env.isProduction ? "none" : "lax",
      secure: env.isProduction,
      partitioned: env.isProduction,
    },
    cookiePrefix: env.TENANT_SLUG,
    ipAddress: {
      // Railway terminates TLS at its edge proxy.
      ipAddressHeaders: ["x-forwarded-for", "x-real-ip"],
    },
  },

  rateLimit: {
    enabled: true,
    window: 60,
    max: 60,
    customRules: {
      "/sign-in/email": { window: 300, max: 10 },
      "/request-password-reset": { window: 600, max: 5 },
      "/reset-password": { window: 600, max: 10 },
      "/change-password": { window: 600, max: 10 },
    },
  },

  databaseHooks: {
    session: {
      create: {
        after: async (createdSession) => {
          await db
            .update(schema.user)
            .set({ lastLoginAt: new Date() })
            .where(eq(schema.user.id, createdSession.userId))
            .catch((error: unknown) => {
              logger.warn({ err: error }, "Could not record last login")
            })
        },
      },
    },
  },

  plugins: [
    adminPlugin({
      defaultRole: "member",
      adminRoles: ["owner", "admin"],
    }),
  ],
})

export type Auth = typeof auth
