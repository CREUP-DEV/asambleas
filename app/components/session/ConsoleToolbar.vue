<script setup lang="ts">
import { LIVE_MESSAGE_MAX_LENGTH } from "~~/shared/utils/schemas/assembly";
import { useSessionConsoleContext } from "~/composables/session/useSessionConsole";

/**
 * Top bar of the Mesa console: assembly status, live connection, what is
 * under debate right now, the projection link, the message shown on the
 * projection and the keyboard shortcuts.
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

const connection = computed(() => {
  if (session.connected.value) {
    return {
      label: t("session.toolbar.live"),
      color: "success" as const,
      icon: "i-lucide-wifi",
    };
  }
  if (session.polling.value) {
    return {
      label: t("session.toolbar.polling"),
      color: "warning" as const,
      icon: "i-lucide-refresh-cw",
    };
  }
  return {
    label: t("session.toolbar.offline"),
    color: "error" as const,
    icon: "i-lucide-wifi-off",
  };
});

const itemTitle = computed(() => {
  const id = live.value?.agendaItemId;
  if (!id) return null;
  return (
    session.agendaRows.value.find((row) => row.item.id === id)?.item.title ??
    null
  );
});
const documentTitle = computed(() => {
  const id = live.value?.documentId;
  if (!id) return null;
  for (const row of session.agendaRows.value) {
    const document = row.documents.find((other) => other.id === id);
    if (document) return document.reference ?? document.title;
  }
  return null;
});
const amendmentCode = computed(() =>
  live.value?.amendmentId ? session.label(live.value.amendmentId) : null,
);
const focusParts = computed(() =>
  [itemTitle.value, documentTitle.value, amendmentCode.value].filter(
    (part): part is string => Boolean(part),
  ),
);

const messageOpen = ref(false);
const message = ref("");
watch(messageOpen, (isOpen) => {
  if (isOpen) message.value = live.value?.message ?? "";
});

async function saveMessage(value: string | null): Promise<void> {
  const ok = await session.setMessage(value);
  if (ok) messageOpen.value = false;
}

const SHORTCUTS = [
  { keys: ["j"], key: "next" },
  { keys: ["k"], key: "previous" },
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
          role="status"
        />
        <p
          class="text-default flex min-w-0 items-center gap-1 text-sm"
          aria-live="polite"
        >
          <UIcon
            name="i-lucide-radio"
            class="text-primary size-4 shrink-0"
            aria-hidden="true"
          />
          <span class="text-muted shrink-0">{{
            t("session.toolbar.now")
          }}</span>
          <span v-if="focusParts.length > 0" class="truncate font-medium">
            {{ focusParts.join(" › ") }}
          </span>
          <span v-else class="text-muted truncate">
            {{ t("session.toolbar.nothing") }}
          </span>
        </p>
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
              <dl class="space-y-1.5 text-sm">
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
                {{ t("session.shortcuts.hint") }}
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
