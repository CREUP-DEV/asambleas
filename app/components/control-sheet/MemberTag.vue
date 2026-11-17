<script setup lang="ts">
import type { MemberDto, MemberRef } from "~~/shared/types/api";
import { accountAvatarText } from "~~/shared/utils/accountAvatar";

/**
 * A member in the control sheet: the coloured acronym tag used across the
 * platform (CommonMemberBadge) that opens, on hover, a card with its
 * avatar, full name, kind and university (for a CEA office, who holds
 * it, which only those who see the offices receive). Screen readers get the full name
 * from the tag itself. `member` is what the server sent (an office reads
 * "CEA" to whoever may not see it); `members` adds the university, and a
 * member missing from it shows what it carries.
 */
const props = defineProps<{
  member: MemberRef;
  members: ReadonlyMap<string, MemberDto>;
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
  <UPopover mode="hover" :open-delay="200" :close-delay="100">
    <CommonMemberBadge :member="member" size="sm" :tooltip="false" />
    <template #content>
      <div class="flex max-w-xs items-center gap-3 p-3" aria-hidden="true">
        <CommonAccountAvatar :alt="member.name" :text="avatarText" size="md" />
        <div class="min-w-0">
          <p class="text-highlighted text-sm font-semibold">
            {{ member.name }}
          </p>
          <p class="text-muted text-xs">{{ detail }}</p>
        </div>
      </div>
    </template>
  </UPopover>
</template>
