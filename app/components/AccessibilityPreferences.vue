<script setup lang="ts">
import type { RadioGroupItem } from "@nuxt/ui";
import {
  CONTENT_FONTS,
  DIFF_DISPLAY_MODES,
  isContentFont,
  isDiffDisplayMode,
} from "~/composables/accessibility/useAccessibilityPreferences";

/**
 * Preferences for document and amendment content only (UI chrome keeps its
 * own font). The previews use the same classes as real content, so what is
 * shown here is exactly how diffs and text will look.
 */
const { t } = useI18n();
const { diffDisplayMode, contentFont, contentFontFamily } =
  useAccessibilityPreferences();

const diffModeItems = computed<RadioGroupItem[]>(() =>
  DIFF_DISPLAY_MODES.map((value) => ({
    value,
    label: t(`accessibility.diffMode.${value}`),
  })),
);
const fontItems = computed<RadioGroupItem[]>(() =>
  CONTENT_FONTS.map((value) => ({
    value,
    label: t(`accessibility.font.${value}`),
  })),
);

const diffModeModel = computed({
  get: () => diffDisplayMode.value,
  set: (value: unknown) => {
    if (isDiffDisplayMode(value)) diffDisplayMode.value = value;
  },
});
const fontModel = computed({
  get: () => contentFont.value,
  set: (value: unknown) => {
    if (isContentFont(value)) contentFont.value = value;
  },
});
</script>

<template>
  <!-- The dialog that holds it carries the title. -->
  <div class="space-y-6">
    <div class="space-y-3">
      <URadioGroup
        v-model="diffModeModel"
        :legend="t('accessibility.diffModeLabel')"
        :items="diffModeItems"
      />
      <!-- The diff classes follow the <html> diff-color / diff-marks class. -->
      <p class="border-default content-font rounded border p-3 text-sm">
        <ins class="cx-ins">{{ t("accessibility.diffPreviewInsert") }}</ins>
        {{ " " }}
        <del class="cx-del">{{ t("accessibility.diffPreviewDelete") }}</del>
      </p>
    </div>

    <div class="space-y-3">
      <URadioGroup
        v-model="fontModel"
        :legend="t('accessibility.contentFontLabel')"
        :items="fontItems"
      />
      <p
        class="border-default rounded border p-3 text-sm"
        :style="{ fontFamily: contentFontFamily }"
      >
        {{ t("accessibility.fontPreviewText") }}
      </p>
    </div>
  </div>
</template>
