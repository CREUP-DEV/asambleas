import nodemailer from "nodemailer";
import type { Transporter } from "nodemailer";
import { getOptionalConfigUrl } from "~~/shared/utils/config";
import { logError, logInfo } from "../core/logger";

/**
 * The SMTP transport of the email notifications, like the web's
 * (creup/web, server/utils/email/smtpTransporter.ts): one pooled
 * transporter, rebuilt when the configuration changes. Locally it points at
 * Mailpit (docker-compose.yml); in production at the VPS's mail server
 * (DEPLOYMENT.md, "Correo"). Without NUXT_SMTP_HOST or NUXT_SMTP_FROM_EMAIL
 * nothing is sent: the deliveries are skipped as `unconfigured`.
 */

export interface SmtpConfig {
  host: string;
  port: number;
  secure: boolean;
  user: string | null;
  pass: string | null;
  fromEmail: string;
  fromName: string;
}

const DEFAULT_FROM_NAME = "CREUP Asambleas";

function text(value: string | undefined): string | null {
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
}

/** The SMTP configuration from the environment, or null while incomplete. */
export function readSmtpConfig(
  env: NodeJS.ProcessEnv = process.env,
): SmtpConfig | null {
  const host = text(env.NUXT_SMTP_HOST);
  const fromEmail = text(env.NUXT_SMTP_FROM_EMAIL);
  if (!host || !fromEmail) return null;
  const secure = text(env.NUXT_SMTP_SECURE)?.toLowerCase() === "true";
  const port = Number.parseInt(text(env.NUXT_SMTP_PORT) ?? "", 10);
  return {
    host,
    port: Number.isInteger(port) && port > 0 ? port : secure ? 465 : 587,
    secure,
    user: text(env.NUXT_SMTP_USER),
    pass: text(env.NUXT_SMTP_PASS),
    fromEmail,
    // A quote would break the From header.
    fromName: (text(env.NUXT_SMTP_FROM_NAME) ?? DEFAULT_FROM_NAME).replace(
      /["\r\n]/g,
      "",
    ),
  };
}

/** The platform's public origin, for the links and the banner. */
export function siteOrigin(): string {
  return (
    getOptionalConfigUrl(process.env.NUXT_SITE_URL, "NUXT_SITE_URL") ||
    "http://localhost:3000"
  ).replace(/\/+$/, "");
}

let cached: { key: string; transporter: Transporter } | null = null;

function transporterFor(config: SmtpConfig): Transporter {
  const key = JSON.stringify([
    config.host,
    config.port,
    config.secure,
    config.user,
    config.pass,
  ]);
  if (cached?.key === key) return cached.transporter;
  cached?.transporter.close();
  const transporter = nodemailer.createTransport({
    host: config.host,
    port: config.port,
    secure: config.secure,
    ...(config.user && config.pass
      ? { auth: { user: config.user, pass: config.pass } }
      : {}),
    connectionTimeout: 10_000,
    greetingTimeout: 10_000,
    socketTimeout: 30_000,
    pool: true,
    maxConnections: 2,
    maxMessages: 100,
  });
  cached = { key, transporter };
  logInfo("email.transport", { host: config.host, port: config.port });
  return transporter;
}

export interface OutgoingEmail {
  to: string;
  subject: string;
  html: string;
  text: string;
  /** A stable id, so a retried send reads as the same message. */
  messageId?: string;
}

/** Sends one email. Throws what the SMTP server answered. */
export async function sendEmail(
  config: SmtpConfig,
  email: OutgoingEmail,
): Promise<void> {
  await transporterFor(config).sendMail({
    from: { name: config.fromName, address: config.fromEmail },
    to: email.to,
    subject: email.subject,
    html: email.html,
    text: email.text,
    ...(email.messageId ? { messageId: email.messageId } : {}),
    headers: { "Auto-Submitted": "auto-generated" },
  });
}

/** Closes the pool on shutdown. */
export function closeMailer(): void {
  cached?.transporter.close();
  cached = null;
}

/**
 * An SMTP error for the log: its first line, without addresses, shortened.
 * Never the whole object, which can carry the envelope.
 */
export function describeSmtpError(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error);
  return raw
    .split("\n")[0]!
    .replace(/[^\s<>@]+@[^\s<>@]+/g, "[address]")
    .slice(0, 300);
}

export function logMailerError(scope: string, error: unknown): void {
  logError(scope, new Error(describeSmtpError(error)));
}
