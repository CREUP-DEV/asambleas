/**
 * The email template: CREUP's, as the web sends it (creup/web,
 * server/utils/email/emailTemplates.ts), with tables and inline styles
 * because that is what mail clients read. Grey background, the heading in
 * Georgia, a white card under a burgundy line, a burgundy button and the
 * brand banner at the foot. Every value is escaped here: callers pass plain
 * text, never HTML. Spanish only, like the web's transactional emails.
 */

export const EMAIL_COLORS = {
  background: "#eaeaea",
  body: "#2c2c2c",
  brand: "#792225",
  muted: "#555555",
  subtle: "#767676",
  divider: "#eeeeee",
  noteBackground: "#f6f1f1",
  white: "#ffffff",
} as const;

const FONTS = {
  body: "Arial, Helvetica, sans-serif",
  heading: "Georgia, 'Times New Roman', serif",
} as const;

/** The banner under the card, a PNG (Gmail shows no SVG). */
export const EMAIL_BANNER_PATH = "/marca/horizontal-completo-granate.png";

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
   * The assembly it is about ("80.ª AGO"), put in brackets before the
   * subject so the inbox tells assemblies apart; null for a test email.
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

function layout(input: {
  title: string;
  heading: string;
  preheader: string;
  rows: string;
  origin: string;
  reason: string;
}): string {
  const banner = `${input.origin}${EMAIL_BANNER_PATH}`;
  return `<!DOCTYPE html>
<html lang="es-ES">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <meta name="color-scheme" content="light" />
  <title>${escapeHtml(input.title)}</title>
</head>
<body style="margin:0; padding:0; background-color:${EMAIL_COLORS.background};">
  <div style="display:none; font-size:1px; color:${EMAIL_COLORS.background}; line-height:1px; max-height:0; max-width:0; opacity:0; overflow:hidden;">${escapeHtml(input.preheader)}</div>
  <table role="presentation" cellspacing="0" cellpadding="0" border="0" width="100%" bgcolor="${EMAIL_COLORS.background}">
    <tr>
      <td align="center" style="padding:16px;">
        <table role="presentation" cellspacing="0" cellpadding="0" border="0" width="100%" style="max-width:640px;">
          <tr>
            <td align="center" style="padding:20px 8px 12px 8px;">
              <h1 style="margin:0; font-size:26px; line-height:34px; font-weight:700; font-family:${FONTS.heading}; color:${EMAIL_COLORS.body};">${escapeHtml(input.heading)}</h1>
            </td>
          </tr>
          <tr>
            <td style="padding:0 8px 8px 8px;">
              <table role="presentation" cellspacing="0" cellpadding="0" border="0" width="100%" style="background:${EMAIL_COLORS.white}; border-top:4px solid ${EMAIL_COLORS.brand}; border-top-left-radius:5px; border-top-right-radius:5px;">
                ${input.rows}
                ${dividerRow()}
                <tr>
                  <td style="padding:12px 20px 18px 20px; font-family:${FONTS.body}; font-size:12px; line-height:18px; color:${EMAIL_COLORS.subtle}; text-align:center;">
                    ${escapeHtml(input.reason)}
                    <br />
                    Los avisos por correo los configura la Secretaría en la <a href="${escapeHtml(input.origin)}" style="color:${EMAIL_COLORS.brand}; text-decoration:none;">plataforma de asambleas</a>.
                  </td>
                </tr>
              </table>
            </td>
          </tr>
          <tr>
            <td align="center" style="padding:8px 8px 20px 8px;">
              <img src="${escapeHtml(banner)}" alt="CREUP" width="320" style="display:block; width:320px; max-width:60%; height:auto; margin:0 auto;" />
            </td>
          </tr>
        </table>
      </td>
    </tr>
  </table>
</body>
</html>`;
}

function dividerRow(padding = "0 20px"): string {
  return `<tr>
                  <td style="padding:${padding};">
                    <hr style="border:none; border-top:1px solid ${EMAIL_COLORS.divider}; margin:0;" />
                  </td>
                </tr>`;
}

function button(url: string, label: string): string {
  return `<a href="${escapeHtml(url)}" style="display:inline-block; padding:12px 28px; background-color:${EMAIL_COLORS.brand}; color:${EMAIL_COLORS.white}; font-family:${FONTS.body}; font-size:15px; font-weight:700; text-decoration:none; border-radius:6px;">${escapeHtml(label)}</a>`;
}

function detailsTable(details: EmailDetail[]): string {
  if (details.length === 0) return "";
  const rows = details
    .map(
      (detail) => `<tr>
                        <td valign="top" style="padding:4px 12px 4px 0; font-family:${FONTS.body}; font-size:14px; line-height:20px; color:${EMAIL_COLORS.muted}; white-space:nowrap;">${escapeHtml(detail.label)}</td>
                        <td valign="top" style="padding:4px 0; font-family:${FONTS.body}; font-size:14px; line-height:20px; color:${EMAIL_COLORS.body};">${multiline(detail.value)}</td>
                      </tr>`,
    )
    .join("");
  return `<table role="presentation" cellspacing="0" cellpadding="0" border="0" style="margin:0 0 4px 0;">${rows}</table>`;
}

function noteBlock(note: EmailNotice["note"]): string {
  if (!note) return "";
  return `<table role="presentation" cellspacing="0" cellpadding="0" border="0" width="100%" style="margin:16px 0 0 0;">
                      <tr>
                        <td style="padding:12px 14px; background:${EMAIL_COLORS.noteBackground}; border-left:3px solid ${EMAIL_COLORS.brand}; font-family:${FONTS.body}; font-size:14px; line-height:21px; color:${EMAIL_COLORS.body};">
                          <strong>${escapeHtml(note.label)}</strong><br />${multiline(note.text)}
                        </td>
                      </tr>
                    </table>`;
}

function noticeRows(notice: EmailNotice, headingSize: "lead" | "item"): string {
  const title =
    headingSize === "item"
      ? `<p style="margin:0 0 6px 0; font-family:${FONTS.heading}; font-size:18px; line-height:25px; font-weight:700; color:${EMAIL_COLORS.body};">${escapeHtml(notice.heading)}</p>`
      : "";
  return `<tr>
                  <td style="padding:20px 20px 4px 20px;">
                    ${title}
                    <p style="margin:0 0 14px 0; font-family:${FONTS.body}; font-size:16px; line-height:24px; color:${EMAIL_COLORS.body};">${escapeHtml(notice.lead)}</p>
                    ${detailsTable(notice.details)}
                    ${noteBlock(notice.note)}
                  </td>
                </tr>
                <tr>
                  <td style="padding:16px 20px 22px 20px;">
                    ${button(notice.action.url, notice.action.label)}
                  </td>
                </tr>`;
}

function noticeText(notice: EmailNotice): string[] {
  const lines = [notice.lead, ""];
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
    `Los avisos por correo los configura la Secretaría en la plataforma de asambleas: ${frame.origin}`,
  ];
}

/** "[80.ª AGO] Subject": the tags of the notices it carries, each once. */
function tagged(subject: string, notices: EmailNotice[]): string {
  const tags = [
    ...new Set(
      notices
        .map((notice) => notice.tag)
        .filter((tag): tag is string => Boolean(tag)),
    ),
  ];
  return tags.length > 0 ? `[${tags.join(", ")}] ${subject}` : subject;
}

/** One notice in one email. */
export function renderNoticeEmail(
  notice: EmailNotice,
  frame: EmailFrame,
): RenderedEmail {
  const subject = tagged(notice.subject, [notice]);
  return {
    subject,
    html: layout({
      title: subject,
      heading: notice.heading,
      preheader: notice.lead,
      rows: noticeRows(notice, "lead"),
      origin: frame.origin,
      reason: frame.reason,
    }),
    text: [notice.heading, "", ...noticeText(notice), ...footerText(frame)]
      .join("\n")
      .concat("\n"),
  };
}

/** The daily summary: several notices in one email, oldest first. */
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
  const heading = count === 1 ? "Resumen de avisos" : `${count} avisos`;
  const rows = notices
    .map((notice, index) =>
      [index > 0 ? dividerRow() : "", noticeRows(notice, "item")].join("\n"),
    )
    .join("\n");
  const text: string[] = [heading];
  for (const notice of notices) {
    text.push("", "==========", notice.heading, "", ...noticeText(notice));
  }
  return {
    subject,
    html: layout({
      title: subject,
      heading,
      preheader: notices.map((notice) => notice.heading).join(" · "),
      rows,
      origin: frame.origin,
      reason: frame.reason,
    }),
    text: [...text, ...footerText(frame)].join("\n").concat("\n"),
  };
}
