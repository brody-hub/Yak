import { betterAuth } from "better-auth"
import { drizzleAdapter } from "better-auth/adapters/drizzle"
import { APIError } from "better-auth/api"
import { eq } from "drizzle-orm"

import { db } from "../db/index.js"
import * as schema from "../db/schema.js"
import { env } from "../env.js"
import { logger } from "../logger.js"
import {
  sendPasswordChangedEmail,
  sendFinishSignupEmail,
  sendPasswordResetEmail,
} from "../services/email.js"

const SESSION_TTL_SECONDS = 60 * 60 * 24 * 7
const SESSION_REFRESH_SECONDS = 60 * 60 * 24

export const auth = betterAuth({
  appName: env.APP_NAME,
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
    // Better Auth's own sign up knows nothing about tenants. Accounts are
    // created by /api/signup (a new owner with their account), a super admin
    // (/api/admin), or a tenant's owner or admin (/api/system-users).
    disableSignUp: true,
    // Only sign ups start unverified, and they have no password until the
    // emailed link sets one, which verifies them. Belt and braces.
    requireEmailVerification: true,
    minPasswordLength: 12,
    maxPasswordLength: 128,
    resetPasswordTokenExpiresIn: 60 * 60,
    // A password reset is the remediation for a compromised account, so every
    // other session for that user has to die with it.
    revokeSessionsOnPasswordReset: true,
    sendResetPassword: async ({ user, token }) => {
      const resetUrl = `${env.APP_URL}/reset-password?token=${encodeURIComponent(token)}`

      // A sign up that has not set its password yet: the same link, worded as
      // the last step of creating the account.
      if (!user.emailVerified) {
        const sent = await sendFinishSignupEmail({
          to: user.email,
          name: user.name,
          setPasswordUrl: `${resetUrl}&welcome=1`,
        })

        if (!sent && !env.email.configured && !env.isProduction) {
          // Local development only: there is no inbox to click through.
          logger.info({ to: user.email, resetUrl }, "Sign up password link")
        }
        return
      }

      await sendPasswordResetEmail({ to: user.email, resetUrl })
    },
    onPasswordReset: async ({ user }) => {
      // Completing a reset satisfies the forced-change requirement that an
      // invite puts on the account, and proves the email belongs to whoever
      // set the password, which is what verifies a sign up.
      await db
        .update(schema.user)
        .set({
          mustChangePassword: false,
          emailVerified: true,
          updatedAt: new Date(),
        })
        .where(eq(schema.user.id, user.id))

      await sendPasswordChangedEmail({ to: user.email }).catch((error) => {
        logger.warn({ err: error }, "Password change notification failed")
      })
    },
  },

  user: {
    additionalFields: {
      // None of these can be set through a Better Auth endpoint (`input:
      // false`); only our own tenant-aware routes write them.
      //
      // Which customer the account belongs to. Null only for super admins.
      tenantId: { type: "string", required: false, input: false },
      role: { type: "string", required: false, defaultValue: "member", input: false },
      banned: { type: "boolean", required: false, defaultValue: false, input: false },
      banReason: { type: "string", required: false, input: false },
      banExpires: { type: "date", required: false, input: false },
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
    cookiePrefix: env.cookiePrefix,
    ipAddress: {
      // Set by betterAuthHandler from Express's proxy-aware `req.ip`; any
      // client-supplied value is discarded before Better Auth sees it.
      ipAddressHeaders: ["x-forwarded-for"],
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
        // A deactivated account cannot start a session. (requireAuth also
        // refuses banned users on every request, so this only keeps a dead
        // session from being issued in the first place.)
        before: async (newSession) => {
          const [row] = await db
            .select({ banned: schema.user.banned })
            .from(schema.user)
            .where(eq(schema.user.id, newSession.userId))
            .limit(1)

          if (!row || row.banned) {
            throw new APIError("FORBIDDEN", {
              message: "This account has been deactivated",
            })
          }
        },
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
})

export type Auth = typeof auth
