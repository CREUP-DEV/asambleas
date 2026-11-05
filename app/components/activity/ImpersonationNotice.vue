<script setup lang="ts">
import { IMPERSONATION_NOTICE_DAYS } from "~~/shared/constants/activity";
import type { ImpersonationDto } from "~~/shared/types/api";

/**
 * Top of "Mi actividad": an Admin acted as this account in the last
 * IMPERSONATION_NOTICE_DAYS days. Says who, when and why (the latest one,
 * or how many times), that everything done is marked on this page, and
 * whether it is happening right now. Its one action opens the accesses tab,
 * where each window is listed.
 */
const props = defineProps<{
  /** Newest first (MeActivityPageDto.recentImpersonations). */
  impersonations: ImpersonationDto[];
  /** Hide the action while the accesses tab is already shown. */
  onAccessTab?: boolean;
}>();

const emit = defineEmits<{ showAccess: [] }>();

const { t } = useI18n();
const { dateTime, time } = useActivityText();

const latest = computed(() => props.impersonations[0] ?? null);
const active = computed(
  () => props.impersonations.find((item) => item.active) ?? null,
);

function adminName(item: ImpersonationDto | null): string {
  return item?.admin?.name ?? t("activity.actor.anAdmin");
}

const description = computed(() => {
  const item = latest.value;
  if (!item) return "";
  const count = props.impersonations.length;
  const parts = [
    count === 1
      ? t("activity.notice.once", {
          admin: adminName(item),
          date: dateTime(item.startedAt),
          days: IMPERSONATION_NOTICE_DAYS,
        })
      : t("activity.notice.many", {
          count,
          days: IMPERSONATION_NOTICE_DAYS,
          admin: adminName(item),
          date: dateTime(item.startedAt),
        }),
  ];
  if (item.reason.trim()) {
    parts.push(t("activity.notice.reason", { reason: item.reason.trim() }));
  }
  parts.push(t("activity.notice.recorded"));
  return parts.join(" ");
});
</script>

<template>
  <UAlert
    v-if="latest"
    :color="active ? 'error' : 'warning'"
    variant="subtle"
    icon="i-lucide-venetian-mask"
    :title="
      active
        ? t('activity.notice.activeTitle', {
            admin: adminName(active),
            time: time(active.expiresAt),
          })
        : t('activity.notice.title')
    "
    :description="description"
    :actions="
      props.onAccessTab
        ? []
        : [
            {
              label: t('activity.notice.show'),
              color: active ? 'error' : 'warning',
              variant: 'outline',
              onClick: () => emit('showAccess'),
            },
          ]
    "
  />
</template>
