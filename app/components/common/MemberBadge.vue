<script setup lang="ts">
import type { MemberKind } from "~~/shared/constants/domain";
import type { MemberDto, MemberRef } from "~~/shared/types/api";
import { useMemberDirectory } from "~/composables/members/useMemberDirectory";
import {
  memberSpokenName,
  spokenNameNeedsDirectory,
  useTouchTapGuard,
} from "./-memberBadge";

/**
 * A member (student council, sectorial, executive office) shown by its
 * acronym, at 12px (`md`) unless the caller asks otherwise. Its card
 * (CommonMemberCard: avatar, a council's university, the denomination and
 * kind, who holds a CEA office) opens wherever an acronym shows (user's
 * decision of 2026-11-17): on pointing at it, on a tap (`enable-touch`; the
 * click after the tap stops at the badge, so a row, link or label around it
 * does not act) and on keyboard focus, since the badge is then a tab stop.
 * It is a plain `tabindex`, with no role nor `aria-haspopup`: the control
 * sheet's rows open their panel on a mouse click on it (`rowClickOpens`).
 * `tooltip: false` leaves the card to one the caller wraps it in, or to
 * nobody (the projection, which nobody points at), and the badge is then no
 * tab stop; pass it wherever the badge sits inside a link or a button.
 * Screen readers get the denomination and a council's university instead
 * of the acronym (memberSpokenName), from `members` or the member directory
 * (useMemberDirectory). With `showName`, a council's name goes with its
 * university on screen too, since councils share the same or nearly the
 * same denomination. The name keeps to one line, cut with an ellipsis,
 * unless the caller passes `wrap`: then a long one wraps in its own column
 * beside the acronym, its first line level with the badge, and is never cut
 * (the amendment detail, a transactional's parties). The projection and the
 * live view keep one line.
 */
const props = withDefaults(
  defineProps<{
    member: Pick<MemberRef, "acronym" | "name"> &
      Partial<Pick<MemberRef, "id" | "kind">>;
    size?: "xs" | "sm" | "md" | "lg" | "xl";
    variant?: "solid" | "outline" | "soft" | "subtle";
    /** Shows the full name next to the acronym. */
    showName?: boolean;
    /** A long name wraps instead of being cut (with `showName`). */
    wrap?: boolean;
    /** Opens the member's card on hover, tap and focus. */
    tooltip?: boolean;
    /** Every member by id, when the caller has them; else the directory. */
    members?: ReadonlyMap<string, MemberDto>;
  }>(),
  {
    size: "md",
    variant: "subtle",
    showName: false,
    wrap: false,
    tooltip: true,
    members: undefined,
  },
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
/** A council's university, from `members` or the directory. */
const university = computed(() => {
  if (props.member.kind !== "asociado" || !props.member.id) return null;
  const members = props.members ?? directory.byId.value;
  return members.get(props.member.id)?.university?.trim() || null;
});
const showsCouncilName = computed(
  () =>
    props.showName &&
    !nameRepeats.value &&
    props.member.kind === "asociado" &&
    Boolean(props.member.id),
);
/**
 * The directory loads for a council's badge someone may point at, focus or
 * read the name of; a bare tag (`tooltip: false`, the projection) uses it
 * only if another badge loaded it.
 */
onMounted(() => {
  if (
    !props.members &&
    (props.tooltip || props.showName) &&
    spokenNameNeedsDirectory(props.member)
  )
    void directory.load();
});
/** The name shown next to the acronym, with a council's university. */
const shownName = computed(() =>
  showsCouncilName.value && university.value
    ? `${props.member.name} · ${university.value}`
    : props.member.name,
);
/** What screen readers hear in place of the acronym. */
const spokenName = computed(() =>
  memberSpokenName(props.member, university.value),
);

const tapGuard = useTouchTapGuard();
</script>

<template>
  <span
    class="inline-flex max-w-full min-w-0 gap-1.5"
    :class="wrap ? 'items-start' : 'items-center'"
  >
    <UPopover
      v-if="tooltip"
      mode="hover"
      :open-delay="200"
      :close-delay="100"
      :enable-touch="true"
    >
      <UBadge
        :color="color"
        :variant="variant"
        :size="size"
        tabindex="0"
        class="focus-visible:outline-primary shrink-0 font-semibold tracking-wide focus-visible:outline-2 focus-visible:outline-offset-2"
        @pointerdown="tapGuard.pointerdown"
        @click="tapGuard.click"
      >
        <span :aria-hidden="showName || nameRepeats ? undefined : 'true'">{{
          member.acronym
        }}</span>
        <span v-if="!showName && !nameRepeats" class="sr-only">{{
          spokenName
        }}</span>
      </UBadge>
      <template #content>
        <div class="w-max max-w-sm p-3" aria-hidden="true">
          <CommonMemberCard :member="member" :members="members" tag />
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
        spokenName
      }}</span>
    </UBadge>
    <span
      v-if="showName && !nameRepeats"
      class="text-default min-w-0 text-sm"
      :class="wrap ? 'py-0.5 break-words' : 'truncate'"
    >
      {{ shownName }}
    </span>
  </span>
</template>
