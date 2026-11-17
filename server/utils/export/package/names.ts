/**
 * Names of the folders and files inside the documentation package. They are
 * titles written by people, so they are cleaned for every system the ZIP
 * may be opened on: no character Windows refuses, no trailing dot or space,
 * no reserved device name, and short enough that a deep path stays under
 * Windows' 260 characters.
 */

/** Characters Windows refuses in a name, and control characters. */
// eslint-disable-next-line no-control-regex
const FORBIDDEN = /[<>:"/\\|?*\u0000-\u001F\u007F]/g;
/** Device names Windows reserves, with or without an extension. */
const RESERVED = /^(con|prn|aux|nul|com[0-9]|lpt[0-9])(\..*)?$/i;

/** Longest folder or file name, before its extension. */
export const NAME_MAX = 60;

/** A title as a folder or file name (without extension). */
export function safeName(text: string, max = NAME_MAX): string {
  let name = text
    .normalize("NFC")
    .replace(FORBIDDEN, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (name.length > max) {
    // Cut at a word, when one ends close enough, and say it was cut.
    const cut = name.slice(0, max - 1);
    const space = cut.lastIndexOf(" ");
    name = `${(space > max * 0.6 ? cut.slice(0, space) : cut).replace(/[\s.,;:]+$/, "")}…`;
  }
  name = name.replace(/[. ]+$/, "").trim();
  if (!name) return "_";
  return RESERVED.test(name) ? `_${name}` : name;
}

/**
 * An agenda number whose parts sort as numbers do in a file browser that
 * sorts names as text: "3.10" comes after "3.9" as "03.10" after "03.09".
 */
export function sortableNumbering(numbering: string): string {
  return numbering
    .split(".")
    .map((part) => (/^\d$/.test(part) ? `0${part}` : part))
    .join(".");
}

/**
 * Names given once in a folder, compared as Windows does (case and accents
 * as written, case ignored): a second "Informe" becomes "Informe (2)".
 */
export class NameRegistry {
  private readonly taken = new Set<string>();

  claim(name: string, extension = ""): string {
    let candidate = `${name}${extension}`;
    for (let n = 2; this.taken.has(candidate.toLowerCase()); n += 1) {
      candidate = `${name} (${n})${extension}`;
    }
    this.taken.add(candidate.toLowerCase());
    return candidate;
  }
}
