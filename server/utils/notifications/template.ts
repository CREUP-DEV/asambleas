/**
 * The email template, drawn like the platform: Raleway (the UI font, from
 * /fonts/raleway, where the client loads web fonts; a system sans-serif
 * elsewhere), Nuxt UI's slate neutrals, CREUP's burgundy (`creup-red-900`)
 * for the primary button and the accents, cards with a thin border and
 * rounded corners, and the assembly as a badge. Tables and inline styles,
 * because that is what mail clients read; the few rules in <style> only add
 * the font and the phone layout. Every value is escaped here: callers pass
 * plain text, never HTML. Spanish only, like the web's transactional emails.
 */

/** The platform's tokens (main.css, Nuxt UI's slate). */
export const EMAIL_COLORS = {
  /** `--ui-bg-muted`: the page around the card. */
  page: "#f1f5f9",
  card: "#ffffff",
  /** `--ui-border`. */
  border: "#e2e8f0",
  /** Rows inside a card. */
  divider: "#f1f5f9",
  /** `--ui-text-highlighted`. */
  highlighted: "#0f172a",
  /** `--ui-text`. */
  text: "#334155",
  /** `--ui-text-muted`. */
  muted: "#64748b",
  /** `--ui-primary`, creup-red-900. */
  primary: "#792225",
  /** creup-red-50 and 200: the primary's subtle badge and note. */
  primaryTint: "#fdf3f3",
  primaryBorder: "#fbcdcf",
  white: "#ffffff",
} as const;

const FONT =
  "Raleway, 'Segoe UI', -apple-system, BlinkMacSystemFont, Roboto, Helvetica, Arial, sans-serif; font-feature-settings:'lnum'";

/** The logo at the top of the card, a light PNG (Gmail shows no SVG). */
export const EMAIL_LOGO_PATH = "/marca/correo-cabecera.png";
/** Its width on screen; the file is three times as wide. */
const LOGO_WIDTH = 160;
const LOGO_HEIGHT = 59;

export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/** Line breaks of a plain text kept in HTML. */
function multiline(value: string): string {
  return escapeHtml(value).replace(/\r?\n/g, "<br />");
}

export interface EmailDetail {
  label: string;
  value: string;
}

/** One notice: what an email says, before it is laid out. */
export interface EmailNotice {
  /**
   * The assembly it is about ("80.ª AGO"): a badge at the top of the
   * email, and in brackets before the subject so the inbox tells
   * assemblies apart; null for a test email.
   */
  tag: string | null;
  /** The subject without the tag. */
  subject: string;
  heading: string;
  /** The first sentence, also the inbox preview. */
  lead: string;
  details: EmailDetail[];
  /** A text someone wrote for the recipient (a correction note). */
  note: { label: string; text: string } | null;
  action: { label: string; url: string };
}

export interface RenderedEmail {
  subject: string;
  html: string;
  text: string;
}

export interface EmailFrame {
  origin: string;
  /** Why the recipient gets it, a full sentence. */
  reason: string;
}

function uniqueTags(notices: EmailNotice[]): string[] {
  return [
    ...new Set(
      notices
        .map((notice) => notice.tag)
        .filter((tag): tag is string => Boolean(tag)),
    ),
  ];
}

/** "[80.ª AGO] Subject": the tags of the notices it carries, each once. */
function tagged(subject: string, notices: EmailNotice[]): string {
  const tags = uniqueTags(notices);
  return tags.length > 0 ? `[${tags.join(", ")}] ${subject}` : subject;
}

// Pieces ------------------------------------------------------------------------

function badge(label: string): string {
  return `<span style="display:inline-block; padding:3px 9px; border:1px solid ${EMAIL_COLORS.primaryBorder}; border-radius:6px; background:${EMAIL_COLORS.primaryTint}; color:${EMAIL_COLORS.primary}; font-family:${FONT}; font-size:12px; line-height:16px; font-weight:700; white-space:nowrap;">${escapeHtml(label)}</span>`;
}

/** Nuxt UI's solid primary button, made of a table so Outlook keeps it. */
function button(url: string, label: string): string {
  return `<table role="presentation" cellspacing="0" cellpadding="0" border="0">
                      <tr>
                        <td style="border-radius:6px; background:${EMAIL_COLORS.primary};">
                          <a href="${escapeHtml(url)}" class="cx-button" style="display:inline-block; padding:11px 20px; border-radius:6px; background:${EMAIL_COLORS.primary}; color:${EMAIL_COLORS.white}; font-family:${FONT}; font-size:15px; line-height:20px; font-weight:700; text-decoration:none;">${escapeHtml(label)}</a>
                        </td>
                      </tr>
                    </table>`;
}

/** A plain link with an arrow, for the notices of a summary. */
function textLink(url: string, label: string): string {
  return `<a href="${escapeHtml(url)}" style="color:${EMAIL_COLORS.primary}; font-family:${FONT}; font-size:14px; line-height:20px; font-weight:700; text-decoration:none;">${escapeHtml(label)}&nbsp;&rarr;</a>`;
}

/** The details as a description list: label on the left, value on the right. */
function detailsTable(details: EmailDetail[]): string {
  if (details.length === 0) return "";
  const rows = details
    .map(
      (detail, index) => `<tr>
                        <td valign="top" class="cx-detail-label" style="width:112px; padding:9px 12px 9px 14px; ${index > 0 ? `border-top:1px solid ${EMAIL_COLORS.divider};` : ""} font-family:${FONT}; font-size:13px; line-height:19px; color:${EMAIL_COLORS.muted};">${escapeHtml(detail.label)}</td>
                        <td valign="top" style="padding:9px 14px 9px 0; ${index > 0 ? `border-top:1px solid ${EMAIL_COLORS.divider};` : ""} font-family:${FONT}; font-size:14px; line-height:19px; color:${EMAIL_COLORS.highlighted};">${multiline(detail.value)}</td>
                      </tr>`,
    )
    .join("");
  return `<table role="presentation" cellspacing="0" cellpadding="0" border="0" width="100%" style="margin:20px 0 0 0; border:1px solid ${EMAIL_COLORS.border}; border-radius:8px; border-collapse:separate;">${rows}</table>`;
}

/**
 * A note someone wrote for the recipient. Its text stays neutral and the
 * colour goes on the border and the tint, as the platform's boxes do
 * (AGENTS.md, status boxes).
 */
function noteBlock(note: EmailNotice["note"]): string {
  if (!note) return "";
  return `<table role="presentation" cellspacing="0" cellpadding="0" border="0" width="100%" style="margin:16px 0 0 0; border-collapse:separate;">
                      <tr>
                        <td style="padding:12px 14px; border:1px solid ${EMAIL_COLORS.primaryBorder}; border-left:3px solid ${EMAIL_COLORS.primary}; border-radius:6px; background:${EMAIL_COLORS.primaryTint}; font-family:${FONT}; font-size:14px; line-height:21px; color:${EMAIL_COLORS.text};">
                          <strong style="color:${EMAIL_COLORS.highlighted};">${escapeHtml(note.label)}</strong><br />${multiline(note.text)}
                        </td>
                      </tr>
                    </table>`;
}

function heading(text: string, size: "page" | "item"): string {
  const font =
    size === "page"
      ? "font-size:22px; line-height:29px;"
      : "font-size:17px; line-height:24px;";
  return `<h${size === "page" ? 1 : 2} style="margin:0 0 8px 0; font-family:${FONT}; ${font} font-weight:700; color:${EMAIL_COLORS.highlighted};">${escapeHtml(text)}</h${size === "page" ? 1 : 2}>`;
}

function lead(text: string): string {
  return `<p style="margin:0; font-family:${FONT}; font-size:15px; line-height:24px; color:${EMAIL_COLORS.text};">${escapeHtml(text)}</p>`;
}

// Layout ------------------------------------------------------------------------

function layout(input: {
  title: string;
  preheader: string;
  tags: string[];
  body: string;
  frame: EmailFrame;
}): string {
  const { origin, reason } = input.frame;
  const fonts = `${origin}/fonts/raleway`;
  const badges = input.tags.map(badge).join("&nbsp;");
  return `<!DOCTYPE html>
<html lang="es-ES">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <meta name="color-scheme" content="light" />
  <meta name="supported-color-schemes" content="light" />
  <title>${escapeHtml(input.title)}</title>
  <style>
    @font-face { font-family: "Raleway"; font-style: normal; font-weight: 400; src: url("${escapeHtml(fonts)}/Raleway-Regular.woff") format("woff"); }
    @font-face { font-family: "Raleway"; font-style: normal; font-weight: 700; src: url("${escapeHtml(fonts)}/Raleway-Bold.woff") format("woff"); }
    /* Raleway's default old-style figures read "80.ª" as "8o.ª" (main.css). */
    body, table, td, a, span, h1, h2, p { font-feature-settings: "lnum"; }
    @media (max-width: 520px) {
      .cx-outer { padding: 12px 8px !important; }
      .cx-pad { padding-left: 20px !important; padding-right: 20px !important; }
      .cx-detail-label { width: 88px !important; }
      .cx-button { display: block !important; text-align: center !important; }
    }
  </style>
</head>
<body style="margin:0; padding:0; background-color:${EMAIL_COLORS.page};">
  <div style="display:none; font-size:1px; color:${EMAIL_COLORS.page}; line-height:1px; max-height:0; max-width:0; opacity:0; overflow:hidden;">${escapeHtml(input.preheader)}</div>
  <table role="presentation" cellspacing="0" cellpadding="0" border="0" width="100%" bgcolor="${EMAIL_COLORS.page}" style="background-color:${EMAIL_COLORS.page};">
    <tr>
      <td align="center" class="cx-outer" style="padding:32px 16px;">
        <table role="presentation" cellspacing="0" cellpadding="0" border="0" width="100%" style="max-width:600px;">
          <tr>
            <td style="background:${EMAIL_COLORS.card}; border:1px solid ${EMAIL_COLORS.border}; border-radius:12px;">
              <table role="presentation" cellspacing="0" cellpadding="0" border="0" width="100%">
                <tr>
                  <td class="cx-pad" style="padding:22px 32px 18px 32px; border-bottom:1px solid ${EMAIL_COLORS.border};">
                    <table role="presentation" cellspacing="0" cellpadding="0" border="0" width="100%">
                      <tr>
                        <td valign="middle">
                          <a href="${escapeHtml(origin)}" style="text-decoration:none;"><img src="${escapeHtml(origin)}${EMAIL_LOGO_PATH}" alt="CREUP" width="${LOGO_WIDTH}" height="${LOGO_HEIGHT}" style="display:block; width:${LOGO_WIDTH}px; height:auto; border:0;" /></a>
                        </td>
                        <td valign="middle" align="right">${badges}</td>
                      </tr>
                    </table>
                  </td>
                </tr>
                ${input.body}
              </table>
            </td>
          </tr>
          <tr>
            <td align="center" style="padding:20px 24px 0 24px; font-family:${FONT}; font-size:12px; line-height:18px; color:${EMAIL_COLORS.muted};">
              ${escapeHtml(reason)}<br />
              Los avisos por correo los configura la Secretaría en la <a href="${escapeHtml(origin)}" style="color:${EMAIL_COLORS.primary}; text-decoration:underline;">plataforma de asambleas</a> de CREUP.
            </td>
          </tr>
        </table>
      </td>
    </tr>
  </table>
</body>
</html>`;
}

function noticeText(notice: EmailNotice): string[] {
  const lines = [notice.lead, ""];
  if (notice.tag) lines.push(`Asamblea: ${notice.tag}`);
  for (const detail of notice.details) {
    lines.push(`${detail.label}: ${detail.value}`);
  }
  if (notice.note) {
    lines.push("", `${notice.note.label}:`, notice.note.text);
  }
  lines.push("", `${notice.action.label}: ${notice.action.url}`);
  return lines;
}

function footerText(frame: EmailFrame): string[] {
  return [
    "",
    "--",
    frame.reason,
    `Los avisos por correo los configura la Secretaría en la plataforma de asambleas de CREUP: ${frame.origin}`,
  ];
}

/** One notice in one email. */
export function renderNoticeEmail(
  notice: EmailNotice,
  frame: EmailFrame,
): RenderedEmail {
  const subject = tagged(notice.subject, [notice]);
  const body = `<tr>
                  <td class="cx-pad" style="padding:28px 32px 32px 32px;">
                    ${heading(notice.heading, "page")}
                    ${lead(notice.lead)}
                    ${detailsTable(notice.details)}
                    ${noteBlock(notice.note)}
                    <div style="height:24px; line-height:24px; font-size:1px;">&nbsp;</div>
                    ${button(notice.action.url, notice.action.label)}
                  </td>
                </tr>`;
  return {
    subject,
    html: layout({
      title: subject,
      preheader: notice.lead,
      tags: uniqueTags([notice]),
      body,
      frame,
    }),
    text: [notice.heading, "", ...noticeText(notice), ...footerText(frame)]
      .join("\n")
      .concat("\n"),
  };
}

/**
 * The daily summary: several notices in one email, oldest first, each a
 * block with a link instead of a button so a long day still reads as a
 * list. With notices of several assemblies, each says its own.
 */
export function renderDigestEmail(
  notices: EmailNotice[],
  frame: EmailFrame,
): RenderedEmail {
  const count = notices.length;
  const subject = tagged(
    count === 1
      ? `Resumen de avisos: ${notices[0]!.subject}`
      : `Resumen de avisos: ${count} novedades en la plataforma de asambleas`,
    notices,
  );
  const tags = uniqueTags(notices);
  const several = tags.length > 1;
  const items = notices
    .map(
      (notice) => `<tr>
                  <td class="cx-pad" style="padding:22px 32px; border-top:1px solid ${EMAIL_COLORS.border};">
                    ${several && notice.tag ? `<div style="margin:0 0 8px 0;">${badge(notice.tag)}</div>` : ""}
                    ${heading(notice.heading, "item")}
                    ${lead(notice.lead)}
                    ${detailsTable(notice.details)}
                    ${noteBlock(notice.note)}
                    <div style="height:14px; line-height:14px; font-size:1px;">&nbsp;</div>
                    ${textLink(notice.action.url, notice.action.label)}
                  </td>
                </tr>`,
    )
    .join("\n");
  const intro = `<tr>
                  <td class="cx-pad" style="padding:28px 32px 24px 32px;">
                    ${heading("Resumen de avisos", "page")}
                    ${lead(count === 1 ? "Esto es lo que ha pasado en la plataforma de asambleas desde el último resumen." : `Tienes ${count} avisos de la plataforma de asambleas desde el último resumen.`)}
                  </td>
                </tr>`;
  const text: string[] = ["Resumen de avisos"];
  for (const notice of notices) {
    text.push("", "==========", notice.heading, "", ...noticeText(notice));
  }
  return {
    subject,
    html: layout({
      title: subject,
      preheader: notices.map((notice) => notice.heading).join(" · "),
      tags,
      body: `${intro}\n${items}`,
      frame,
    }),
    text: [...text, ...footerText(frame)].join("\n").concat("\n"),
  };
}
