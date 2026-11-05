<script setup lang="ts">
import { RELATION_KINDS, type RelationKind } from "~~/shared/constants/domain";
import type { AmendmentDto, RelationDto } from "~~/shared/types/api";
import type { AmendmentRelationView } from "~/composables/amendment/workspace";

/**
 * Relations of an amendment with others of the same document
 * (incompatible, duplicate, depends on...). Moderators, reviewers and the
 * proponent add and remove them; drafts cannot be related.
 */
const props = withDefaults(
  defineProps<{
    amendment: AmendmentDto;
    relations: AmendmentRelationView[];
    /** Amendments it can be related to (submitted ones, itself excluded). */
    candidates: AmendmentDto[];
    labelOf: (id: string) => string;
    /** Base URL of the document's amendments: .../amendments. */
    amendmentsUrl: string;
    canManage?: boolean;
  }>(),
  { canManage: false },
);

const emit = defineEmits<{
  changed: [];
  select: [id: string];
}>();

const { t } = useI18n();
const api = useApi();
const toast = useToast();
const titleId = useId();

/** Links across documents are not created here: both ends share the document. */
type LocalRelationKind = Exclude<RelationKind, "same_in_other_document">;
const LOCAL_KINDS = RELATION_KINDS.filter(
  (value): value is LocalRelationKind => value !== "same_in_other_document",
);

const adding = ref(false);
const saving = ref(false);
const removing = ref<string | null>(null);
const targetId = ref<string | undefined>(undefined);
const kind = ref<LocalRelationKind>("incompatible");
const note = ref("");

const manageable = computed(
  () => props.canManage && props.amendment.status !== "draft",
);

const targetItems = computed(() =>
  props.candidates
    .filter((candidate) => candidate.id !== props.amendment.id)
    .map((candidate) => ({
      label: props.labelOf(candidate.id),
      description: candidate.authors.map((author) => author.acronym).join(", "),
      value: candidate.id,
    })),
);
const kindItems = computed(() =>
  LOCAL_KINDS.map((value) => ({
    label: t(`amendment.relations.kinds.${value}`),
    value,
  })),
);

function relationLabel(view: AmendmentRelationView): string {
  return view.direction === "from"
    ? t(`amendment.relations.kinds.${view.relation.kind}`)
    : t(`amendment.relations.inverse.${view.relation.kind}`);
}

function resetForm(): void {
  targetId.value = undefined;
  kind.value = "incompatible";
  note.value = "";
}

async function add(): Promise<void> {
  if (!targetId.value) return;
  saving.value = true;
  try {
    await api.send<RelationDto>(`${props.amendmentsUrl}/relations`, {
      body: {
        fromId: props.amendment.id,
        toId: targetId.value,
        kind: kind.value,
        note: note.value.trim() || null,
      },
    });
    toast.add({
      title: t("amendment.relations.added"),
      color: "success",
      icon: "i-lucide-link-2",
    });
    resetForm();
    adding.value = false;
    emit("changed");
  } catch (error) {
    api.notifyError(error, "amendment.relations.addFailed");
    if (api.isConflict(error)) emit("changed");
  } finally {
    saving.value = false;
  }
}

async function remove(view: AmendmentRelationView): Promise<void> {
  removing.value = view.relation.id;
  try {
    await api.send(`${props.amendmentsUrl}/relations/${view.relation.id}`, {
      method: "DELETE",
    });
    toast.add({
      title: t("amendment.relations.removed"),
      color: "success",
      icon: "i-lucide-unlink",
    });
    emit("changed");
  } catch (error) {
    api.notifyError(error, "amendment.relations.removeFailed");
    if (api.isConflict(error) || api.errorStatus(error) === 404) {
      emit("changed");
    }
  } finally {
    removing.value = null;
  }
}
</script>

<template>
  <section class="flex flex-col gap-3" :aria-labelledby="titleId">
    <div class="flex items-center justify-between gap-2">
      <h3 :id="titleId" class="text-highlighted text-sm font-semibold">
        {{ t("amendment.relations.title") }}
      </h3>
      <UButton
        v-if="manageable && !adding"
        icon="i-lucide-plus"
        color="neutral"
        variant="ghost"
        size="xs"
        :label="t('amendment.relations.add')"
        :disabled="targetItems.length === 0"
        @click="adding = true"
      />
    </div>

    <p v-if="relations.length === 0 && !adding" class="text-muted text-sm">
      {{ t("amendment.relations.empty") }}
    </p>

    <ul v-if="relations.length > 0" class="flex flex-col gap-2">
      <li
        v-for="view in relations"
        :key="view.relation.id"
        class="border-default flex items-start gap-2 rounded-md border px-3 py-2"
      >
        <UIcon
          name="i-lucide-link-2"
          class="text-muted mt-0.5 size-4 shrink-0"
          aria-hidden="true"
        />
        <div class="min-w-0 flex-1">
          <p class="text-sm">
            <span class="text-muted">{{ relationLabel(view) }}</span>
            {{ " " }}
            <UButton
              variant="link"
              color="primary"
              size="sm"
              class="p-0 font-semibold"
              :label="labelOf(view.otherId)"
              @click="emit('select', view.otherId)"
            />
          </p>
          <p
            v-if="view.relation.note"
            class="text-muted mt-0.5 text-xs whitespace-pre-line"
          >
            {{ view.relation.note }}
          </p>
        </div>
        <UButton
          v-if="manageable"
          icon="i-lucide-trash-2"
          color="neutral"
          variant="ghost"
          size="xs"
          :loading="removing === view.relation.id"
          :disabled="removing !== null"
          :aria-label="
            t('amendment.relations.remove', {
              relation: relationLabel(view),
              label: labelOf(view.otherId),
            })
          "
          @click="remove(view)"
        />
      </li>
    </ul>

    <form
      v-if="adding"
      class="border-default bg-elevated/40 flex flex-col gap-3 rounded-md border p-3"
      @submit.prevent="add"
    >
      <UFormField :label="t('amendment.relations.kind')" required>
        <USelect v-model="kind" :items="kindItems" class="w-full" />
      </UFormField>
      <UFormField :label="t('amendment.relations.target')" required>
        <USelectMenu
          v-model="targetId"
          :items="targetItems"
          value-key="value"
          class="w-full"
          :placeholder="t('amendment.relations.targetPlaceholder')"
          :aria-label="
            selectMenuLabel(
              t('amendment.relations.target'),
              targetItems,
              targetId,
              t('amendment.relations.targetPlaceholder'),
            )
          "
          :search-input="labelledSearch(t('amendment.relations.targetSearch'))"
        />
      </UFormField>
      <UFormField :label="t('amendment.relations.note')">
        <UInput
          v-model="note"
          class="w-full"
          :maxlength="2000"
          :placeholder="t('amendment.relations.notePlaceholder')"
        />
      </UFormField>
      <div class="flex flex-wrap justify-end gap-2">
        <UButton
          color="neutral"
          variant="ghost"
          :label="t('amendment.actions.cancel')"
          :disabled="saving"
          @click="
            adding = false;
            resetForm();
          "
        />
        <UButton
          type="submit"
          icon="i-lucide-link-2"
          :loading="saving"
          :disabled="!targetId"
          :label="t('amendment.relations.save')"
        />
      </div>
    </form>
  </section>
</template>
