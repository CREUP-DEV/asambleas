<script setup lang="ts">
import { RELATION_KINDS, type RelationKind } from "~~/shared/constants/domain";
import { useSessionConsoleContext } from "~/composables/session/useSessionConsole";

/**
 * Links the amendment in the dialog with another one of the same document
 * (incompatible, duplicate, depends on...) and lists or removes its links.
 */
const session = useSessionConsoleContext();
const { t } = useI18n();

/** Links across documents are not created here: both must share the document. */
type LocalRelationKind = Exclude<RelationKind, "same_in_other_document">;
const KINDS = RELATION_KINDS.filter(
  (kind): kind is LocalRelationKind => kind !== "same_in_other_document",
);

const open = computed({
  get: () => session.relationDialog.open,
  set: (value: boolean) => {
    session.relationDialog.open = value;
  },
});
const amendment = computed(() =>
  session.relationDialog.amendmentId
    ? (session.byId.value.get(session.relationDialog.amendmentId) ?? null)
    : null,
);

const kind = ref<LocalRelationKind>("incompatible");
const targetId = ref<string | undefined>(undefined);
const note = ref("");

watch(open, (isOpen) => {
  if (!isOpen) return;
  kind.value = "incompatible";
  targetId.value = undefined;
  note.value = "";
});

const kindItems = computed(() =>
  KINDS.map((value) => ({
    label: t(`session.enums.relationKind.${value}`),
    value,
  })),
);
const targetItems = computed(() =>
  session.amendments.value
    .filter(
      (other) => other.id !== amendment.value?.id && other.status !== "draft",
    )
    .map((other) => ({
      label: `${session.label(other.id)} · ${other.authors
        .map((author) => author.acronym)
        .join(", ")}`,
      value: other.id,
    })),
);

const existing = computed(() =>
  amendment.value
    ? session.relations.value.filter(
        (relation) =>
          relation.fromId === amendment.value!.id ||
          relation.toId === amendment.value!.id,
      )
    : [],
);

async function submit(): Promise<void> {
  if (!amendment.value || !targetId.value) return;
  const ok = await session.createRelation({
    fromId: amendment.value.id,
    toId: targetId.value,
    kind: kind.value,
    note: note.value.trim() || null,
  });
  if (ok) {
    targetId.value = undefined;
    note.value = "";
  }
}
</script>

<template>
  <UModal
    v-model:open="open"
    :title="
      t('session.relation.title', {
        code: amendment ? session.label(amendment.id) : '',
      })
    "
    :description="t('session.relation.description')"
  >
    <template #body>
      <div v-if="amendment" class="space-y-5">
        <section v-if="existing.length > 0" class="space-y-2">
          <h3 class="text-highlighted text-sm font-medium">
            {{ t("session.relation.existing") }}
          </h3>
          <ul class="border-default divide-default divide-y rounded-lg border">
            <li
              v-for="relation in existing"
              :key="relation.id"
              class="flex items-center gap-2 px-3 py-2 text-sm"
            >
              <span class="min-w-0 flex-1">
                <span class="font-semibold">{{
                  session.label(relation.fromId)
                }}</span>
                {{ t(`session.enums.relationKind.${relation.kind}`) }}
                <span class="font-semibold">{{
                  session.label(relation.toId)
                }}</span>
                <span v-if="relation.note" class="text-muted block truncate">
                  {{ relation.note }}
                </span>
              </span>
              <UButton
                icon="i-lucide-trash-2"
                color="error"
                variant="ghost"
                size="sm"
                :aria-label="t('session.relation.remove')"
                :loading="
                  Boolean(session.busy.value[`relation-${relation.id}`])
                "
                @click="session.deleteRelation(relation.id)"
              />
            </li>
          </ul>
        </section>

        <form
          id="session-relation-form"
          class="space-y-4"
          @submit.prevent="submit"
        >
          <UFormField :label="t('session.relation.kind')" name="relation-kind">
            <USelect v-model="kind" :items="kindItems" class="w-full" />
          </UFormField>
          <UFormField
            :label="t('session.relation.target')"
            name="relation-target"
            required
          >
            <USelectMenu
              v-model="targetId"
              :items="targetItems"
              value-key="value"
              :placeholder="t('session.relation.targetPlaceholder')"
              :aria-label="
                selectMenuLabel(
                  t('session.relation.target'),
                  targetItems,
                  targetId,
                  t('session.relation.targetPlaceholder'),
                )
              "
              :search-input="labelledSearch(t('common.search'))"
              class="w-full"
            />
          </UFormField>
          <UFormField :label="t('session.relation.note')" name="relation-note">
            <UTextarea
              v-model="note"
              :rows="2"
              autoresize
              :maxlength="2000"
              class="w-full"
            />
          </UFormField>
        </form>
      </div>
    </template>
    <template #footer="{ close }">
      <div class="flex w-full flex-wrap justify-end gap-2">
        <UButton
          color="neutral"
          variant="ghost"
          :label="t('common.close')"
          @click="close"
        />
        <UButton
          type="submit"
          form="session-relation-form"
          icon="i-lucide-link"
          :label="t('session.relation.submit')"
          :loading="Boolean(session.busy.value.relation)"
          :disabled="!targetId"
        />
      </div>
    </template>
  </UModal>
</template>
