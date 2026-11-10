import {
  DOCUMENT_KIND_DEFAULTS,
  type DocumentFormat,
  type DocumentKind,
} from "../constants/domain";

/**
 * Who may deliver a document as an uploaded PDF (`format: "file"`).
 *
 * A PDF takes no amendments. The types whose default is to take them
 * (positionings, resolutions, regulations...) are therefore presented as
 * text on the platform: only the Secretaría (document managers) may store
 * one of them as a PDF. Members keep the PDF for the types that take no
 * amendments (reports, minutes, accounts...).
 */

/** Stable `data.reason` of the 422 the server answers. */
export const FILE_FORMAT_REFUSED_REASON = "file_kind";

/** The types a member can present as a PDF: those that take no amendments. */
export function kindAcceptsFile(kind: DocumentKind): boolean {
  return DOCUMENT_KIND_DEFAULTS[kind].amendable === false;
}

/** Whether a document of `kind` may be a PDF for this kind of user. */
export function mayUseFileFormat(
  kind: DocumentKind,
  manager: boolean,
): boolean {
  return manager || kindAcceptsFile(kind);
}

interface KindAndFormat {
  kind: DocumentKind;
  format: DocumentFormat;
}

/**
 * Whether a create (`current: null`) or an update must be refused: a
 * non-manager ending with a PDF of a type that takes amendments.
 *
 * An update is only checked when it changes the format or the kind, so the
 * presenter of a PDF the Secretaría created for such a type can still edit
 * its title, and can always switch it back to text.
 */
export function fileFormatRefused(input: {
  manager: boolean;
  current: KindAndFormat | null;
  next: KindAndFormat;
}): boolean {
  const { manager, current, next } = input;
  if (next.format !== "file" || mayUseFileFormat(next.kind, manager)) {
    return false;
  }
  return (
    current === null ||
    current.format !== next.format ||
    current.kind !== next.kind
  );
}
