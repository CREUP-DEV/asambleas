import createDOMPurify, { type WindowLike } from "dompurify";
import { createError } from "h3";
import { parseHTML } from "linkedom";
import {
  RICH_TEXT_ALLOWED_ATTR,
  RICH_TEXT_ALLOWED_TAGS,
  RICH_TEXT_MAX_HTML_LENGTH,
  hasMeaningfulHtml,
} from "~~/shared/utils/richText";

const MAX_RAW_INPUT_SIZE = RICH_TEXT_MAX_HTML_LENGTH * 2;

const window = parseHTML("<!doctype html><html><body></body></html>");
const DOMPurify = createDOMPurify(window as unknown as WindowLike);

export function sanitizeRichTextHtml(html: string): string {
  if (html.length > MAX_RAW_INPUT_SIZE) {
    throw createError({
      statusCode: 413,
      message: "El contenido supera el límite permitido",
    });
  }

  const sanitized = DOMPurify.sanitize(html, {
    ALLOWED_TAGS: [...RICH_TEXT_ALLOWED_TAGS],
    ALLOWED_ATTR: [...RICH_TEXT_ALLOWED_ATTR],
  });

  if (sanitized.length > RICH_TEXT_MAX_HTML_LENGTH) {
    throw createError({
      statusCode: 400,
      message: "El contenido HTML supera el límite permitido",
    });
  }

  if (!hasMeaningfulHtml(sanitized)) {
    throw createError({
      statusCode: 400,
      message: "El contenido no puede estar vacío",
    });
  }

  return sanitized;
}
