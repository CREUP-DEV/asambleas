<script setup lang="ts">
import type { ActivityItemDto } from "~~/shared/types/api";
import {
  activityDetails,
  activityIcon,
  activityItemKey,
} from "~/composables/activity/-present";
import type { ActivityMemberName } from "~/composables/activity/useActivityText";

/**
 * "Mi actividad" as a timeline, newest first: when, what happened (one
 * plain sentence), what it is about (a link when the viewer can open it),
 * the details worth saying and, depending on the tab, who did it and from
 * which device. Something an Admin did while acting as the account is
 * marked with the Admin's name, and an approximate attribution says so.
 *
 * A real ordered list, so screen readers announce how many items it has.
 */
const props = withDefaults(
  defineProps<{
    items: ActivityItemDto[];
    /** The viewer's account id: their own account reads "Tu cuenta". */
    selfId?: string | null;
    /** Say who did each item (not in "Lo que he hecho": always the viewer). */
    showActor?: boolean;
    /** Show the device and IP of accesses (the viewer's own). */
    showAccess?: boolean;
    memberName?: ActivityMemberName;
  }>(),
  {
    selfId: null,
    showActor: false,
    showAccess: false,
    memberName: undefined,
  },
);

const { t, locale } = useI18n();
const now = useAppNow();
const { actionLabel, actorLabel, accessLabel, detailText, dateTime } =
  useActivityText();

interface Row {
  key: string;
  item: ActivityItemDto;
  icon: string;
  title: string;
  relative: string;
  exact: string;
  details: string[];
  actor: string | null;
  impersonatedBy: string | null;
  admin: string | null;
  access: string | null;
}

/**
 * "Lo hizo CEUM · Ana", "Lo hizo la intranet de CREUP". Left out when an
 * Admin acted as the account: the badge then names both.
 */
function byLine(item: ActivityItemDto): string | null {
  if (
    !props.showActor ||
    item.kind === "impersonation" ||
    item.impersonatedBy
  ) {
    return null;
  }
  if (item.actor) return t("activity.timeline.by", { actor: actorLabel(item) });
  return t(
    item.source === "intranet"
      ? "activity.timeline.byIntranet"
      : "activity.timeline.bySystem",
  );
}

const rows = computed<Row[]>(() =>
  props.items.map((item) => {
    const window = item.kind === "impersonation" ? item.impersonation : null;
    return {
      key: activityItemKey(item),
      item,
      icon: activityIcon(item),
      title: actionLabel(item.action),
      relative: formatRelative(item.at, {
        locale: locale.value,
        now: now.value,
      }),
      exact: dateTime(item.at),
      details: activityDetails(item)
        .map((detail) => detailText(detail, props.memberName))
        .filter(Boolean),
      actor: byLine(item),
      impersonatedBy: item.impersonatedBy
        ? // The viewer's own account, or (for an Admin) a colleague's.
          item.actor && item.actor.id !== props.selfId
          ? t("activity.impersonatedByFor", {
              admin: item.impersonatedBy.name,
              actor: item.actor.name,
            })
          : t("activity.impersonatedBy", { admin: item.impersonatedBy.name })
        : null,
      // An impersonation window names the Admin who acted as the account.
      admin: window
        ? (window.admin?.name ?? t("activity.actor.anAdmin"))
        : null,
      access: props.showAccess ? accessLabel(item.access) : null,
    };
  }),
);
</script>

<template>
  <ol class="flex flex-col">
    <li
      v-for="(row, index) in rows"
      :key="row.key"
      class="relative flex gap-3 pb-5 last:pb-0"
    >
      <span
        v-if="index < rows.length - 1"
        class="bg-(--ui-border) absolute start-4 top-9 bottom-1 w-px -translate-x-1/2 rtl:translate-x-1/2"
        aria-hidden="true"
      />
      <span
        class="bg-elevated ring-default text-muted flex size-8 shrink-0 items-center justify-center rounded-full ring"
        :class="
          row.item.impersonatedBy || row.item.kind === 'impersonation'
            ? 'bg-warning/10 text-warning ring-warning/40'
            : ''
        "
        aria-hidden="true"
      >
        <UIcon :name="row.icon" class="size-4" />
      </span>

      <div class="min-w-0 flex-1 pt-1">
        <p class="text-dimmed text-xs">
          <time :datetime="row.item.at" :title="row.exact">
            {{ row.relative }}
          </time>
          <span class="sr-only"> ({{ row.exact }})</span>
        </p>
        <p class="text-highlighted text-sm font-medium break-words">
          {{ row.title }}
        </p>
        <p class="text-sm">
          <ActivityTarget :item="row.item" :self-id="props.selfId" />
        </p>
        <p v-if="row.admin" class="text-default text-sm break-words">
          {{ t("activity.timeline.actedAsYou", { admin: row.admin }) }}
        </p>
        <p
          v-for="(detail, i) in row.details"
          :key="i"
          class="text-muted text-sm break-words"
        >
          {{ detail }}
        </p>
        <p v-if="row.actor" class="text-muted text-xs break-words">
          {{ row.actor }}
        </p>
        <p v-if="row.access" class="text-muted text-xs break-words">
          {{ row.access }}
        </p>
        <p v-if="row.item.approximate" class="text-muted text-xs italic">
          {{ t("activity.approximateRole") }}
        </p>
        <UBadge
          v-if="row.impersonatedBy"
          color="warning"
          variant="subtle"
          size="sm"
          icon="i-lucide-venetian-mask"
          class="mt-1 max-w-full whitespace-normal"
          :label="row.impersonatedBy"
        />
      </div>
    </li>
  </ol>
</template>
