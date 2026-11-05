import type { DocumentSummaryDto, MemberRef } from "~~/shared/types/api";

/**
 * Who presents a document. A document has a main presenter
 * (`proponent`, the one that answers its amendments) and may have
 * co-presenters (`coProponents`), who edit the draft with it and always see
 * what it decided. Pure: components turn ids into labels.
 */
export type PresentedDocument = Pick<DocumentSummaryDto, "proponent"> & {
  /** Loose: summaries from an older server lack it. */
  coProponents?: MemberRef[] | null;
};

/** The co-presenters, never the main presenter, without repeats. */
export function documentCoPresenters(document: PresentedDocument): MemberRef[] {
  const mainId = document.proponent?.id ?? null;
  const seen = new Set<string>();
  const result: MemberRef[] = [];
  for (const member of document.coProponents ?? []) {
    if (member.id === mainId || seen.has(member.id)) continue;
    seen.add(member.id);
    result.push(member);
  }
  return result;
}

/** Every presenting member: the main one first, then the co-presenters. */
export function documentPresenterMembers(
  document: PresentedDocument,
): MemberRef[] {
  const main = document.proponent ? [document.proponent] : [];
  return [...main, ...documentCoPresenters(document)];
}

/** The member presents the document, as its main presenter or with it. */
export function isDocumentPresenter(
  document: PresentedDocument,
  memberId: string | null | undefined,
): boolean {
  if (!memberId) return false;
  return documentPresenterMembers(document).some(
    (member) => member.id === memberId,
  );
}

/**
 * What a presenter of the document is told about the members it works
 * with: the other presenters and who answers the amendments. Null when the
 * member is not a presenter or presents it alone.
 */
export function presenterPartners(
  document: PresentedDocument,
  memberId: string | null | undefined,
): { others: MemberRef[]; main: MemberRef | null; mainIsMine: boolean } | null {
  if (!memberId || !isDocumentPresenter(document, memberId)) return null;
  const others = documentPresenterMembers(document).filter(
    (member) => member.id !== memberId,
  );
  if (others.length === 0) return null;
  const main = document.proponent ?? null;
  return { others, main, mainIsMine: main?.id === memberId };
}

// Choosing the presenters in a form -----------------------------------------------

/**
 * The presenters as a form holds them.
 *
 * - `leadId`: the first presenter: the member the Secretaría picks under
 *   "Quién lo presenta", or the presenter's own member, which they cannot
 *   remove;
 * - `coIds`: the other presenting members;
 * - `mainId`: who answers the amendments, chosen only when there are
 *   several presenters (a lone presenter is the main one).
 */
export interface PresenterChoice {
  leadId: string | null;
  coIds: readonly string[];
  mainId: string | null;
}

/** The presenter fields of a create or update body. */
export interface PresenterFields {
  proponentMemberId: string | null;
  coProponentMemberIds: string[];
}

/**
 * The choice a form holds, as it will be sent. Nobody leading (the
 * Secretaría left "Quién lo presenta" empty) leaves no co-presenters either:
 * the co-presenters a form keeps meanwhile come back if a lead is picked
 * again, but they are never sent on their own.
 */
export function formPresenterChoice(choice: PresenterChoice): PresenterChoice {
  return {
    leadId: choice.leadId,
    coIds: choice.leadId === null ? [] : choice.coIds,
    mainId: choice.mainId,
  };
}

/** Every presenting member of the choice, the lead first, without repeats. */
export function choicePresenterIds(choice: PresenterChoice): string[] {
  const ids: string[] = [];
  for (const id of [choice.leadId, ...choice.coIds]) {
    if (id && !ids.includes(id)) ids.push(id);
  }
  return ids;
}

/** Several presenters: one of them has to be chosen to answer amendments. */
export function needsMainPresenter(choice: PresenterChoice): boolean {
  return choicePresenterIds(choice).length > 1;
}

/**
 * Who answers the amendments: the lone presenter, or the chosen one among
 * several (null while none of them is chosen).
 */
export function resolveMainPresenter(choice: PresenterChoice): string | null {
  const ids = choicePresenterIds(choice);
  if (ids.length <= 1) return ids[0] ?? null;
  return choice.mainId && ids.includes(choice.mainId) ? choice.mainId : null;
}

/** Several presenters and none chosen to answer the amendments. */
export function mainPresenterMissing(choice: PresenterChoice): boolean {
  return needsMainPresenter(choice) && resolveMainPresenter(choice) === null;
}

/**
 * The member a presenter hands answering the amendments to: another
 * presenter chosen as the main one while the presenter's own member leads
 * (null when its own member answers, nobody is chosen yet, or the member
 * does not present it). Once stored, only that member or the Secretaría can
 * change it again, so the form warns before.
 */
export function handedOverMainPresenter(
  choice: PresenterChoice,
  ownMemberId: string | null | undefined,
): string | null {
  if (!ownMemberId || !choicePresenterIds(choice).includes(ownMemberId))
    return null;
  const main = resolveMainPresenter(choice);
  return main !== null && main !== ownMemberId ? main : null;
}

/**
 * The co-presenters a form holds that will not be sent because nobody
 * leads (the Secretaría left "Quién lo presenta" empty): saving removes
 * them, so the form names them.
 */
export function coPresentersDroppedWithoutLead(
  choice: PresenterChoice,
): string[] {
  if (choice.leadId !== null) return [];
  return [...new Set(choice.coIds)];
}

/**
 * The body fields: the main presenter and everyone else as co-presenters
 * (the contract never lists the main one among them). Validate with
 * `mainPresenterMissing` first: without a main one, nobody is the main
 * presenter and every member stays a co-presenter.
 */
export function presenterFields(choice: PresenterChoice): PresenterFields {
  const main = resolveMainPresenter(choice);
  return {
    proponentMemberId: main,
    coProponentMemberIds: choicePresenterIds(choice).filter(
      (id) => id !== main,
    ),
  };
}

/** Same main presenter and same co-presenters, in any order. */
export function samePresenterFields(
  a: PresenterFields,
  b: PresenterFields,
): boolean {
  if (a.proponentMemberId !== b.proponentMemberId) return false;
  const left = new Set(a.coProponentMemberIds);
  const right = new Set(b.coProponentMemberIds);
  return left.size === right.size && [...left].every((id) => right.has(id));
}

/**
 * The form's choice for a stored document. With `ownMemberId` (a presenter
 * editing it) their own member leads, so it stays fixed even when it is a
 * co-presenter; otherwise the main presenter leads.
 */
export function presenterChoiceFromDocument(
  document: PresentedDocument,
  ownMemberId?: string | null,
): PresenterChoice {
  const mainId = document.proponent?.id ?? null;
  const coIds = documentCoPresenters(document).map((member) => member.id);
  if (ownMemberId && ownMemberId !== mainId && coIds.includes(ownMemberId)) {
    return {
      leadId: ownMemberId,
      coIds: [
        ...(mainId ? [mainId] : []),
        ...coIds.filter((id) => id !== ownMemberId),
      ],
      mainId,
    };
  }
  return { leadId: mainId, coIds, mainId };
}

/**
 * A new lead (the Secretaría picked another "Quién lo presenta"): it leaves
 * the co-presenters, and answers the amendments if the previous lead did.
 */
export function withPresenterLead(
  choice: PresenterChoice,
  leadId: string | null,
): PresenterChoice {
  return {
    leadId,
    coIds: choice.coIds.filter((id) => id !== leadId),
    mainId:
      choice.mainId !== null && choice.mainId === choice.leadId
        ? leadId
        : choice.mainId,
  };
}

/**
 * Managers: "Quién lo presenta" is the main presenter, so choosing another
 * presenter to answer the amendments makes it the lead and the previous lead
 * a co-presenter, and the form already shows what will be stored. Choosing
 * the lead, or a member that does not present it, only records the choice.
 */
export function withMainAsLead(
  choice: PresenterChoice,
  mainId: string | null,
): PresenterChoice {
  const { leadId } = choice;
  if (
    mainId === null ||
    leadId === null ||
    mainId === leadId ||
    !choice.coIds.includes(mainId)
  ) {
    return { ...choice, mainId };
  }
  return {
    leadId: mainId,
    coIds: [leadId, ...choice.coIds.filter((id) => id !== mainId)],
    mainId,
  };
}

/**
 * Several presenters and none of them chosen to answer the amendments: the
 * lead answers (the member presenting it, or the Secretaría's pick) until
 * another one is chosen. The choice stays required and can be changed; the
 * form just starts from the usual answer instead of an error.
 */
export function withDefaultMainPresenter(
  choice: PresenterChoice,
): PresenterChoice {
  if (!needsMainPresenter(choice) || choice.leadId === null) return choice;
  if (resolveMainPresenter(choice) !== null) return choice;
  return { ...choice, mainId: choice.leadId };
}

/**
 * The order to list presenters in, kept stable while they change: the ones
 * still there keep their place and new ones go last. Swapping who answers
 * the amendments then never moves the radio the user just picked.
 */
export function stablePresenterOrder(
  previous: readonly string[],
  next: readonly string[],
): string[] {
  return [
    ...previous.filter((id) => next.includes(id)),
    ...next.filter((id) => !previous.includes(id)),
  ];
}

// Showing a list of members -------------------------------------------------------

export type ListSegment =
  { kind: "item"; index: number } | { kind: "text"; value: string };

/**
 * A list of `count` items as the locale joins them ("A, B y C", "A, B and
 * C"), split into items and the text between them, so components can put a
 * badge in each item.
 */
export function listSegments(count: number, locale: string): ListSegment[] {
  if (count <= 0) return [];
  const placeholders = Array.from(
    { length: count },
    (_, index) => `#${index}#`,
  );
  const fallback = (): ListSegment[] =>
    placeholders.flatMap((_, index) => [
      ...(index > 0 ? [{ kind: "text" as const, value: ", " }] : []),
      { kind: "item" as const, index },
    ]);
  if (typeof Intl === "undefined" || !("ListFormat" in Intl)) return fallback();
  try {
    const parts = new Intl.ListFormat(locale, {
      type: "conjunction",
      style: "long",
    }).formatToParts(placeholders);
    const segments: ListSegment[] = [];
    for (const part of parts) {
      if (part.type === "element") {
        const index = placeholders.indexOf(part.value);
        if (index === -1) return fallback();
        segments.push({ kind: "item", index });
      } else if (part.value) {
        segments.push({ kind: "text", value: part.value });
      }
    }
    return segments;
  } catch {
    return fallback();
  }
}

/** The items joined as the locale does ("UPV y UV"), as plain text. */
export function formatMemberList(items: string[], locale: string): string {
  return listSegments(items.length, locale)
    .map((segment) =>
      segment.kind === "item" ? (items[segment.index] ?? "") : segment.value,
    )
    .join("");
}
