<script setup lang="ts">
import type { TableColumn } from "@nuxt/ui";
import type { RouteLocationRaw } from "vue-router";
import type { ActivityItemDto } from "~~/shared/types/api";
import { activityDetails, activityIcon } from "~/composables/activity/-present";
import type { ActivityMemberName } from "~/composables/activity/useActivityText";

/**
 * The Admin's activity log as a table: when, who (account, member and
 * role; "vía suplantación por X" when an Admin acted as them), the action
 * with its details, what it is about (links), where it came from and the
 * IP. Names open that account's activity, the impersonation badge opens
 * what was done under it, and each row keeps its raw data behind a
 * "Datos técnicos" disclosure.
 */
const props = withDefaults(
  defineProps<{
    items: ActivityItemDto[];
    loading?: boolean;
    /** The log filtered by these changes (keeps the other filters). */
    filterLink: (
      changes: Record<string, string | undefined>,
    ) => RouteLocationRaw;
    memberName?: ActivityMemberName;
  }>(),
  { loading: false, memberName: undefined },
);

const { t, locale } = useI18n();
const now = useAppNow();
const {
  actionLabel,
  unknownActionCode,
  categoryLabel,
  sourceLabel,
  actorLabel,
  detailText,
  deviceLabel,
  dateTime,
} = useActivityText();

/** The actor's current role, if the server sends it (not in the contract yet). */
function actorRole(item: ActivityItemDto): string | null {
  const actor = item.actor as
    (ActivityItemDto["actor"] & { role?: unknown }) | null;
  return typeof actor?.role === "string" && actor.role ? actor.role : null;
}

const columns = computed<TableColumn<ActivityItemDto>[]>(() => [
  { id: "at", header: t("activity.admin.columns.at") },
  { id: "actor", header: t("activity.admin.columns.actor") },
  { id: "action", header: t("activity.admin.columns.action") },
  { id: "target", header: t("activity.admin.columns.target") },
  { id: "source", header: t("activity.admin.columns.source") },
  { id: "ip", header: t("activity.admin.columns.ip") },
]);

function userLink(userId: string): RouteLocationRaw {
  return props.filterLink({ user: userId, impersonation: undefined });
}

function details(item: ActivityItemDto): string[] {
  return activityDetails(item)
    .map((detail) => detailText(detail, props.memberName))
    .filter(Boolean);
}

function technical(item: ActivityItemDto): string {
  return JSON.stringify(
    {
      kind: item.kind,
      id: item.id,
      action: item.action,
      target: { type: item.target.type, id: item.target.id },
      impersonationId: item.impersonationId,
      payload: item.payload,
      userAgent: item.access?.userAgent ?? null,
    },
    null,
    2,
  );
}
</script>

<template>
  <UTable
    :data="props.items"
    :columns="columns"
    :loading="props.loading"
    :aria-label="t('activity.admin.logLabel')"
    :get-row-id="(row: ActivityItemDto) => `${row.kind}:${row.id}`"
    class="border-default rounded-lg border"
    :ui="{ td: 'align-top whitespace-normal', th: 'whitespace-nowrap' }"
  >
    <template #at-cell="{ row }">
      <time
        :datetime="row.original.at"
        class="block text-sm whitespace-nowrap tabular-nums"
      >
        {{ dateTime(row.original.at) }}
      </time>
      <span class="text-dimmed text-xs whitespace-nowrap">
        {{ formatRelative(row.original.at, { locale: locale, now: now }) }}
      </span>
    </template>

    <template #actor-cell="{ row }">
      <div class="flex max-w-56 min-w-40 flex-col items-start gap-1">
        <ULink
          v-if="row.original.actor"
          :to="userLink(row.original.actor.id)"
          class="text-highlighted hover:text-primary focus-visible:outline-primary rounded-sm text-sm font-medium break-words hover:underline focus-visible:outline-2"
          :aria-label="
            t('activity.admin.showUser', { user: row.original.actor.name })
          "
        >
          {{ row.original.actor.name }}
        </ULink>
        <span v-else class="text-muted text-sm italic">
          {{ actorLabel(row.original) }}
        </span>
        <div
          v-if="row.original.actor?.member || actorRole(row.original)"
          class="flex flex-wrap gap-1"
        >
          <CommonMemberBadge
            v-if="row.original.actor?.member"
            :member="row.original.actor.member"
            size="sm"
          />
          <ShellRoleBadge
            v-if="actorRole(row.original)"
            :role="actorRole(row.original)"
            size="sm"
          />
        </div>
        <ULink
          v-if="row.original.impersonatedBy"
          :to="
            row.original.impersonationId
              ? props.filterLink({
                  impersonation: row.original.impersonationId,
                })
              : userLink(row.original.impersonatedBy.id)
          "
          class="focus-visible:outline-primary rounded-md focus-visible:outline-2"
        >
          <UBadge
            color="warning"
            variant="subtle"
            size="sm"
            icon="i-lucide-venetian-mask"
            class="whitespace-normal"
            :label="
              t('activity.admin.viaImpersonation', {
                admin: row.original.impersonatedBy.name,
              })
            "
          />
        </ULink>
      </div>
    </template>

    <template #action-cell="{ row }">
      <div class="flex max-w-80 min-w-48 gap-2">
        <UIcon
          :name="activityIcon(row.original)"
          class="text-muted mt-0.5 size-4 shrink-0"
          aria-hidden="true"
        />
        <div class="min-w-0 flex-1">
          <p class="text-highlighted text-sm font-medium break-words">
            {{ actionLabel(row.original.action) }}
            <code
              v-if="unknownActionCode(row.original.action)"
              class="text-dimmed text-xs"
              >({{ unknownActionCode(row.original.action) }})</code
            >
          </p>
          <p class="text-dimmed text-xs">
            {{ categoryLabel(row.original.category) }}
          </p>
          <p
            v-for="(detail, i) in details(row.original)"
            :key="i"
            class="text-muted text-xs break-words"
          >
            {{ detail }}
          </p>
          <p v-if="row.original.approximate" class="text-muted text-xs italic">
            {{ t("activity.approximateRole") }}
          </p>
          <details class="mt-1 text-xs">
            <summary
              class="text-dimmed hover:text-default focus-visible:outline-primary cursor-pointer rounded-sm focus-visible:outline-2"
            >
              {{ t("activity.admin.technical") }}
            </summary>
            <pre
              class="bg-elevated text-default mt-1 max-h-60 max-w-80 overflow-auto rounded p-2 text-[11px] leading-snug whitespace-pre-wrap"
              >{{ technical(row.original) }}</pre>
          </details>
        </div>
      </div>
    </template>

    <template #target-cell="{ row }">
      <div class="max-w-72 min-w-40 text-sm">
        <ActivityTarget :item="row.original" :user-link="userLink" />
      </div>
    </template>

    <template #source-cell="{ row }">
      <UBadge
        :label="sourceLabel(row.original.source)"
        :color="row.original.source === 'user' ? 'neutral' : 'info'"
        variant="subtle"
        size="sm"
        class="whitespace-nowrap"
      />
    </template>

    <template #ip-cell="{ row }">
      <template v-if="row.original.access?.ipAddress">
        <span class="block font-mono text-xs break-all">
          {{ row.original.access.ipAddress }}
        </span>
        <span
          v-if="deviceLabel(row.original.access)"
          class="text-dimmed block text-xs"
        >
          {{ deviceLabel(row.original.access) }}
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
