<script setup lang="ts">
import type { MemberDto, MemberRef } from "~~/shared/types/api";
import { accountAvatarText } from "~~/shared/utils/accountAvatar";

/**
 * A member as the control sheet's hover cards show it: its avatar (the
 * text accounts acting for it read) and, never cut, what tells it apart:
 * a council's university first, with its kind and its denomination under
 * it, since councils share the same or nearly the same denomination
 * (user's decision of 2026-11-17); any other member's denomination, with
 * its kind and who holds a CEA office under it (only those who see the
 * offices receive the holder). `member` is what the server sent (an office
 * reads "CEA" to whoever may not see it); `members` adds the university
 * and the holder, and a member missing from it shows what it carries.
 * `tag` starts the line under the name with its acronym tag (the name is
 * never split by it), where the avatar alone would not name it (a
 * council's avatar reads its university's acronym).
 */
const props = defineProps<{
  member: MemberRef;
  members: ReadonlyMap<string, MemberDto>;
  tag?: boolean;
}>();

const { t } = useI18n();

const full = computed(() => props.members.get(props.member.id));

/** The text of the member's avatar, as accounts acting for it read it. */
const avatarText = computed(() =>
  accountAvatarText(
    { universityAcronym: null },
    {
      ...props.member,
      universityAcronym: full.value?.universityAcronym ?? null,
    },
  ),
);

/** Its denomination, unless it repeats the acronym. */
const denomination = computed(() =>
  memberNameRepeatsAcronym(props.member) ? null : props.member.name.trim(),
);

/** A council's university (any member but an office with one). */
const university = computed(() =>
  props.member.kind === "executive"
    ? null
    : full.value?.university?.trim() || null,
);

/** The line in bold: the university when there is one. */
const name = computed(() => university.value ?? denomination.value);

/**
 * "Asociado · Consejo de Estudiantes" under a university, "CEA · Ana
 * Pérez García" (who holds the office), or just the kind.
 */
const detail = computed(() => {
  const kind = t(`shell.memberKinds.${props.member.kind}`);
  const extra = university.value
    ? denomination.value
    : props.member.kind === "executive"
      ? full.value?.holderName?.trim()
      : null;
  return extra && extra !== name.value ? `${kind} · ${extra}` : kind;
});
</script>

<template>
  <div class="flex items-center gap-3">
    <CommonAccountAvatar :alt="member.name" :text="avatarText" size="md" />
    <div class="min-w-0">
      <!-- The name alone, across the whole width; the tag goes with the
           kind on the line under it, so it never splits the name. -->
      <p class="text-highlighted text-sm font-semibold break-words">
        {{ name ?? member.acronym }}
      </p>
      <p
        class="text-muted flex flex-wrap items-center gap-x-1.5 gap-y-0.5 text-xs"
      >
        <CommonMemberBadge
          v-if="tag"
          :member="member"
          size="sm"
          :tooltip="false"
          class="shrink-0"
        />
        <span class="break-words">{{ detail }}</span>
      </p>
    </div>
  </div>
</template>
