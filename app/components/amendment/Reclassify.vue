<script setup lang="ts">
import type { AmendmentDto, ReclassifyBody } from "~~/shared/types/api";
import { reclassifyTarget } from "~~/shared/utils/amendmentReclassify";

/**
 * The Secretaría moves a presented, undecided amendment between "de forma"
 * and "de contenido" (POST .../reclassify): one line saying what it is now
 * and one button to change it. The parent shows it only to those who review
 * amendments, while the amendment can be reclassified
 * (canReclassifyAmendment). The change is recorded in the history and its
 * authors read it in their news, so it asks for no confirmation: the same
 * button takes it back.
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

const { t } = useI18n();
const api = useApi();
const toast = useToast();

const busy = ref(false);
const target = computed(() => reclassifyTarget(props.amendment.kind));

async function reclassify(): Promise<void> {
  const kind = target.value;
  if (!kind || busy.value) return;
  busy.value = true;
  try {
    const body: ReclassifyBody = {
      kind,
      updatedAt: props.amendment.updatedAt,
    };
    const updated = await api.send<AmendmentDto>(`${props.url}/reclassify`, {
      body,
    });
    toast.add({
      title: t(`amendment.reclassify.done.${kind}`),
      description: t("amendment.reclassify.doneDescription"),
      color: "success",
      icon: "i-lucide-tags",
    });
    emit("updated", updated);
  } catch (error) {
    api.notifyError(error, "amendment.reclassify.failed");
    if (api.isConflict(error)) emit("conflict");
  } finally {
    busy.value = false;
  }
}
</script>

<template>
  <section
    v-if="target"
    class="border-default flex flex-wrap items-center gap-x-3 gap-y-2 rounded-lg border p-3 sm:p-4"
    :aria-label="t('amendment.reclassify.label')"
  >
    <p class="text-default min-w-0 flex-1 basis-48 text-sm" aria-live="polite">
      {{ t(`amendment.reclassify.current.${amendment.kind}`) }}
    </p>
    <UButton
      icon="i-lucide-tags"
      color="neutral"
      variant="outline"
      size="sm"
      :loading="busy"
      :label="t(`amendment.reclassify.action.${target}`)"
      @click="reclassify"
    />
  </section>
</template>
