<script setup lang="ts">
const { t } = useI18n();
const { diffDisplayMode, contentFont } = useAccessibilityPreferences();

const diffModeOptions = [
  { value: "color", label: "accessibility.diffMode.color" },
  { value: "marks", label: "accessibility.diffMode.marks" },
];

const fontOptions = [
  { value: "raleway", label: "accessibility.font.raleway" },
  { value: "atkinson", label: "accessibility.font.atkinson" },
  { value: "opendyslexic", label: "accessibility.font.opendyslexic" },
];
</script>

<template>
  <div class="space-y-6">
    <h3 class="text-lg font-semibold">
      {{ t("accessibility.preferences") }}
    </h3>

    <!-- Diff display mode -->
    <UFormField :label="t('accessibility.diffModeLabel')">
      <div class="flex flex-col gap-2">
        <label
          v-for="option in diffModeOptions"
          :key="option.value"
          class="flex items-center gap-2"
        >
          <input
            type="radio"
            :value="option.value"
            :checked="diffDisplayMode === option.value"
            name="diff-mode"
            class="accent-primary"
            @change="diffDisplayMode = option.value as 'color' | 'marks'"
          />
          <span class="text-sm">{{ t(option.label) }}</span>
        </label>
      </div>

      <div class="border-default mt-3 rounded border p-3 text-sm">
        <p v-if="diffDisplayMode === 'color'">
          <ins class="bg-green-100 text-green-800 no-underline">
            {{ t("accessibility.diffPreviewInsert") }}
          </ins>
          {{ " " }}
          <del class="text-red-700 line-through">
            {{ t("accessibility.diffPreviewDelete") }}
          </del>
        </p>
        <p v-else>
          <ins class="font-bold underline">
            {{ t("accessibility.diffPreviewInsert") }}
          </ins>
          {{ " " }}
          <del class="line-through">
            {{ t("accessibility.diffPreviewDelete") }}
          </del>
        </p>
      </div>
    </UFormField>

    <!-- Content font -->
    <UFormField :label="t('accessibility.contentFontLabel')">
      <div class="flex flex-col gap-2">
        <label
          v-for="option in fontOptions"
          :key="option.value"
          class="flex items-center gap-2"
        >
          <input
            type="radio"
            :value="option.value"
            :checked="contentFont === option.value"
            name="content-font"
            class="accent-primary"
            @change="
              contentFont = option.value as
                | 'raleway'
                | 'atkinson'
                | 'opendyslexic'
            "
          />
          <span class="text-sm">{{ t(option.label) }}</span>
        </label>
      </div>

      <p
        class="border-default mt-3 rounded border p-3 text-sm"
        :style="{
          fontFamily:
            contentFont === 'atkinson'
              ? 'var(--font-atkinson)'
              : contentFont === 'opendyslexic'
                ? 'var(--font-opendyslexic)'
                : 'var(--font-sans)',
        }"
      >
        {{ t("accessibility.fontPreviewText") }}
      </p>
    </UFormField>
  </div>
</template>
