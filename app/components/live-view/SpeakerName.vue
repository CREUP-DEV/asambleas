<script setup lang="ts">
import type { SpeakingTurnDto } from "~~/shared/types/api";
import { useMemberDirectory } from "~/composables/members/useMemberDirectory";

/**
 * One speaking turn: the member it speaks for (acronym badge, full name for
 * screen readers) and the person's name when the Mesa wrote it, or else the
 * member's name. Councils share the same or nearly the same denomination
 * ("Consejo de Estudiantes"), so a council reads by its university instead,
 * and after the person's name when there is one (useMemberDirectory, once
 * the members are read); every other member by its denomination. The text
 * inherits the size of its container, so the same markup serves the phone
 * view and the projection. The badge keeps the colours every member tag
 * has, also for the one who has the floor.
 */
const props = withDefaults(
  defineProps<{
    turn: Pick<SpeakingTurnDto, "member" | "speaker">;
    badgeSize?: "sm" | "md" | "lg" | "xl";
    /** Opens the member's card on hover; never on the projection. */
    tooltip?: boolean;
  }>(),
  { badgeSize: "md", tooltip: true },
);

const { t } = useI18n();

const speaker = computed(() => props.turn.speaker?.trim() || null);

const directory = useMemberDirectory();
const isCouncil = computed(() => props.turn.member?.kind === "asociado");
onMounted(() => {
  if (isCouncil.value) void directory.load();
});
watch(isCouncil, (council) => {
  if (council) void directory.load();
});
/** A council's university, once the members are read. */
const university = computed(() => {
  const member = props.turn.member;
  if (!isCouncil.value || !member?.id) return null;
  return directory.byId.value.get(member.id)?.university?.trim() || null;
});
</script>

<template>
  <span class="inline-flex max-w-full min-w-0 flex-wrap items-center gap-x-2">
    <CommonMemberBadge
      v-if="turn.member"
      :member="turn.member"
      :size="badgeSize"
      :tooltip="tooltip"
    />
    <template v-if="speaker">
      <span class="min-w-0 break-words">{{ speaker }}</span>
      <span
        v-if="university"
        class="text-muted min-w-0 font-medium break-words"
      >
        · {{ university }}
      </span>
    </template>
    <span v-else-if="university" class="min-w-0 break-words">
      {{ university }}
    </span>
    <!-- The badge already gives screen readers the member's name; a name
         that only repeats the acronym is not shown twice. -->
    <template v-else-if="turn.member">
      <span
        v-if="!memberNameRepeatsAcronym(turn.member)"
        class="min-w-0 break-words"
        aria-hidden="true"
      >
        {{ turn.member.name }}
      </span>
    </template>
    <span v-else class="text-muted font-medium">
      {{ t("liveView.speakers.unnamed") }}
    </span>
  </span>
</template>
