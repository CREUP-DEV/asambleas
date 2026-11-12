<script setup lang="ts">
import { roleLabelKey } from "~/components/shell/RoleBadge.vue";
import {
  NOTIFICATION_AUDIENCE,
  NOTIFICATION_DIGEST_HOUR,
  NOTIFICATION_FREQUENCIES,
  NOTIFICATION_GROUPS,
  type NotificationKind,
  type NotificationSettings,
} from "~~/shared/constants/notifications";
import type {
  EmailDeliveryDto,
  EmailTestResultDto,
  NotificationSettingsBody,
  NotificationSettingsDto,
} from "~~/shared/types/api";
import { formatDateTime } from "~/utils/format";

/**
 * Email notifications (notification:manage): the general switch, one row
 * per notice (on or off, the roles it goes to when it goes to roles, and
 * whether it goes at once or in the daily summary), a test email to
 * oneself and the log of the latest emails. GET/PUT
 * /api/admin/notifications, POST .../test, GET .../deliveries.
 */
definePageMeta({
  middleware: ["admin"],
  adminAccess: ["notification:manage"],
});

const { t, locale } = useI18n();
const toast = useToast();
const api = useApi();
const { impersonation } = useMe();

useHead({ title: () => t("admin.notifications.title") });

const {
  data,
  status,
  error: loadError,
  refresh,
} = await useFetch<NotificationSettingsDto>("/api/admin/notifications", {
  key: "admin-notifications",
});

const { data: deliveries, refresh: refreshDeliveries } = await useFetch<
  EmailDeliveryDto[]
>("/api/admin/notifications/deliveries", {
  key: "admin-notification-deliveries",
  query: { limit: 50 },
  lazy: true,
  server: false,
});

/**
 * The log is fetched on the client only, so its first load has no spinner:
 * the button's own state would differ from the server render.
 */
const reloadingLog = ref(false);

async function reloadLog() {
  reloadingLog.value = true;
  try {
    await refreshDeliveries();
  } finally {
    reloadingLog.value = false;
  }
}

function copy(settings: NotificationSettings): NotificationSettings {
  return JSON.parse(JSON.stringify(settings)) as NotificationSettings;
}

const form = ref<NotificationSettings | null>(null);
watch(
  () => data.value?.settings,
  (settings) => {
    form.value = settings ? copy(settings) : null;
  },
  { immediate: true },
);

const dirty = computed(
  () =>
    form.value !== null &&
    data.value !== null &&
    data.value !== undefined &&
    JSON.stringify(form.value) !== JSON.stringify(data.value.settings),
);

const readOnly = computed(() => impersonation.value !== null);

function roleName(name: string): string {
  const key = roleLabelKey(name);
  return key ? t(key) : name;
}

const roleItems = computed(() =>
  (data.value?.roles ?? []).map((name) => ({
    label: roleName(name),
    value: name,
  })),
);

const frequencyItems = computed(() =>
  NOTIFICATION_FREQUENCIES.map((frequency) => ({
    label: t(`admin.notifications.frequencies.${frequency}`, {
      hour: NOTIFICATION_DIGEST_HOUR,
    }),
    value: frequency,
  })),
);

/** A roles notice that is on but goes to nobody. */
const goesToNobody = (kind: NotificationKind) =>
  NOTIFICATION_AUDIENCE[kind] === "roles" &&
  !!form.value?.kinds[kind].enabled &&
  form.value.kinds[kind].roles.length === 0;

const saving = ref(false);

async function save() {
  if (!form.value || !data.value || !dirty.value || readOnly.value) return;
  const body: NotificationSettingsBody = {
    settings: form.value,
    updatedAt: data.value.updatedAt,
  };
  saving.value = true;
  try {
    data.value = await api.send<NotificationSettingsDto>(
      "/api/admin/notifications",
      { method: "PUT", body: { ...body } },
    );
    toast.add({
      title: t("admin.notifications.saved"),
      color: "success",
      icon: "i-lucide-check",
    });
  } catch (error) {
    api.notifyError(error, "admin.notifications.saveError");
    if (api.isConflict(error)) await refresh();
  } finally {
    saving.value = false;
  }
}

function discard() {
  if (data.value) form.value = copy(data.value.settings);
}

const testing = ref(false);

async function sendTest() {
  if (readOnly.value) return;
  testing.value = true;
  try {
    const result = await api.send<EmailTestResultDto>(
      "/api/admin/notifications/test",
      { method: "POST" },
    );
    if (result.status === "sent") {
      toast.add({
        title: t("admin.notifications.test.sent"),
        color: "success",
        icon: "i-lucide-mail-check",
      });
    } else {
      toast.add({
        title:
          result.status === "skipped"
            ? t("admin.notifications.test.unconfigured")
            : t("admin.notifications.test.failed"),
        color: "error",
        icon: "i-lucide-mail-x",
      });
    }
    await Promise.all([refresh(), refreshDeliveries()]);
  } catch (error) {
    api.notifyError(error, "admin.notifications.test.failed");
  } finally {
    testing.value = false;
  }
}

function kindLabel(kind: string): string {
  return kind === "test"
    ? t("admin.notifications.log.testKind")
    : t(`admin.notifications.kinds.${kind}.title`);
}

const STATUS_COLORS = {
  pending: "neutral",
  sending: "info",
  sent: "success",
  failed: "error",
  skipped: "warning",
} as const;

function dateTime(value: string | null): string {
  return value ? formatDateTime(value, { locale: locale.value }) : "";
}

onBeforeRouteLeave(() => {
  if (dirty.value && import.meta.client) {
    return window.confirm(t("admin.notifications.unsavedConfirm"));
  }
  return true;
});
</script>

<template>
  <UDashboardPanel id="admin-notifications">
    <template #header>
      <UDashboardNavbar :title="t('admin.notifications.title')">
        <template #leading>
          <UDashboardSidebarCollapse />
        </template>
        <template #right>
          <UButton
            icon="i-lucide-send"
            color="neutral"
            variant="outline"
            :label="t('admin.notifications.test.button')"
            :loading="testing"
            :disabled="readOnly"
            @click="sendTest"
          />
        </template>
      </UDashboardNavbar>
      <ShellBreadcrumbs />
    </template>

    <template #body>
      <div class="mx-auto flex w-full max-w-5xl flex-col gap-6">
        <UAlert
          v-if="loadError"
          color="error"
          variant="subtle"
          icon="i-lucide-circle-alert"
          :title="t('admin.loadFailed')"
          :actions="[
            {
              label: t('admin.retry'),
              color: 'error',
              variant: 'outline',
              onClick: () => refresh(),
            },
          ]"
        />
        <p v-else-if="status === 'pending' && !data" class="text-muted text-sm">
          {{ t("admin.loading") }}
        </p>

        <form
          v-else-if="data && form"
          class="flex flex-col gap-6"
          novalidate
          @submit.prevent="save"
        >
          <p class="text-muted text-sm">
            {{ t("admin.notifications.intro") }}
          </p>

          <UAlert
            v-if="readOnly"
            color="warning"
            variant="subtle"
            icon="i-lucide-lock"
            :title="t('admin.impersonationReadOnly')"
          />

          <UAlert
            v-if="!data.smtp.configured"
            color="warning"
            variant="subtle"
            icon="i-lucide-triangle-alert"
            :title="t('admin.notifications.smtp.unconfiguredTitle')"
            :description="t('admin.notifications.smtp.unconfigured')"
          />

          <UCard>
            <div class="flex flex-wrap items-center gap-4">
              <div class="min-w-0 flex-1">
                <p class="text-highlighted flex items-center gap-2 font-medium">
                  <UIcon
                    :name="
                      data.smtp.configured && form.enabled
                        ? 'i-lucide-mail-check'
                        : 'i-lucide-mail-x'
                    "
                    :class="
                      data.smtp.configured && form.enabled
                        ? 'text-success'
                        : 'text-muted'
                    "
                    class="size-5 shrink-0"
                    aria-hidden="true"
                  />
                  {{
                    form.enabled
                      ? t("admin.notifications.enabled")
                      : t("admin.notifications.disabled")
                  }}
                </p>
                <p class="text-muted mt-1 text-sm">
                  <template v-if="data.smtp.from">
                    {{
                      t("admin.notifications.smtp.from", {
                        from: data.smtp.from,
                      })
                    }}
                    ·
                  </template>
                  {{
                    t("admin.notifications.lastDay", {
                      sent: data.lastDay.sent,
                      failed: data.lastDay.failed,
                      pending: data.lastDay.pending + data.lastDay.sending,
                    })
                  }}
                </p>
              </div>
              <USwitch
                v-model="form.enabled"
                :disabled="readOnly"
                :aria-label="t('admin.notifications.enabledLabel')"
              />
            </div>
          </UCard>

          <section
            v-for="group in NOTIFICATION_GROUPS"
            :key="group.key"
            :aria-labelledby="`notification-group-${group.key}`"
          >
            <h2
              :id="`notification-group-${group.key}`"
              class="text-highlighted mb-1 font-semibold"
            >
              {{ t(`admin.notifications.groups.${group.key}.title`) }}
            </h2>
            <p class="text-muted mb-3 text-sm">
              {{ t(`admin.notifications.groups.${group.key}.description`) }}
            </p>
            <UCard :ui="{ body: 'p-0 sm:p-0' }">
              <ul class="divide-default divide-y">
                <li
                  v-for="kind in group.kinds"
                  :key="kind"
                  class="grid gap-3 px-4 py-3 sm:grid-cols-[minmax(0,1fr)_14rem_11rem_auto] sm:items-center"
                >
                  <div class="min-w-0">
                    <p
                      :id="`notification-${kind}`"
                      class="text-highlighted text-sm font-medium"
                    >
                      {{ t(`admin.notifications.kinds.${kind}.title`) }}
                    </p>
                    <p class="text-muted text-xs">
                      {{ t(`admin.notifications.kinds.${kind}.description`) }}
                    </p>
                    <p
                      v-if="goesToNobody(kind)"
                      class="text-default mt-1 flex items-center gap-1 text-xs"
                    >
                      <UIcon
                        name="i-lucide-triangle-alert"
                        class="text-warning size-3.5 shrink-0"
                        aria-hidden="true"
                      />
                      {{ t("admin.notifications.noRoles") }}
                    </p>
                  </div>

                  <USelectMenu
                    v-if="NOTIFICATION_AUDIENCE[kind] === 'roles'"
                    v-model="form.kinds[kind].roles"
                    :items="roleItems"
                    value-key="value"
                    multiple
                    :disabled="readOnly"
                    :placeholder="t('admin.notifications.rolesPlaceholder')"
                    :aria-label="
                      t('admin.notifications.rolesLabel', {
                        notice: t(`admin.notifications.kinds.${kind}.title`),
                      })
                    "
                    class="w-full"
                  />
                  <p v-else class="text-muted text-sm">
                    {{ t(`admin.notifications.audience.${kind}`) }}
                  </p>

                  <USelect
                    v-model="form.kinds[kind].frequency"
                    :items="frequencyItems"
                    :disabled="readOnly"
                    :aria-label="
                      t('admin.notifications.frequencyLabel', {
                        notice: t(`admin.notifications.kinds.${kind}.title`),
                      })
                    "
                    class="w-full"
                  />

                  <USwitch
                    v-model="form.kinds[kind].enabled"
                    :disabled="readOnly"
                    :aria-label="
                      t('admin.notifications.kindSwitchLabel', {
                        notice: t(`admin.notifications.kinds.${kind}.title`),
                      })
                    "
                  />
                </li>
              </ul>
            </UCard>
          </section>

          <div
            v-if="!readOnly"
            class="flex flex-wrap items-center justify-end gap-2"
          >
            <UButton
              v-if="dirty"
              color="neutral"
              variant="ghost"
              :label="t('admin.notifications.discard')"
              @click="discard"
            />
            <UButton
              type="submit"
              icon="i-lucide-save"
              :label="t('admin.notifications.save')"
              :loading="saving"
              :disabled="!dirty"
            />
          </div>
        </form>

        <section v-if="data" aria-labelledby="notification-log">
          <div class="mb-3 flex items-center justify-between gap-2">
            <div>
              <h2 id="notification-log" class="text-highlighted font-semibold">
                {{ t("admin.notifications.log.title") }}
              </h2>
              <p class="text-muted text-sm">
                {{ t("admin.notifications.log.description") }}
              </p>
            </div>
            <UButton
              icon="i-lucide-refresh-cw"
              color="neutral"
              variant="ghost"
              :label="t('admin.notifications.log.refresh')"
              :loading="reloadingLog"
              @click="reloadLog"
            />
          </div>
          <UCard :ui="{ body: 'p-0 sm:p-0' }">
            <p
              v-if="deliveries && deliveries.length === 0"
              class="text-muted px-4 py-6 text-center text-sm"
            >
              {{ t("admin.notifications.log.empty") }}
            </p>
            <ul v-else class="divide-default divide-y">
              <li
                v-for="delivery in deliveries ?? []"
                :key="delivery.id"
                class="flex flex-wrap items-start gap-x-4 gap-y-1 px-4 py-3 text-sm"
              >
                <div class="min-w-0 flex-1">
                  <p class="text-highlighted font-medium">
                    {{ delivery.subject ?? kindLabel(delivery.kind) }}
                  </p>
                  <p class="text-muted text-xs">
                    <template v-if="delivery.subject">
                      {{ kindLabel(delivery.kind) }} ·
                    </template>
                    {{
                      delivery.recipient?.name ??
                      t("admin.notifications.log.deletedAccount")
                    }}
                    ·
                    {{ dateTime(delivery.sentAt ?? delivery.createdAt) }}
                    <template v-if="delivery.frequency === 'daily'">
                      · {{ t("admin.notifications.log.daily") }}
                    </template>
                  </p>
                  <p
                    v-if="delivery.error && delivery.status !== 'sent'"
                    class="text-muted mt-1 text-xs break-words"
                  >
                    {{
                      t("admin.notifications.log.error", {
                        error: delivery.error,
                        attempts: delivery.attempts,
                      })
                    }}
                  </p>
                </div>
                <UBadge
                  :color="STATUS_COLORS[delivery.status]"
                  variant="subtle"
                  :label="
                    delivery.status === 'skipped' && delivery.reason
                      ? t(`admin.notifications.log.reasons.${delivery.reason}`)
                      : t(`admin.notifications.log.statuses.${delivery.status}`)
                  "
                />
              </li>
            </ul>
          </UCard>
        </section>
      </div>
    </template>
  </UDashboardPanel>
</template>
