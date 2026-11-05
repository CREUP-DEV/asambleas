<script setup lang="ts">
import type { TableColumn } from "@nuxt/ui";
import type { RouteLocationRaw } from "vue-router";
import type { AdminImpersonationDto } from "~~/shared/types/api";

/**
 * Every time an Admin acted as an account (GET /api/admin/impersonations):
 * when it started, who did it, as whom (member and current role), why,
 * whether it is still open or how it ended, how many changes were recorded
 * under it (a link to them in the log) and where the Admin connected from.
 */
const props = withDefaults(
  defineProps<{
    items: AdminImpersonationDto[];
    loading?: boolean;
    /** The log filtered by these changes. */
    filterLink: (
      changes: Record<string, string | undefined>,
    ) => RouteLocationRaw;
  }>(),
  { loading: false },
);

const { t } = useI18n();
const { dateTime, time, deviceLabel } = useActivityText();

const columns = computed<TableColumn<AdminImpersonationDto>[]>(() => [
  {
    id: "startedAt",
    header: t("activity.admin.impersonations.columns.started"),
  },
  { id: "admin", header: t("activity.admin.impersonations.columns.admin") },
  { id: "target", header: t("activity.admin.impersonations.columns.target") },
  { id: "reason", header: t("activity.admin.impersonations.columns.reason") },
  { id: "state", header: t("activity.admin.impersonations.columns.state") },
  { id: "actions", header: t("activity.admin.impersonations.columns.actions") },
  { id: "ip", header: t("activity.admin.columns.ip") },
]);

function minutes(item: AdminImpersonationDto): number | null {
  const end = item.endedAt ?? (item.active ? null : item.expiresAt);
  if (!end) return null;
  return Math.max(
    0,
    Math.round((Date.parse(end) - Date.parse(item.startedAt)) / 60_000),
  );
}
</script>

<template>
  <UTable
    :data="props.items"
    :columns="columns"
    :loading="props.loading"
    :aria-label="t('activity.admin.impersonations.label')"
    :get-row-id="(row: AdminImpersonationDto) => row.id"
    class="border-default rounded-lg border"
    :ui="{ td: 'align-top whitespace-normal', th: 'whitespace-nowrap' }"
  >
    <template #startedAt-cell="{ row }">
      <time
        :datetime="row.original.startedAt"
        class="block text-sm whitespace-nowrap tabular-nums"
      >
        {{ dateTime(row.original.startedAt) }}
      </time>
    </template>

    <template #admin-cell="{ row }">
      <ULink
        v-if="row.original.admin"
        :to="props.filterLink({ view: undefined, user: row.original.admin.id })"
        class="text-highlighted hover:text-primary focus-visible:outline-primary rounded-sm text-sm font-medium hover:underline focus-visible:outline-2"
        :aria-label="
          t('activity.admin.showUser', { user: row.original.admin.name })
        "
      >
        {{ row.original.admin.name }}
      </ULink>
      <span v-else class="text-muted text-sm italic">
        {{ t("activity.admin.deletedAccount") }}
      </span>
    </template>

    <template #target-cell="{ row }">
      <div
        v-if="row.original.target"
        class="flex min-w-40 flex-col items-start gap-1"
      >
        <ULink
          :to="
            props.filterLink({ view: undefined, user: row.original.target.id })
          "
          class="text-highlighted hover:text-primary focus-visible:outline-primary rounded-sm text-sm font-medium hover:underline focus-visible:outline-2"
          :aria-label="
            t('activity.admin.showUser', { user: row.original.target.name })
          "
        >
          {{ row.original.target.name }}
        </ULink>
        <div class="flex flex-wrap gap-1">
          <CommonMemberBadge
            v-if="row.original.target.member"
            :member="row.original.target.member"
            size="sm"
          />
          <ShellRoleBadge :role="row.original.target.role" size="sm" />
        </div>
      </div>
      <span v-else class="text-muted text-sm italic">
        {{ t("activity.admin.deletedAccount") }}
      </span>
    </template>

    <template #reason-cell="{ row }">
      <p class="max-w-64 min-w-40 text-sm break-words">
        {{ row.original.reason }}
      </p>
    </template>

    <template #state-cell="{ row }">
      <div class="flex min-w-36 flex-col items-start gap-1">
        <UBadge
          v-if="row.original.active"
          color="error"
          variant="subtle"
          size="sm"
          icon="i-lucide-radio"
          :label="
            t('activity.admin.impersonations.activeUntil', {
              time: time(row.original.expiresAt),
            })
          "
        />
        <template v-else>
          <UBadge
            color="neutral"
            variant="subtle"
            size="sm"
            :label="
              row.original.endReason
                ? t(`activity.endReasons.${row.original.endReason}`)
                : t('activity.admin.impersonations.ended')
            "
          />
          <span
            v-if="minutes(row.original) !== null"
            class="text-dimmed text-xs"
          >
            {{
              t(
                "activity.admin.impersonations.duration",
                { minutes: minutes(row.original) ?? 0 },
                minutes(row.original) ?? 0,
              )
            }}
          </span>
        </template>
      </div>
    </template>

    <template #actions-cell="{ row }">
      <ULink
        v-if="row.original.actionCount > 0"
        :to="
          props.filterLink({
            view: undefined,
            impersonation: row.original.id,
          })
        "
        class="text-primary focus-visible:outline-primary rounded-sm text-sm font-medium whitespace-nowrap hover:underline focus-visible:outline-2"
      >
        {{
          t(
            "activity.admin.impersonations.showActions",
            { count: row.original.actionCount },
            row.original.actionCount,
          )
        }}
      </ULink>
      <span v-else class="text-dimmed text-sm whitespace-nowrap">
        {{ t("activity.admin.impersonations.noActions") }}
      </span>
    </template>

    <template #ip-cell="{ row }">
      <template v-if="row.original.ipAddress">
        <span class="block font-mono text-xs break-all">
          {{ row.original.ipAddress }}
        </span>
        <span
          v-if="
            deviceLabel({ ipAddress: null, userAgent: row.original.userAgent })
          "
          class="text-dimmed block text-xs"
        >
          {{
            deviceLabel({ ipAddress: null, userAgent: row.original.userAgent })
          }}
        </span>
      </template>
      <span v-else class="text-dimmed text-xs">
        {{ t("activity.admin.noIp") }}
      </span>
    </template>

    <template #empty>
      <slot name="empty" />
    </template>
  </UTable>
</template>
