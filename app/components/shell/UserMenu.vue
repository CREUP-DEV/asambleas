<script setup lang="ts">
import type { DropdownMenuItem } from "@nuxt/ui";
import { roleLabelKey } from "./RoleBadge.vue";

/**
 * Sidebar footer: who is signed in (avatar, name, member acronym, role) and
 * a menu with the account's activity, "Preferencias" (one dialog with
 * language, theme and content accessibility: ShellPreferences) and sign out. While an Admin acts as another account it shows
 * that account, and "Volver a mi cuenta" replaces signing out.
 *
 * The button truncates a long name; the menu wraps every line instead, so
 * opening it always shows the whole name, email and labels.
 */
const props = defineProps<{ collapsed?: boolean }>();

const { t } = useI18n();
const localePath = useLocalePath();
const { me, member, impersonation } = useMe();
const { signOut, stopImpersonating } = useAuth();
const { notifyError } = useApi();

const preferencesOpen = ref(false);
const signingOut = ref(false);

/**
 * The dialog opens from a menu item that is gone once the menu closes, so
 * on close focus goes back to the menu button instead of the page body.
 */
const menuButton = useTemplateRef<{ $el?: unknown }>("menuButton");
const preferencesContent = {
  onCloseAutoFocus: (event: Event) => {
    const button = menuButton.value?.$el;
    if (!(button instanceof HTMLElement) || !button.isConnected) return;
    event.preventDefault();
    button.focus();
  },
};

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

async function handleSignOut(): Promise<void> {
  if (signingOut.value) return;
  signingOut.value = true;
  try {
    await signOut();
  } finally {
    signingOut.value = false;
  }
}

/** Back to the Admin's own account: the page reloads as them. */
async function handleStopImpersonating(): Promise<void> {
  if (signingOut.value) return;
  signingOut.value = true;
  try {
    await stopImpersonating();
  } catch (error) {
    signingOut.value = false;
    notifyError(error, "shell.impersonation.stopFailed");
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
      label: t("shell.user.activity"),
      icon: "i-lucide-history",
      to: localePath("/actividad"),
    },
  ],
  [
    {
      label: t("shell.preferences.title"),
      icon: "i-lucide-settings-2",
      onSelect: () => {
        preferencesOpen.value = true;
      },
    },
  ],
  [
    impersonation.value
      ? {
          label: t("shell.impersonation.stop"),
          icon: "i-lucide-undo-2",
          color: "warning" as const,
          onSelect: handleStopImpersonating,
        }
      : {
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
          ? 'w-72'
          : 'w-(--reka-dropdown-menu-trigger-width) min-w-64',
        itemLabel: 'text-clip whitespace-normal wrap-anywhere',
        itemDescription: 'text-clip whitespace-normal wrap-anywhere',
      }"
    >
      <UButton
        ref="menuButton"
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
      :title="t('shell.preferences.title')"
      :description="t('shell.preferences.description')"
      :content="preferencesContent"
    >
      <template #body>
        <ShellPreferences />
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
