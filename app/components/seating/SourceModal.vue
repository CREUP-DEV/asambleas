<script setup lang="ts">
import type { AssemblyListDto, AssemblySummaryDto } from "~~/shared/types/api";

/**
 * «Leer inscritos de otra asamblea» (docs/seating-plan.md, section 5): an
 * AGE held next to an AGO may have no Intranet event of its own, and reads
 * the AGO's attendees instead. The list of assemblies is read when the
 * dialog opens, on the client.
 */

const props = defineProps<{
  /** The assembly whose room this is: never offered. */
  assemblyId: string;
  /** Where its attendees come from now (null: its own). */
  sourceAssemblyId: string | null;
  saving: boolean;
}>();

const open = defineModel<boolean>("open", { default: false });
const emit = defineEmits<{ choose: [sourceAssemblyId: string | null] }>();

const { t } = useI18n();
const api = useApi();

/** GET /api/assemblies pages by 20: a few pages reach years back. */
const MAX_PAGES = 5;

const assemblies = ref<AssemblySummaryDto[] | null>(null);
const loading = ref(false);
const failed = ref(false);
const choice = ref<string | undefined>(undefined);

async function load(): Promise<void> {
  if (loading.value) return;
  loading.value = true;
  failed.value = false;
  try {
    const items: AssemblySummaryDto[] = [];
    for (let page = 1; page <= MAX_PAGES; page += 1) {
      const list = await api.get<AssemblyListDto>("/api/assemblies", { page });
      items.push(...list.items);
      if (list.items.length === 0 || page * list.pageSize >= list.total) break;
    }
    assemblies.value = items;
  } catch {
    failed.value = true;
  } finally {
    loading.value = false;
  }
}

watch(open, (value) => {
  if (!value) return;
  choice.value = props.sourceAssemblyId ?? undefined;
  if (!assemblies.value) void load();
});

const items = computed(() =>
  (assemblies.value ?? [])
    .filter((entry) => entry.id !== props.assemblyId)
    .map((entry) => ({ value: entry.id, label: entry.label })),
);
</script>

<template>
  <UModal
    v-model:open="open"
    :title="t('seating.source.title')"
    :description="t('seating.source.description')"
    :dismissible="!saving"
  >
    <template #body>
      <div v-if="loading" class="space-y-2" role="status">
        <span class="sr-only">{{ t("seating.source.loading") }}</span>
        <USkeleton aria-hidden="true" class="h-9 w-full" />
      </div>
      <UAlert
        v-else-if="failed"
        color="error"
        variant="subtle"
        icon="i-lucide-circle-alert"
        :title="t('seating.source.loadError')"
        :actions="[
          {
            label: t('seating.retry'),
            color: 'error',
            variant: 'outline',
            onClick: () => {
              void load();
            },
          },
        ]"
      />
      <UFormField v-else :label="t('seating.source.label')">
        <USelectMenu
          v-model="choice"
          :items="items"
          value-key="value"
          :placeholder="t('seating.source.placeholder')"
          :search-input="{ placeholder: t('seating.source.search') }"
          class="w-full"
        />
      </UFormField>
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
          icon="i-lucide-users"
          :label="t('seating.source.confirm')"
          :loading="saving"
          :disabled="!choice || choice === sourceAssemblyId"
          @click="emit('choose', choice ?? null)"
        />
      </div>
    </template>
  </UModal>
</template>
