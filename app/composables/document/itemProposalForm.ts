import type { DocumentKind } from "~~/shared/constants/domain";
import type { ItemProposal } from "./itemProposal";

/**
 * What the forms that add a document under an agenda item share around
 * proposeFromItem: the item's menu, numbered and searchable, whose long
 * titles wrap instead of being cut, and proposing again when another item
 * is chosen without losing what the user typed or chose.
 */

/** The `ui` of the item's USelectMenu: long titles wrap. */
export const ITEM_SELECT_UI = {
  value: "whitespace-normal text-start",
  itemLabel: "whitespace-normal",
} as const;

/** The type and title a form holds (the type may still be empty). */
export interface ProposedFields {
  kind: DocumentKind | undefined;
  title: string;
}

/**
 * The type and title after choosing another item: each field still on what
 * the previous item proposed takes what the new one proposes; one the user
 * changed stays.
 */
export function repropose(
  current: ProposedFields,
  previous: ItemProposal,
  next: ItemProposal,
): ProposedFields {
  return {
    kind:
      current.kind === (previous.kind ?? undefined)
        ? (next.kind ?? undefined)
        : current.kind,
    title:
      current.title === (previous.title ?? "")
        ? (next.title ?? "")
        : current.title,
  };
}
