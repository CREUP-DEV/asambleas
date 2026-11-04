<script setup lang="ts">
import type { DropdownMenuItem } from "@nuxt/ui";
import { roleLabelKey } from "./RoleBadge.vue";

/**
 * Sidebar footer: who is signed in (avatar, name, member acronym, role) and
 * a menu with accessibility preferences, language, colour mode and sign out.
 */
const props = defineProps<{ collapsed?: boolean }>();

const { t } = useI18n();
const { me, member } = useMe();
const { signOut } = useAuth();
const { localeMenuItems } = useLocaleSwitcher();
const colorMode = useColorMode();

const preferencesOpen = ref(false);
const signingOut = ref(false);

const name = computed(() => me.value?.name || me.value?.email || "");

const initials = computed(() =>
  name.value
    .split(/\s+/)
    .filter(Boolean)
    .map((word: string) => word[0])
    .join("")
    .slice(0, 2)
    .toUpperCase(),
);

const roleLabel = computed(() => {
  const role = me.value?.role ?? null;
  const key = roleLabelKey(role);
  return key ? t(key) : role;
});

const subtitle = computed(() =>
  [member.value?.acronym, roleLabel.value].filter(Boolean).join(" · "),
);

const avatar = computed(() => ({
  src: me.value?.image ?? undefined,
  alt: name.value,
  text: initials.value || undefined,
}));

const COLOR_MODES = [
  { value: "system", icon: "i-lucide-monitor" },
  { value: "light", icon: "i-lucide-sun" },
  { value: "dark", icon: "i-lucide-moon" },
] as const;

async function handleSignOut(): Promise<void> {
  if (signingOut.value) return;
  signingOut.value = true;
  try {
    await signOut();
  } finally {
    signingOut.value = false;
  }
}

const items = computed<DropdownMenuItem[][]>(() => [
  [
    {
      type: "label",
      label: name.value,
      description: me.value?.email,
      avatar: avatar.value,
    },
  ],
  [
    {
      label: t("shell.user.accessibility"),
      icon: "i-lucide-accessibility",
      onSelect: () => {
        preferencesOpen.value = true;
      },
    },
    {
      label: t("shell.user.language"),
      icon: "i-lucide-languages",
      children: localeMenuItems.value,
    },
    {
      label: t("shell.user.theme"),
      icon: "i-lucide-sun-moon",
      children: COLOR_MODES.map((mode) => ({
        label: t(`shell.user.themes.${mode.value}`),
        icon: mode.icon,
        type: "checkbox" as const,
        checked: colorMode.preference === mode.value,
        onSelect: (event: Event) => {
          event.preventDefault();
          colorMode.preference = mode.value;
        },
      })),
    },
  ],
  [
    {
      label: t("shell.user.signOut"),
      icon: "i-lucide-log-out",
      onSelect: handleSignOut,
    },
  ],
]);
</script>

<template>
  <div class="w-full">
    <UDropdownMenu
      :items="items"
      :content="{
        align: props.collapsed ? 'end' : 'center',
        side: props.collapsed ? 'right' : 'top',
        collisionPadding: 12,
      }"
      :ui="{
        content: props.collapsed
          ? 'w-64'
          : 'w-(--reka-dropdown-menu-trigger-width) min-w-56',
      }"
    >
      <UButton
        color="neutral"
        variant="ghost"
        :block="!props.collapsed"
        :square="props.collapsed"
        :loading="signingOut"
        class="data-[state=open]:bg-elevated w-full justify-start gap-2.5 py-1.5"
        :class="props.collapsed ? 'justify-center' : ''"
        :aria-label="t('shell.user.menu', { name })"
      >
        <UAvatar v-bind="avatar" size="sm" class="shrink-0" />
        <span v-if="!props.collapsed" class="min-w-0 flex-1 text-start">
          <span class="text-highlighted block truncate text-sm font-medium">
            {{ name }}
          </span>
          <span v-if="subtitle" class="text-muted block truncate text-xs">
            {{ subtitle }}
          </span>
        </span>
        <UIcon
          v-if="!props.collapsed"
          name="i-lucide-chevrons-up-down"
          class="text-dimmed size-4 shrink-0"
          aria-hidden="true"
        />
      </UButton>
    </UDropdownMenu>

    <UModal
      v-model:open="preferencesOpen"
      :title="t('shell.user.accessibility')"
      :description="t('shell.user.accessibilityDescription')"
    >
      <template #body>
        <AccessibilityPreferences />
      </template>
      <template #footer="{ close }">
        <div class="flex w-full justify-end">
          <UButton color="neutral" variant="soft" @click="close">
            {{ t("shell.user.done") }}
          </UButton>
        </div>
      </template>
    </UModal>
  </div>
</template>
