<script setup lang="ts">
import {
  PROPONENT_POSITIONS,
  type ProponentPosition,
} from "~~/shared/constants/domain";
import type { AmendmentDto } from "~~/shared/types/api";

/**
 * The document proponent's position on an amendment (accept, reject,
 * transact). The proponent and the Mesa can change it while the amendment
 * is undecided (`can.position`); everyone who may see positions reads it.
 */
const props = defineProps<{
  amendment: AmendmentDto;
  /** URL of the amendment: .../amendments/{id}. */
  url: string;
}>();

const emit = defineEmits<{
  updated: [amendment: AmendmentDto];
  conflict: [];
}>();

const { t, locale } = useI18n();
const api = useApi();
const toast = useToast();

const titleId = useId();
const editing = ref(false);
const saving = ref(false);
const position = ref<ProponentPosition>("pending");
const comment = ref("");

function reset(): void {
  position.value = props.amendment.position?.position ?? "pending";
  comment.value = props.amendment.position?.comment ?? "";
}

watch(() => props.amendment.position, reset, { immediate: true });

const items = computed(() =>
  PROPONENT_POSITIONS.map((value) => ({
    label: t(`amendment.position.options.${value}`),
    description: t(`amendment.position.descriptions.${value}`),
    value,
  })),
);

function startEditing(): void {
  reset();
  editing.value = true;
}

async function save(): Promise<void> {
  saving.value = true;
  try {
    const updated = await api.send<AmendmentDto>(`${props.url}/position`, {
      method: "PUT",
      body: {
        position: position.value,
        comment: comment.value.trim() || null,
      },
    });
    editing.value = false;
    toast.add({
      title: t("amendment.position.saved"),
      color: "success",
      icon: "i-lucide-check",
    });
    emit("updated", updated);
  } catch (error) {
    api.notifyError(error, "amendment.position.saveFailed");
    if (api.isConflict(error)) emit("conflict");
  } finally {
    saving.value = false;
  }
}
</script>

<template>
  <section class="flex flex-col gap-3" :aria-labelledby="titleId">
    <div class="flex items-center justify-between gap-2">
      <h3 :id="titleId" class="text-highlighted text-sm font-semibold">
        {{ t("amendment.position.title") }}
      </h3>
      <UButton
        v-if="amendment.can.position && !editing"
        icon="i-lucide-pencil"
        color="neutral"
        variant="ghost"
        size="xs"
        :label="t('amendment.position.edit')"
        @click="startEditing"
      />
    </div>

    <template v-if="!editing">
      <div v-if="amendment.position" class="flex flex-col gap-1.5">
        <div class="flex flex-wrap items-center gap-2">
          <CommonStatusBadge
            kind="position"
            :value="amendment.position.position"
          />
          <span
            v-if="amendment.position.position !== 'pending'"
            class="text-dimmed text-xs"
          >
            {{ formatDateTime(amendment.position.updatedAt, { locale }) }}
          </span>
        </div>
        <p
          v-if="amendment.position.comment"
          class="text-default text-sm whitespace-pre-line"
        >
          {{ amendment.position.comment }}
        </p>
      </div>
      <p v-else class="text-muted text-sm">
        {{ t("amendment.position.none") }}
      </p>
    </template>

    <form v-else class="flex flex-col gap-3" @submit.prevent="save">
      <URadioGroup
        v-model="position"
        :items="items"
        :legend="t('amendment.position.label')"
        variant="card"
        size="sm"
      />
      <UFormField :label="t('amendment.position.comment')">
        <UTextarea
          v-model="comment"
          :rows="3"
          autoresize
          class="w-full"
          :maxlength="2000"
          :placeholder="t('amendment.position.commentPlaceholder')"
        />
      </UFormField>
      <div class="flex flex-wrap justify-end gap-2">
        <UButton
          color="neutral"
          variant="ghost"
          :label="t('amendment.actions.cancel')"
          :disabled="saving"
          @click="editing = false"
        />
        <UButton
          type="submit"
          icon="i-lucide-check"
          :loading="saving"
          :label="t('amendment.position.save')"
        />
      </div>
    </form>
  </section>
</template>
