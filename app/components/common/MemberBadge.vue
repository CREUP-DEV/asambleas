<script setup lang="ts">
import type { MemberKind } from "~~/shared/constants/domain";
import type { MemberRef } from "~~/shared/types/api";
import { useMemberDirectory } from "~/composables/members/useMemberDirectory";

/**
 * A member (student council, sectorial, executive office) shown by its
 * acronym. Pointing at it opens its card (CommonMemberCard: avatar, a
 * council's university, the denomination and kind, who holds a CEA office),
 * wherever an acronym shows (user's decision of 2026-11-17); `tooltip:
 * false` leaves that to a card the caller wraps it in, or to nobody (the
 * projection, which nobody points at). Screen readers get the full name
 * instead of the acronym. With `showName`, a council's name goes with its
 * university once the members are read (useMemberDirectory), since councils
 * share the same or nearly the same denomination.
 */
const props = withDefaults(
  defineProps<{
    member: Pick<MemberRef, "acronym" | "name"> &
      Partial<Pick<MemberRef, "id" | "kind">>;
    size?: "xs" | "sm" | "md" | "lg" | "xl";
    variant?: "solid" | "outline" | "soft" | "subtle";
    /** Shows the full name next to the acronym. */
    showName?: boolean;
    /** Opens the member's card on hover. */
    tooltip?: boolean;
  }>(),
  { size: "sm", variant: "subtle", showName: false, tooltip: true },
);

/**
 * Councils in blue, sectorials in their own green (`sectorial`, main.css),
 * the CEA's offices in burgundy, as in the room and the platform's brand,
 * and anyone else (the CAS, other members) in the grey-blue of `secondary`.
 */
const KIND_COLORS: Record<
  MemberKind,
  "info" | "sectorial" | "primary" | "secondary"
> = {
  asociado: "info",
  sectorial: "sectorial",
  executive: "primary",
  other: "secondary",
};

const color = computed(() =>
  props.member.kind ? KIND_COLORS[props.member.kind] : "secondary",
);
/** A name that only repeats the acronym is not shown twice. */
const nameRepeats = computed(() => memberNameRepeatsAcronym(props.member));

const directory = useMemberDirectory();
const showsCouncilName = computed(
  () =>
    props.showName &&
    !nameRepeats.value &&
    props.member.kind === "asociado" &&
    Boolean(props.member.id),
);
onMounted(() => {
  if (showsCouncilName.value) void directory.load();
});
/** The name shown next to the acronym, with a council's university. */
const shownName = computed(() => {
  const university =
    showsCouncilName.value && props.member.id
      ? directory.byId.value.get(props.member.id)?.university?.trim()
      : null;
  return university
    ? `${props.member.name} · ${university}`
    : props.member.name;
});
</script>

<template>
  <span class="inline-flex max-w-full min-w-0 items-center gap-1.5">
    <UPopover v-if="tooltip" mode="hover" :open-delay="200" :close-delay="100">
      <UBadge
        :color="color"
        :variant="variant"
        :size="size"
        class="shrink-0 font-semibold tracking-wide"
      >
        <span :aria-hidden="showName || nameRepeats ? undefined : 'true'">{{
          member.acronym
        }}</span>
        <span v-if="!showName && !nameRepeats" class="sr-only">{{
          member.name
        }}</span>
      </UBadge>
      <template #content>
        <div class="w-max max-w-sm p-3" aria-hidden="true">
          <CommonMemberCard :member="member" tag />
        </div>
      </template>
    </UPopover>
    <UBadge
      v-else
      :color="color"
      :variant="variant"
      :size="size"
      class="shrink-0 font-semibold tracking-wide"
    >
      <span :aria-hidden="showName || nameRepeats ? undefined : 'true'">{{
        member.acronym
      }}</span>
      <span v-if="!showName && !nameRepeats" class="sr-only">{{
        member.name
      }}</span>
    </UBadge>
    <span
      v-if="showName && !nameRepeats"
      class="text-default min-w-0 truncate text-sm"
    >
      {{ shownName }}
    </span>
  </span>
</template>
