/**
 * Numbers that tick without the text around them moving. Raleway, the UI
 * font, ships no tabular figures (`tnum`; its features are ccmp, dnom, frac,
 * liga, lnum, locl and numr), so `tabular-nums` does nothing and every
 * lining digit has its own width: from 0.416em («1») to 0.684em («0») in
 * the Regular face, 0.490em to 0.701em in the Bold one. CommonTabularDigits
 * gives each digit a cell of the widest one instead (TABULAR_DIGIT_EM),
 * centred; any other character keeps its own width, since it does not change
 * from one tick to the next.
 *
 * Pure, so the component and its tests share it. The leading dash keeps
 * Nuxt from registering this file as a component (`ignorePrefix`).
 */

/** The width of a digit cell, in em: the Bold lining zero, rounded up. */
export const TABULAR_DIGIT_EM = 0.71;

/** One character of a number, and whether it takes a fixed digit cell. */
export interface DigitCell {
  char: string;
  digit: boolean;
}

/** The characters of `text`, each digit (0-9) marked for a fixed cell. */
export function digitCells(text: string): DigitCell[] {
  return Array.from(text, (char) => ({
    char,
    digit: char >= "0" && char <= "9",
  }));
}
