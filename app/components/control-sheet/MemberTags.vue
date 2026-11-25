<script setup lang="ts">
import type { MemberDto, MemberRef } from "~~/shared/types/api";

/**
 * Who presents something in the control sheet: the main presenters as
 * tags with their card (ControlSheetMemberTag), then «+N» for the rest, a
 * button whose popover lists them (on a click, a tap or Enter) as the same
 * cards with their acronym tag (CommonMemberCard: avatar, and a council's
 * university first, since councils share their denominations, never cut).
 * Screen readers read the names from the «+N» button's name.
 */
const props = defineProps<{
  main: MemberRef[];
  others: MemberRef[];
  /** Every member by id, for the cards and the universities. */
  members: ReadonlyMap<string, MemberDto>;
  /** Names the list for screen readers («Proponente», «Presenta»). */
  label: string;
  /** Heads the list «+N» opens («Otros proponentes»). */
  othersTitle: string;
}>();

const { t } = useI18n();

/** A council's university, from the full member list. */
function universityOf(member: MemberRef): string | null {
  return props.members.get(member.id)?.university?.trim() || null;
}

const othersText = computed(() =>
  t(
    "controlSheet.moreMembers",
    {
      count: props.others.length,
      names: props.others
        .map((member) =>
          [
            member.acronym,
            memberDescription({
              ...member,
              university: universityOf(member),
            }),
          ]
            .filter(Boolean)
            .join(", "),
        )
        .join("; "),
    },
    props.others.length,
  ),
);

/**
 * The «+N» popover keeps the focus on its button, whose name already reads
 * every member: the list it opens is hidden from screen readers and holds
 * nothing to tab to, so Reka's autofocus would land on an empty dialog.
 * Escape or Tab still closes it. Named for whoever reaches the dialog by
 * browsing.
 */
const othersContent = computed(() => ({
  align: "start" as const,
  "aria-label": props.othersTitle,
  onOpenAutoFocus: (event: Event) => event.preventDefault(),
}));
</script>

<template>
  <ul
    v-if="main.length + others.length > 0"
    class="flex flex-wrap items-center gap-1 text-sm"
    :aria-label="label"
  >
    <li v-for="member in main" :key="member.id" class="flex items-center">
      <ControlSheetMemberTag :member="member" :members="members" />
    </li>
    <li v-if="others.length > 0" class="flex items-center">
      <UPopover :content="othersContent">
        <!-- A button, as «N más» in DocumentPresenters: a click, a tap or
             Enter opens the list, and a click on it never opens the row's
             panel. At least 24px tall to tap; its name starts with the
             «+N» it shows (label in name). -->
        <UButton
          color="neutral"
          variant="link"
          size="xs"
          class="text-default min-h-6 px-1 py-0.5 text-sm underline decoration-dotted underline-offset-2"
          :label="`+${others.length}`"
          :aria-label="othersText"
        />
        <template #content>
          <ControlSheetMemberCardList
            :list="others"
            :members="members"
            :title="othersTitle"
          />
        </template>
      </UPopover>
    </li>
  </ul>
</template>
