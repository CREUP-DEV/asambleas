<script setup lang="ts">
import type { Block } from "~~/shared/types/content";

/**
 * The user's own text, kept after a save conflict: someone else saved the
 * draft first, the editor now shows their version, and this panel lets the
 * user restore theirs (to save it over), copy it, or discard it.
 */
const props = defineProps<{
  blocks: Block[];
}>();

const emit = defineEmits<{
  restore: [];
  discard: [];
}>();

const { t } = useI18n();
const toast = useToast();
const { copy, isSupported } = useClipboard({ legacy: true });

const expanded = ref(false);
const titleId = useId();

const plainText = computed(() =>
  props.blocks.map((block) => block.text).join("\n\n"),
);

async function copyText(): Promise<void> {
  try {
    await copy(plainText.value);
    toast.add({
      title: t("document.recovery.copied"),
      color: "success",
      icon: "i-lucide-clipboard-check",
    });
  } catch {
    toast.add({
      title: t("document.recovery.copyFailed"),
      color: "error",
      icon: "i-lucide-circle-alert",
    });
  }
}
</script>

<template>
  <section
    class="border-warning/40 bg-warning/5 space-y-3 rounded-md border p-3 sm:p-4"
    :aria-labelledby="titleId"
  >
    <div class="flex items-start gap-3">
      <UIcon
        name="i-lucide-life-buoy"
        class="text-warning mt-0.5 size-5 shrink-0"
        aria-hidden="true"
      />
      <div class="min-w-0 flex-1 space-y-1" role="alert">
        <p :id="titleId" class="text-highlighted text-sm font-semibold">
          {{ t("document.recovery.title") }}
        </p>
        <p class="text-muted text-sm">
          {{ t("document.recovery.description") }}
        </p>
      </div>
    </div>

    <div class="flex flex-wrap gap-2">
      <UButton
        icon="i-lucide-history"
        color="warning"
        size="sm"
        :label="t('document.recovery.restore')"
        @click="emit('restore')"
      />
      <UButton
        v-if="isSupported"
        icon="i-lucide-copy"
        color="neutral"
        variant="outline"
        size="sm"
        :label="t('document.recovery.copy')"
        @click="copyText"
      />
      <UButton
        icon="i-lucide-x"
        color="neutral"
        variant="ghost"
        size="sm"
        :label="t('document.recovery.discard')"
        @click="emit('discard')"
      />
    </div>

    <UCollapsible v-model:open="expanded">
      <UButton
        color="neutral"
        variant="link"
        size="sm"
        :icon="expanded ? 'i-lucide-chevron-up' : 'i-lucide-chevron-down'"
        :label="
          expanded ? t('document.recovery.hide') : t('document.recovery.show')
        "
        class="px-0"
      />
      <template #content>
        <div
          class="border-default bg-default mt-2 max-h-80 overflow-y-auto rounded-md border p-3 sm:p-4"
          tabindex="0"
          role="region"
          :aria-label="t('document.recovery.yourVersion')"
        >
          <ContentView :blocks="blocks" />
        </div>
      </template>
    </UCollapsible>
  </section>
</template>
