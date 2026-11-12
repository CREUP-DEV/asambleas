<script setup lang="ts">
import { LIVE_MESSAGE_MAX_LENGTH } from "~~/shared/utils/schemas/assembly";
import { useSessionConsoleContext } from "~/composables/session/useSessionConsole";

/**
 * Top bar of the Mesa console: assembly status, live connection, the
 * projection link, the message shown on the projection and the keyboard
 * shortcuts. What is under debate leads the console itself (NowPanel).
 */
const session = useSessionConsoleContext();
const { t } = useI18n();
const localePath = useLocalePath();

const assembly = computed(() => session.assembly.value);
const live = computed(() => session.liveState.value);

const projectionPath = computed(() =>
  assembly.value
    ? localePath(`/proyeccion/${encodeURIComponent(assembly.value.slug)}`)
    : undefined,
);

const CONNECTION = {
  live: { color: "success", icon: "i-lucide-wifi" },
  polling: { color: "warning", icon: "i-lucide-refresh-cw" },
  connecting: { color: "neutral", icon: "i-lucide-loader-circle" },
  offline: { color: "error", icon: "i-lucide-wifi-off" },
} as const;

/** The live badge: "Conectando…" until the first connection is ready. */
const connection = computed(() => {
  const state = session.connection.value;
  return { state, label: t(`session.toolbar.${state}`), ...CONNECTION[state] };
});

const messageOpen = ref(false);
const message = ref("");
watch(messageOpen, (isOpen) => {
  if (isOpen) message.value = live.value?.message ?? "";
});

async function saveMessage(value: string | null): Promise<void> {
  const ok = await session.setMessage(value);
  if (ok) messageOpen.value = false;
}

/** Single-key shortcuts may be off in this browser (WCAG 2.1.4). */
const { enabled: shortcutsEnabled } = useSingleKeyShortcuts();

// j and k only move the selection: the debate moves with "Siguiente".
const SHORTCUTS = [
  { keys: ["j"], key: "selectNext" },
  { keys: ["k"], key: "selectPrevious" },
  { keys: ["a"], key: "assent" },
  { keys: ["v"], key: "vote" },
  { keys: ["t"], key: "transact" },
  { keys: ["l"], key: "lapse" },
] as const;
</script>

<template>
  <UDashboardToolbar :ui="{ root: 'flex-wrap gap-y-2 py-2 min-h-0' }">
    <template #left>
      <div class="flex min-w-0 flex-wrap items-center gap-2">
        <CommonStatusBadge
          v-if="assembly"
          kind="assembly"
          :value="assembly.status"
        />
        <UBadge
          :color="connection.color"
          variant="subtle"
          :icon="connection.icon"
          :label="connection.label"
          :ui="{
            leadingIcon:
              connection.state === 'connecting'
                ? 'motion-safe:animate-spin'
                : '',
          }"
          :data-state="connection.state"
          role="status"
        />
      </div>
    </template>
    <template #right>
      <div class="flex flex-wrap items-center gap-1.5">
        <UPopover v-model:open="messageOpen">
          <UButton
            color="neutral"
            :variant="live?.message ? 'soft' : 'ghost'"
            icon="i-lucide-megaphone"
            :label="t('session.toolbar.message')"
            size="sm"
          />
          <template #content>
            <form
              class="w-80 max-w-[calc(100vw-2rem)] space-y-3 p-3"
              @submit.prevent="saveMessage(message)"
            >
              <UFormField
                :label="t('session.toolbar.messageLabel')"
                :hint="t('session.toolbar.messageHint')"
                name="session-message"
              >
                <UTextarea
                  v-model="message"
                  :rows="2"
                  autoresize
                  :maxlength="LIVE_MESSAGE_MAX_LENGTH"
                  class="w-full"
                />
              </UFormField>
              <div class="flex justify-end gap-2">
                <UButton
                  v-if="live?.message"
                  color="neutral"
                  variant="ghost"
                  size="sm"
                  :label="t('session.toolbar.messageClear')"
                  @click="saveMessage(null)"
                />
                <UButton
                  type="submit"
                  size="sm"
                  :label="t('session.toolbar.messageSave')"
                  :loading="Boolean(session.busy.value.live)"
                />
              </div>
            </form>
          </template>
        </UPopover>

        <UPopover>
          <UButton
            color="neutral"
            variant="ghost"
            icon="i-lucide-keyboard"
            size="sm"
            :label="t('session.toolbar.shortcuts')"
          />
          <template #content>
            <div class="w-72 space-y-2 p-3">
              <p class="text-highlighted text-sm font-medium">
                {{ t("session.shortcuts.title") }}
              </p>
              <USwitch
                v-model="shortcutsEnabled"
                size="sm"
                :label="t('shell.preferences.singleKeyShortcuts')"
              />
              <dl v-if="shortcutsEnabled" class="space-y-1.5 text-sm">
                <div
                  v-for="shortcut in SHORTCUTS"
                  :key="shortcut.key"
                  class="flex items-center justify-between gap-3"
                >
                  <dt class="text-default">
                    {{ t(`session.shortcuts.${shortcut.key}`) }}
                  </dt>
                  <dd class="flex gap-1">
                    <UKbd
                      v-for="key in shortcut.keys"
                      :key="key"
                      :value="key"
                    />
                  </dd>
                </div>
              </dl>
              <p class="text-muted text-xs">
                {{
                  shortcutsEnabled
                    ? t("session.shortcuts.hint")
                    : t("shell.preferences.singleKeyShortcutsOff")
                }}
              </p>
            </div>
          </template>
        </UPopover>

        <UButton
          color="neutral"
          variant="ghost"
          icon="i-lucide-refresh-cw"
          size="sm"
          :aria-label="t('session.toolbar.refresh')"
          @click="session.refreshAll()"
        />

        <UButton
          v-if="projectionPath"
          :to="projectionPath"
          target="_blank"
          color="neutral"
          variant="outline"
          icon="i-lucide-presentation"
          trailing-icon="i-lucide-external-link"
          size="sm"
          :label="t('session.toolbar.projection')"
          :aria-label="t('session.toolbar.projectionNewTab')"
        />
      </div>
    </template>
  </UDashboardToolbar>
</template>
