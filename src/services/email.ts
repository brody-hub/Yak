import { env } from "../env.js"
import { logger } from "../logger.js"

/**
 * Outbound transactional email via Cloudflare Email Service.
 * https://developers.cloudflare.com/email-service/api/send-emails/rest-api/
 */

const SEND_ENDPOINT = (accountId: string) =>
  `https://api.cloudflare.com/client/v4/accounts/${accountId}/email/sending/send`

type SendEmailInput = {
  to: string
  subject: string
  html: string
  text: string
  replyTo?: string
}

type CloudflareApiError = { code: number; message: string }

type CloudflareSendResponse = {
  success: boolean
  errors: CloudflareApiError[]
  result?: {
    delivered?: string[]
    permanent_bounces?: string[]
    queued?: string[]
    message_id?: string
  }
}

export async function sendEmail(input: SendEmailInput): Promise<boolean> {
  if (!env.email.configured) {
    // Local development without Cloudflare credentials: log the message so the
    // invite flow is still testable end to end.
    // The body is never logged: invites and resets carry credentials.
    logger.warn(
      { to: input.to, subject: input.subject },
      "Email service not configured - message not sent"
    )
    return false
  }

  const response = await fetch(SEND_ENDPOINT(env.email.accountId!), {
    method: "POST",
    headers: {
      Authorization: `Bearer ${env.email.apiToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      to: input.to,
      from: { address: env.email.from, name: env.email.fromName },
      subject: input.subject,
      html: input.html,
      text: input.text,
      ...(input.replyTo ? { reply_to: input.replyTo } : {}),
    }),
  })

  const payload = (await response
    .json()
    .catch(() => null)) as CloudflareSendResponse | null

  if (!response.ok || !payload?.success) {
    logger.error(
      {
        status: response.status,
        errors: payload?.errors,
        to: input.to,
        subject: input.subject,
      },
      "Cloudflare email send failed"
    )
    return false
  }

  if (payload.result?.permanent_bounces?.length) {
    logger.warn(
      { to: input.to, bounces: payload.result.permanent_bounces },
      "Email permanently bounced"
    )
    return false
  }

  logger.info(
    {
      to: input.to,
      subject: input.subject,
      messageId: payload.result?.message_id,
    },
    "Email sent"
  )
  return true
}

/* -------------------------------------------------------------------------- */
/* Templates                                                                   */
/* -------------------------------------------------------------------------- */

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;")
}

function layout(heading: string, bodyHtml: string): string {
  return `<!doctype html>
<html>
  <body style="margin:0;padding:24px;background:#f6f7f9;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;color:#111827;">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0">
      <tr>
        <td align="center">
          <table role="presentation" width="100%" style="max-width:520px;background:#ffffff;border-radius:12px;padding:32px;">
            <tr>
              <td>
                <h1 style="margin:0 0 16px;font-size:20px;font-weight:600;">${escapeHtml(heading)}</h1>
                ${bodyHtml}
                <p style="margin:32px 0 0;font-size:12px;color:#6b7280;">
                  ${escapeHtml(env.APP_NAME)}
                </p>
              </td>
            </tr>
          </table>
        </td>
      </tr>
    </table>
  </body>
</html>`
}

function button(href: string, label: string): string {
  return `<p style="margin:24px 0;">
    <a href="${escapeHtml(href)}" style="display:inline-block;background:#111827;color:#ffffff;text-decoration:none;padding:12px 20px;border-radius:8px;font-size:14px;font-weight:500;">${escapeHtml(label)}</a>
  </p>`
}

export async function sendInviteEmail(params: {
  to: string
  name: string
  temporaryPassword: string
  invitedByName: string
  /** The customer workspace they are joining, or the product for super admins. */
  workspaceName: string
}): Promise<boolean> {
  const loginUrl = `${env.APP_URL}/login`
  const tenant = params.workspaceName

  const html = layout(
    `You have been invited to ${tenant}`,
    `<p style="margin:0 0 12px;font-size:14px;line-height:1.6;">
       ${escapeHtml(params.invitedByName)} invited you to the ${escapeHtml(tenant)} admin panel.
     </p>
     <p style="margin:0 0 4px;font-size:14px;line-height:1.6;">Sign in with:</p>
     <p style="margin:0 0 4px;font-size:14px;"><strong>Email:</strong> ${escapeHtml(params.to)}</p>
     <p style="margin:0;font-size:14px;"><strong>Temporary password:</strong>
       <code style="background:#f3f4f6;padding:2px 6px;border-radius:4px;font-size:13px;">${escapeHtml(params.temporaryPassword)}</code>
     </p>
     ${button(loginUrl, "Sign in")}
     <p style="margin:0;font-size:13px;color:#6b7280;line-height:1.6;">
       You will be asked to choose a new password the first time you sign in.
       This temporary password stops working once you do.
     </p>`
  )

  const text = [
    `${params.invitedByName} invited you to the ${tenant} admin panel.`,
    ``,
    `Email: ${params.to}`,
    `Temporary password: ${params.temporaryPassword}`,
    ``,
    `Sign in: ${loginUrl}`,
    ``,
    `You will be asked to choose a new password the first time you sign in.`,
  ].join("\n")

  return sendEmail({
    to: params.to,
    subject: `You have been invited to ${tenant}`,
    html,
    text,
  })
}

export async function sendPasswordResetEmail(params: {
  to: string
  resetUrl: string
}): Promise<boolean> {
  const html = layout(
    "Reset your password",
    `<p style="margin:0 0 12px;font-size:14px;line-height:1.6;">
       We received a request to reset the password for this account.
       The link expires in one hour.
     </p>
     ${button(params.resetUrl, "Choose a new password")}
     <p style="margin:0;font-size:13px;color:#6b7280;line-height:1.6;">
       If you did not request this, you can ignore this email and your password
       will stay the same.
     </p>`
  )

  const text = [
    `Reset your ${env.APP_NAME} password.`,
    ``,
    params.resetUrl,
    ``,
    `The link expires in one hour. If you did not request this, ignore this email.`,
  ].join("\n")

  return sendEmail({
    to: params.to,
    subject: `Reset your ${env.APP_NAME} password`,
    html,
    text,
  })
}

export async function sendPasswordChangedEmail(params: {
  to: string
}): Promise<boolean> {
  const html = layout(
    "Your password was changed",
    `<p style="margin:0 0 12px;font-size:14px;line-height:1.6;">
       The password for your ${escapeHtml(env.APP_NAME)} account was just changed.
     </p>
     <p style="margin:0;font-size:13px;color:#6b7280;line-height:1.6;">
       If this was not you, contact an owner of this workspace immediately.
     </p>`
  )

  return sendEmail({
    to: params.to,
    subject: `Your ${env.APP_NAME} password was changed`,
    html,
    text: `The password for your ${env.APP_NAME} account was just changed. If this was not you, contact an owner immediately.`,
  })
}

/**
 * Tells a tenant's owners that Yak staff added someone to their account, so a
 * super admin can never quietly give themselves (or anyone) access.
 */
export async function sendStaffAddedUserNotice(params: {
  to: string
  workspaceName: string
  addedName: string
  addedEmail: string
  role: string
}): Promise<boolean> {
  const summary = `${env.APP_NAME} support added ${params.addedName} (${params.addedEmail}) to ${params.workspaceName} as ${params.role}.`

  const html = layout(
    `Someone was added to ${params.workspaceName}`,
    `<p style="margin:0 0 12px;font-size:14px;line-height:1.6;">${escapeHtml(summary)}</p>
     <p style="margin:0;font-size:13px;color:#6b7280;line-height:1.6;">
       If you did not ask for this, deactivate them under Settings, User
       management, and contact ${escapeHtml(env.APP_NAME)} support.
     </p>`
  )

  return sendEmail({
    to: params.to,
    subject: `Someone was added to ${params.workspaceName}`,
    html,
    text: `${summary}\n\nIf you did not ask for this, deactivate them under Settings > User management and contact ${env.APP_NAME} support.`,
  })
}

export async function sendVerifyEmail(params: {
  to: string
  name: string
  verifyUrl: string
}): Promise<boolean> {
  const html = layout(
    "Confirm your email",
    `<p style="margin:0 0 12px;font-size:14px;line-height:1.6;">
       Hi ${escapeHtml(params.name)}, thanks for signing up for
       ${escapeHtml(env.APP_NAME)}. Confirm this is your email address to
       finish setting up your account. The link expires in 24 hours.
     </p>
     ${button(params.verifyUrl, "Confirm email")}
     <p style="margin:0;font-size:13px;color:#6b7280;line-height:1.6;">
       If you did not sign up, you can ignore this email.
     </p>`
  )

  const text = [
    `Confirm your email to finish setting up your ${env.APP_NAME} account.`,
    ``,
    params.verifyUrl,
    ``,
    `The link expires in 24 hours. If you did not sign up, ignore this email.`,
  ].join("\n")

  return sendEmail({
    to: params.to,
    subject: `Confirm your email for ${env.APP_NAME}`,
    html,
    text,
  })
}
