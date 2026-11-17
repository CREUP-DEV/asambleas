<script setup lang="ts">
import type { MemberDto, MemberRef } from "~~/shared/types/api";
import type { SheetRowDocument } from "./-model";

/**
 * Who presents the documents of a row of «General»: each main presenter
 * once, in the order of the documents under the row's title, then «+N» for
 * their co-presenters (ControlSheetMemberTags).
 */
const props = defineProps<{
  documents: SheetRowDocument[];
  /** Every member by id, for the cards. */
  members: ReadonlyMap<string, MemberDto>;
}>();

const { t } = useI18n();

const presenters = computed(() => {
  const main = new Map<string, MemberRef>();
  for (const document of props.documents) {
    if (document.proponent) main.set(document.proponent.id, document.proponent);
  }
  const others = new Map<string, MemberRef>();
  for (const document of props.documents) {
    for (const member of document.coProponents) {
      if (!main.has(member.id)) others.set(member.id, member);
    }
  }
  return { main: [...main.values()], others: [...others.values()] };
});

/** A document stored without a main presenter, from before it was required. */
const missing = computed(() =>
  props.documents.some((document) => !document.proponent),
);
</script>

<template>
  <div
    v-if="documents.length > 0"
    class="flex flex-wrap items-center gap-1 [justify-content:inherit]"
  >
    <ControlSheetMemberTags
      :main="presenters.main"
      :others="presenters.others"
      :members="members"
      class="[justify-content:inherit]"
    />
    <span v-if="missing" class="text-dimmed text-sm">{{
      t("controlSheet.proponentNone")
    }}</span>
  </div>
</template>
