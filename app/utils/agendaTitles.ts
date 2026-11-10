import { computed, type Ref, type WritableComputedRef } from "vue";
import type { AgendaDto } from "~~/shared/types/api";

/**
 * The agenda as the pages show it: an item the server sends without its
 * title (`titleHidden`: it carries the title of a document the viewer cannot
 * see yet) gets a neutral label, so every list, breadcrumb and picker reads
 * one. Never apply it to what is fetched and kept: the label must follow
 * the language (agendaWithTitles).
 */
export function withAgendaTitles<T extends AgendaDto | null | undefined>(
  agenda: T,
  hiddenTitle: string,
): T {
  if (!agenda || !agenda.items.some((item) => item.titleHidden)) return agenda;
  return {
    ...agenda,
    items: agenda.items.map((item) =>
      item.titleHidden ? { ...item, title: hiddenTitle } : item,
    ),
  };
}

/**
 * The fetched agenda with its neutral labels (withAgendaTitles), worded when
 * read so they follow a change of language. Writes go to the source: the
 * items keep `titleHidden`, so a labelled agenda written back reads the
 * same.
 */
export function agendaWithTitles<T extends AgendaDto | null | undefined>(
  source: Ref<T>,
  hiddenTitle: () => string,
): WritableComputedRef<T> {
  return computed({
    get: () => withAgendaTitles(source.value, hiddenTitle()),
    set: (value) => {
      source.value = value;
    },
  });
}
