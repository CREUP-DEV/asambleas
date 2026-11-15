<script setup lang="ts">
import {
  SEATING_MANUAL_GROUP_KINDS,
  type SeatingManualGroupKind,
} from "~~/shared/constants/domain";
import type {
  SeatingGroupDto,
  SeatingGroupUpdateBody,
} from "~~/shared/types/api";
import { SEATING_LIMITS } from "~~/shared/utils/schemas/seating";

/**
 * «Editar grupo» of the tray: the acronym, name and kind of a group made by
 * hand («Prensa»). The kind says where Proponer reparto seats it and its
 * colour. Groups from the Intranet and the Mesa are not edited here.
 */

const props = defineProps<{
  group: SeatingGroupDto | null;
  saving: boolean;
}>();

const open = defineModel<boolean>("open", { default: false });
const emit = defineEmits<{
  save: [changes: Omit<SeatingGroupUpdateBody, "updatedAt">];
}>();

const { t } = useI18n();

const acronym = ref("");
const name = ref("");
const kind = ref<SeatingManualGroupKind>("other");
const tried = ref(false);

watch(open, (value) => {
  if (!value || !props.group) return;
  tried.value = false;
  acronym.value = props.group.acronym;
  name.value = props.group.name;
  const current = props.group.kind;
  kind.value = (SEATING_MANUAL_GROUP_KINDS as readonly string[]).includes(
    current,
  )
    ? (current as SeatingManualGroupKind)
    : "other";
});

const kindItems = computed(() =>
  SEATING_MANUAL_GROUP_KINDS.map((value) => ({
    value,
    label: t(`seating.groups.kinds.${value}`),
  })),
);

const clean = (value: string) => value.replace(/\s+/g, " ").trim();

function submit(): void {
  tried.value = true;
  const group = props.group;
  if (!group || props.saving) return;
  if (!clean(acronym.value) || !clean(name.value)) return;
  const changes: Omit<SeatingGroupUpdateBody, "updatedAt"> = {};
  if (clean(acronym.value) !== group.acronym) {
    changes.acronym = clean(acronym.value);
  }
  if (clean(name.value) !== group.name) changes.name = clean(name.value);
  if (kind.value !== group.kind) changes.kind = kind.value;
  emit("save", changes);
}
</script>

<template>
  <UModal
    v-model:open="open"
    :title="t('seating.groups.editTitle', { acronym: group?.acronym ?? '' })"
    :dismissible="!saving"
  >
    <template #body>
      <form
        id="seating-group-form"
        class="grid gap-3 sm:grid-cols-2"
        novalidate
        @submit.prevent="submit"
      >
        <UFormField
          :label="t('seating.groups.acronym')"
          :hint="t('seating.groups.acronymHint')"
          :error="
            tried && !clean(acronym) ? t('seating.people.required') : undefined
          "
          required
        >
          <UInput
            v-model="acronym"
            :maxlength="SEATING_LIMITS.acronym"
            class="w-full"
          />
        </UFormField>
        <UFormField :label="t('seating.groups.kind')">
          <USelect
            v-model="kind"
            :items="kindItems"
            value-key="value"
            class="w-full"
          />
        </UFormField>
        <UFormField
          class="sm:col-span-2"
          :label="t('seating.groups.name')"
          :error="
            tried && !clean(name) ? t('seating.people.required') : undefined
          "
          required
        >
          <UInput
            v-model="name"
            :maxlength="SEATING_LIMITS.groupName"
            class="w-full"
          />
        </UFormField>
      </form>
    </template>
    <template #footer>
      <div class="flex w-full flex-wrap justify-end gap-2">
        <UButton
          color="neutral"
          variant="outline"
          :label="t('common.cancel')"
          :disabled="saving"
          @click="open = false"
        />
        <UButton
          type="submit"
          form="seating-group-form"
          icon="i-lucide-save"
          :label="t('common.save')"
          :loading="saving"
        />
      </div>
    </template>
  </UModal>
</template>
