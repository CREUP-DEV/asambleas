<script setup lang="ts">
import type { MemberDto, MemberRef } from "~~/shared/types/api";

/**
 * Who presents something in the control sheet: the main presenters as
 * tags with their card (ControlSheetMemberTag), then «+N» for the rest,
 * listed when the pointer is over it with their whole denomination, never
 * cut, and a council's university under it (councils share their
 * denominations). Screen readers read the same from the «+N» itself.
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

/** Its denomination, unless it repeats the acronym. */
function nameOf(member: MemberRef): string | null {
  return memberNameRepeatsAcronym(member) ? null : member.name.trim();
}

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
      <UPopover mode="hover" :open-delay="200" :close-delay="100">
        <UBadge color="neutral" variant="outline" size="sm">
          <span aria-hidden="true">+{{ others.length }}</span>
          <span class="sr-only">{{ othersText }}</span>
        </UBadge>
        <template #content>
          <div class="w-max max-w-sm space-y-2 p-3" aria-hidden="true">
            <p class="text-muted text-xs font-medium">
              {{ othersTitle }}
            </p>
            <ul class="space-y-2">
              <li
                v-for="member in others"
                :key="member.id"
                class="flex items-start gap-2"
              >
                <CommonMemberBadge
                  :member="member"
                  size="sm"
                  :tooltip="false"
                />
                <div class="min-w-0 text-sm">
                  <p v-if="nameOf(member)" class="text-default break-words">
                    {{ nameOf(member) }}
                  </p>
                  <p
                    v-if="universityOf(member)"
                    class="text-muted text-xs break-words"
                  >
                    {{ universityOf(member) }}
                  </p>
                </div>
              </li>
            </ul>
          </div>
        </template>
      </UPopover>
    </li>
  </ul>
</template>
