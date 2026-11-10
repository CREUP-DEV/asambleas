<script setup lang="ts">
import type { MemberRef } from "~~/shared/types/api";
import {
  documentPresenterMembers,
  listSegments,
  type PresentedDocument,
} from "~/composables/document/documentPresenters";

/**
 * Who presents a document, as a short sentence with member badges:
 * "Presenta CEUM con UPV y UV" (`labelled`) or "CEUM con UPV y UV". The main
 * presenter, the one that answers the amendments, always comes first.
 *
 * Rows pass `maxOthers` so a long list of co-presenters stays on one line on
 * a phone: the rest is summed up as "2 más", a button that opens their
 * names in a popover (a tap opens it too, unlike a tooltip). Inside a row
 * whose title link covers it, keep this component above the link
 * (`relative z-[1]`), as the agenda row does. `showName` adds the full name
 * of a member presenting it alone (with co-presenters only acronyms fit);
 * with `labelled` the name alone replaces the badge and the visible
 * "Presenta" (kept for screen readers).
 * Renders nothing without a main presenter: callers say so themselves.
 */
const props = withDefaults(
  defineProps<{
    document: PresentedDocument;
    /** Starts with "Presenta". */
    labelled?: boolean;
    /** Co-presenters shown as badges before "N más". */
    maxOthers?: number;
    size?: "xs" | "sm" | "md";
    /** The full name of a member presenting it alone. */
    showName?: boolean;
  }>(),
  {
    labelled: false,
    maxOthers: Number.POSITIVE_INFINITY,
    size: "sm",
    showName: false,
  },
);

const { t, locale } = useI18n();

/** The main presenter first (the contract always has one with co-presenters). */
const presenters = computed(() => documentPresenterMembers(props.document));
const main = computed(() => presenters.value[0] ?? null);
const others = computed(() => presenters.value.slice(1));

const shown = computed(() => others.value.slice(0, props.maxOthers));
const hidden = computed(() => others.value.slice(shown.value.length));

type Part =
  | { kind: "text"; value: string }
  | { kind: "member"; member: MemberRef }
  | { kind: "more" };

/**
 * The co-presenters joined as the locale does ("UPV, UV y 2 más"): badges,
 * then "N más" if any are hidden, with the locale's separators between them.
 */
const parts = computed<Part[]>(() => {
  const items: Part[] = [
    ...shown.value.map((member) => ({ kind: "member" as const, member })),
    ...(hidden.value.length > 0 ? [{ kind: "more" as const }] : []),
  ];
  return listSegments(items.length, locale.value).flatMap((segment): Part[] => {
    if (segment.kind === "text")
      return [{ kind: "text", value: segment.value }];
    const item = items[segment.index];
    return item ? [item] : [];
  });
});
</script>

<template>
  <span
    v-if="main && others.length === 0"
    class="inline-flex max-w-full min-w-0 items-center gap-1.5"
  >
    <!-- The name alone ("Presenta" only for screen readers): beside the
         title it says who presents it without a label -->
    <span
      v-if="labelled && showName"
      class="text-default min-w-0 text-sm font-medium"
      data-testid="document-presenter-name"
    >
      <span class="sr-only">{{ t("document.header.proponent") }} </span>
      {{ memberNameRepeatsAcronym(main) ? main.acronym : main.name }}
    </span>
    <template v-else>
      <span v-if="labelled" class="text-muted text-sm">
        {{ t("document.header.proponent") }}
      </span>
      <CommonMemberBadge :member="main" :size="size" :show-name="showName" />
    </template>
  </span>

  <i18n-t
    v-else-if="main"
    :keypath="
      labelled ? 'document.presenters.sentence' : 'document.presenters.short'
    "
    tag="span"
    scope="global"
    class="text-muted min-w-0 text-sm leading-7"
    data-testid="document-presenters"
  >
    <template #main>
      <CommonMemberBadge :member="main" :size="size" class="align-middle" />
    </template>
    <template #others>
      <template v-for="(part, position) in parts" :key="position">
        <template v-if="part.kind === 'text'">{{ part.value }}</template>
        <CommonMemberBadge
          v-else-if="part.kind === 'member'"
          :member="part.member"
          :size="size"
          variant="outline"
          class="align-middle"
        />
        <UPopover v-else :content="{ align: 'start' }">
          <!-- At least 24px tall to tap; its name starts with "2 más" (label in name). -->
          <UButton
            color="neutral"
            variant="link"
            size="xs"
            class="text-default min-h-6 px-1 py-0.5 align-middle text-sm underline decoration-dotted underline-offset-2"
            :label="t('document.presenters.more', { count: hidden.length })"
            :aria-label="
              t(
                'document.presenters.moreLabel',
                { count: hidden.length },
                hidden.length,
              )
            "
          />
          <template #content>
            <ul class="max-w-72 space-y-1 p-2">
              <li v-for="member in hidden" :key="member.id" class="min-w-0">
                <CommonMemberBadge
                  :member="member"
                  :size="size"
                  variant="outline"
                  show-name
                />
              </li>
            </ul>
          </template>
        </UPopover>
      </template>
    </template>
  </i18n-t>
</template>
