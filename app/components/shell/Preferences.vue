<script setup lang="ts">
/**
 * Everything a person can set to their taste, in one place and in plain
 * sight: language, light or dark theme, single-key shortcuts (the review
 * of amendments and the Mesa console offer the same switch) and how
 * document content looks (AccessibilityPreferences). The "Preferencias"
 * dialog of the user menu and the last step of the welcome both show it.
 * Every choice applies at once; nothing here needs saving.
 */
import { PERMISSION_KEYS } from "~~/shared/constants/permissions";

const { t, locale } = useI18n();
const { localeItems, switchToLocale } = useLocaleSwitcher();
const colorMode = useColorMode();
const { enabled: singleKeyShortcuts } = useSingleKeyShortcuts();
const me = useMe();

/**
 * Every reader has J and K between amendments; the Mesa console is named
 * only to accounts that open it.
 */
const singleKeyShortcutsHint = computed(() =>
  me.can(PERMISSION_KEYS.SESSION_MODERATE)
    ? t("shell.preferences.singleKeyShortcutsHintMesa")
    : t("shell.preferences.singleKeyShortcutsHint"),
);

const COLOR_MODES = [
  { value: "system", icon: "i-lucide-monitor" },
  { value: "light", icon: "i-lucide-sun" },
  { value: "dark", icon: "i-lucide-moon" },
] as const;

interface IconItem {
  value: string;
  label: string;
  icon: string;
}

const languageItems = computed<IconItem[]>(() =>
  localeItems.value.map((item) => ({
    value: item.value,
    label: item.label,
    icon: item.icon,
  })),
);
const themeItems = computed<IconItem[]>(() =>
  COLOR_MODES.map((mode) => ({
    value: mode.value,
    label: t(`shell.user.themes.${mode.value}`),
    icon: mode.icon,
  })),
);

const languageModel = computed({
  get: () => locale.value as string,
  set: (value: unknown) => {
    if (typeof value === "string") switchToLocale(value);
  },
});
const themeModel = computed({
  get: () => colorMode.preference,
  set: (value: unknown) => {
    if (COLOR_MODES.some((mode) => mode.value === value)) {
      colorMode.preference = value as string;
    }
  },
});

/**
 * Choices side by side, each on one line ("Según el sistema" broke in two
 * and left its radio above its icon), wrapping as a whole on a narrow screen.
 */
const choicesUi = {
  fieldset: "flex-wrap gap-y-2",
  item: "min-w-fit flex-1 items-center",
  label: "whitespace-nowrap",
};

function iconOf(item: unknown): string {
  return (item as IconItem).icon;
}
function labelOf(item: unknown): string {
  return (item as IconItem).label;
}
</script>

<template>
  <div class="space-y-6">
    <URadioGroup
      v-model="languageModel"
      :legend="t('shell.preferences.language')"
      :items="languageItems"
      orientation="horizontal"
      variant="card"
      :ui="choicesUi"
    >
      <template #label="{ item }">
        <span class="flex items-center gap-2">
          <UIcon
            :name="iconOf(item)"
            class="size-5 shrink-0"
            aria-hidden="true"
          />
          {{ labelOf(item) }}
        </span>
      </template>
    </URadioGroup>

    <URadioGroup
      v-model="themeModel"
      :legend="t('shell.preferences.theme')"
      :items="themeItems"
      orientation="horizontal"
      variant="card"
      :ui="choicesUi"
    >
      <template #label="{ item }">
        <span class="flex items-center gap-2">
          <UIcon
            :name="iconOf(item)"
            class="size-5 shrink-0"
            aria-hidden="true"
          />
          {{ labelOf(item) }}
        </span>
      </template>
    </URadioGroup>

    <USwitch
      v-model="singleKeyShortcuts"
      :label="t('shell.preferences.singleKeyShortcuts')"
      :description="singleKeyShortcutsHint"
    />

    <USeparator />

    <div class="space-y-3">
      <p class="text-muted text-sm">
        {{ t("shell.preferences.contentHint") }}
      </p>
      <AccessibilityPreferences />
    </div>
  </div>
</template>
