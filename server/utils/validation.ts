import { createError } from "h3";
import { isCuid } from "@paralleldrive/cuid2";

const DEFAULT_CUID2_PATTERN = /^[a-z][a-z0-9]{23}$/;
const BETTER_AUTH_ID_PATTERN = /^[a-zA-Z0-9]{32}$/;

export function isDefaultCuid(id: string): boolean {
  return DEFAULT_CUID2_PATTERN.test(id) && isCuid(id);
}

export function validateCuid(id: string | undefined, label = "ID"): string {
  if (!id || !isDefaultCuid(id)) {
    throw createError({ statusCode: 400, message: `${label} inválido` });
  }
  return id;
}

export function validateAuthId(id: string | undefined, label = "ID"): string {
  if (!id || !BETTER_AUTH_ID_PATTERN.test(id)) {
    throw createError({ statusCode: 400, message: `${label} inválido` });
  }
  return id;
}
