/**
 * The type size of an avatar's text (AccountAvatar), by its length, so an
 * acronym fits inside the circle without being cut. Measured on Raleway
 * medium: in the 28 px circle (`sm`) two letters keep the 14 px of UAvatar
 * (UB is 20 px wide), three take 11 px (UGR 23) and four 9 px (UPCT 24,
 * UNED 26); the 32 px circle (`md`) one step more. Five letters would need
 * 8 px (ULPGC 27), too small to read, so anything longer than four gives
 * way to the initials of the name (avatarDisplayText).
 */
const SIZES: Record<"sm" | "md", Record<number, string>> = {
  sm: { 3: "text-[11px]", 4: "text-[9px]" },
  md: { 3: "text-xs", 4: "text-[10px]" },
};

/** Longest text an avatar draws (see SIZES). */
export const AVATAR_TEXT_MAX_LENGTH = 4;

/**
 * The text an avatar draws: the account's (university or member acronym)
 * when it fits, otherwise undefined, so UAvatar draws the initials of the
 * name.
 */
export function avatarDisplayText(
  text: string | null | undefined,
): string | undefined {
  const value = text?.trim();
  return value && [...value].length <= AVATAR_TEXT_MAX_LENGTH
    ? value
    : undefined;
}

/** The class of UAvatar's fallback slot for that text: "" keeps its own size. */
export function avatarTextClass(
  text: string | null | undefined,
  size: "sm" | "md" = "sm",
): string {
  const value = avatarDisplayText(text);
  if (!value) return "";
  return SIZES[size][[...value].length] ?? "";
}
