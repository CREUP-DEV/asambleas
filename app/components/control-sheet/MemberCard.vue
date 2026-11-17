<script setup lang="ts">
import type { MemberDto, MemberRef } from "~~/shared/types/api";
import { accountAvatarText } from "~~/shared/utils/accountAvatar";

/**
 * A member as the control sheet's hover cards show it: its avatar (the
 * text accounts acting for it read), its whole denomination, never cut,
 * and under it its kind with a council's university or who holds a CEA
 * office (only those who see the offices receive it). `member` is what the
 * server sent (an office reads "CEA" to whoever may not see it); `members`
 * adds the university and the holder, and a member missing from it shows
 * what it carries. `tag` puts its acronym tag before the name, for lists
 * where the avatar alone would not name it (a council's avatar reads its
 * university's acronym).
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
const name = computed(() =>
  memberNameRepeatsAcronym(props.member) ? null : props.member.name.trim(),
);

/**
 * "Asociado · Universidad de Granada", "CEA · Ana Pérez García" (who holds
 * the office), or just the kind without either.
 */
const detail = computed(() => {
  const kind = t(`shell.memberKinds.${props.member.kind}`);
  const extra =
    props.member.kind === "executive"
      ? full.value?.holderName?.trim()
      : full.value?.university?.trim();
  return extra && extra !== props.member.name ? `${kind} · ${extra}` : kind;
});
</script>

<template>
  <div class="flex items-center gap-3">
    <CommonAccountAvatar :alt="member.name" :text="avatarText" size="md" />
    <div class="min-w-0">
      <p
        class="text-highlighted flex flex-wrap items-center gap-x-1.5 gap-y-0.5 text-sm font-semibold"
      >
        <CommonMemberBadge
          v-if="tag"
          :member="member"
          size="sm"
          :tooltip="false"
        />
        <span v-if="name" class="break-words">{{ name }}</span>
      </p>
      <p class="text-muted text-xs break-words">{{ detail }}</p>
    </div>
  </div>
</template>
