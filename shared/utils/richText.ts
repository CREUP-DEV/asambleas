export const RICH_TEXT_MAX_HTML_LENGTH = 200_000;
export const RICH_TEXT_ALLOWED_TAGS = [
  "p",
  "br",
  "strong",
  "em",
  "u",
  "s",
  "h1",
  "h2",
  "h3",
  "ul",
  "ol",
  "li",
  "a",
  "blockquote",
  "hr",
  "code",
  "pre",
] as const;
export const RICH_TEXT_ALLOWED_ATTR = ["href", "target", "rel"] as const;

export function hasMeaningfulHtml(value: string | null | undefined): boolean {
  return (
    String(value ?? "")
      .replace(/<[^>]*>/g, " ")
      .replace(/&(nbsp|#160);/gi, " ")
      .replace(/\s+/g, " ")
      .trim().length > 0
  );
}

export function getRichTextPlainText(value: string | null | undefined): string {
  return String(value ?? "")
    .replace(/<[^>]*>/g, " ")
    .replace(/&(nbsp|#160);/gi, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function countRichTextWords(value: string | null | undefined): number {
  const plainText = getRichTextPlainText(value);

  if (!plainText) {
    return 0;
  }

  return plainText.split(/\s+/).length;
}
