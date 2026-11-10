<script setup lang="ts">
import {
  ACTIVITY_CATEGORIES,
  AUDIT_SOURCES,
  type ActivityCategory,
  type AuditSource,
} from "~~/shared/constants/activity";
import type { AssemblySummaryDto, MemberDto } from "~~/shared/types/api";
import {
  ADMIN_IMPERSONATION_STATES,
  adminActivityFilterCount,
  type AdminActivityFilters,
  type AdminImpersonationState,
} from "~/composables/activity/-filters";
import { ACTIVITY_CATEGORY_ICONS } from "~/composables/activity/-present";
import type { ActivityDirectoryUser } from "~/composables/activity/useActivityOptions";

/**
 * Filters of the Admin's activity log. The log takes the account (done by
 * or to it, picked from every account), the member, the assembly, kinds of
 * action, where it came from, "solo suplantaciones" and a range of days;
 * the impersonations list takes the account acted as and whether it is
 * still open. Drilling into one impersonation shows as a removable chip.
 */
const props = defineProps<{
  users: ActivityDirectoryUser[];
  usersLoading?: boolean;
  members: MemberDto[];
  assemblies: AssemblySummaryDto[];
}>();

const filters = defineModel<AdminActivityFilters>({ required: true });

const { t } = useI18n();

// The account list loads only in the browser: show its spinner after
// hydration, so the server and the first client render match.
const mounted = ref(false);
onMounted(() => {
  mounted.value = true;
});
const { categoryLabel, sourceLabel, roleName } = useActivityText();

/** Sentinel for "no filter" in single selects. */
const ALL = "__all__";

function patch(change: Partial<AdminActivityFilters>): void {
  filters.value = { ...filters.value, ...change };
}

const isLog = computed(() => filters.value.view === "log");

const userItems = computed(() => {
  const items = props.users.map((user) => ({
    label: user.name,
    description: [user.member?.acronym, roleName(user.role), user.email]
      .filter(Boolean)
      .join(" · "),
    value: user.id,
    email: user.email,
    acronym: user.member?.acronym ?? "",
  }));
  const current = filters.value.user;
  if (current && !items.some((item) => item.value === current)) {
    items.unshift({
      label: props.usersLoading
        ? t("common.loading")
        : t("activity.admin.filters.unknownUser"),
      description: "",
      value: current,
      email: "",
      acronym: "",
    });
  }
  return [
    {
      label: t("activity.admin.filters.anyUser"),
      description: "",
      value: ALL,
      email: "",
      acronym: "",
    },
    ...items,
  ];
});

const memberItems = computed(() => {
  const items: { label: string; description?: string; value: string }[] =
    props.members.map(memberMenuItem);
  const current = filters.value.member;
  if (current && !items.some((item) => item.value === current)) {
    items.unshift({
      label: t("activity.admin.filters.unknownMember"),
      value: current,
    });
  }
  return [
    { label: t("activity.admin.filters.anyMember"), value: ALL },
    ...items,
  ];
});

const assemblyItems = computed(() => {
  const items = props.assemblies.map((assembly) => ({
    label: assembly.label,
    value: assembly.slug,
  }));
  const current = filters.value.assembly;
  if (current && !items.some((item) => item.value === current)) {
    items.unshift({ label: current, value: current });
  }
  return [{ label: t("activity.filters.allAssemblies"), value: ALL }, ...items];
});

const categoryItems = computed(() =>
  ACTIVITY_CATEGORIES.map((category) => ({
    label: categoryLabel(category),
    value: category,
    icon: ACTIVITY_CATEGORY_ICONS[category],
  })),
);

const sourceItems = computed(() =>
  AUDIT_SOURCES.map((source) => ({
    label: sourceLabel(source),
    value: source,
  })),
);

const stateItems = computed(() =>
  ADMIN_IMPERSONATION_STATES.map((state) => ({
    label: t(`activity.admin.impersonations.states.${state}`),
    value: state,
  })),
);

function orNull(value: string): string | null {
  return value === ALL ? null : value;
}

const userValue = computed({
  get: () => filters.value.user ?? ALL,
  set: (value: string) => patch({ user: orNull(value) }),
});
const memberValue = computed({
  get: () => filters.value.member ?? ALL,
  set: (value: string) => patch({ member: orNull(value) }),
});
const assemblyValue = computed({
  get: () => filters.value.assembly ?? ALL,
  set: (value: string) => patch({ assembly: orNull(value) }),
});

const categoryValue = computed({
  get: () => filters.value.category,
  set: (value: ActivityCategory[]) => patch({ category: [...value] }),
});
const sourceValue = computed({
  get: () => filters.value.source,
  set: (value: AuditSource[]) => patch({ source: [...value] }),
});
const stateValue = computed({
  get: () => filters.value.state,
  set: (value: AdminImpersonationState) => patch({ state: value }),
});

const activeCount = computed(() =>
  isLog.value
    ? adminActivityFilterCount(filters.value)
    : (filters.value.user ? 1 : 0) + (filters.value.state === "all" ? 0 : 1),
);

function clear(): void {
  patch(
    isLog.value
      ? {
          user: null,
          member: null,
          assembly: null,
          category: [],
          source: [],
          impersonated: false,
          impersonation: null,
          from: null,
          to: null,
        }
      : { user: null, state: "all" },
  );
}

/** On small screens the fields fold behind a button, so the list shows first. */
const open = ref(false);
const fieldsId = useId();
</script>

<template>
  <div class="flex flex-col gap-3">
    <UButton
      color="neutral"
      variant="outline"
      icon="i-lucide-list-filter"
      :trailing-icon="open ? 'i-lucide-chevron-up' : 'i-lucide-chevron-down'"
      class="self-start lg:hidden"
      :aria-expanded="open"
      :aria-controls="fieldsId"
      @click="open = !open"
    >
      {{
        activeCount > 0
          ? t("activity.admin.filters.toggleCount", { count: activeCount })
          : t("activity.admin.filters.toggle")
      }}
    </UButton>
    <div
      :id="fieldsId"
      class="grid-cols-1 gap-3 sm:grid-cols-2 lg:grid xl:grid-cols-4"
      :class="open ? 'grid' : 'hidden'"
    >
      <UFormField
        :label="
          isLog
            ? t('activity.admin.filters.user')
            : t('activity.admin.filters.target')
        "
        :help="isLog ? t('activity.admin.filters.userHelp') : undefined"
      >
        <USelectMenu
          v-model="userValue"
          :items="userItems"
          value-key="value"
          :filter-fields="['label', 'email', 'acronym']"
          :loading="mounted && props.usersLoading"
          :search-input="labelledSearch(t('activity.admin.filters.searchUser'))"
          :aria-label="
            selectMenuLabel(
              isLog
                ? t('activity.admin.filters.user')
                : t('activity.admin.filters.target'),
              userItems,
              userValue,
            )
          "
          class="w-full"
        />
      </UFormField>

      <template v-if="isLog">
        <UFormField :label="t('activity.admin.filters.member')">
          <USelectMenu
            v-model="memberValue"
            :items="memberItems"
            value-key="value"
            :ui="MEMBER_MENU_UI"
            :filter-fields="MEMBER_MENU_FILTER_FIELDS"
            :search-input="
              labelledSearch(t('activity.admin.filters.searchMember'))
            "
            :aria-label="
              selectMenuLabel(
                t('activity.admin.filters.member'),
                memberItems,
                memberValue,
              )
            "
            class="w-full"
          />
        </UFormField>

        <UFormField :label="t('activity.filters.assembly')">
          <USelectMenu
            v-model="assemblyValue"
            :items="assemblyItems"
            value-key="value"
            :search-input="labelledSearch(t('activity.filters.searchAssembly'))"
            :aria-label="
              selectMenuLabel(
                t('activity.filters.assembly'),
                assemblyItems,
                assemblyValue,
              )
            "
            class="w-full"
          />
        </UFormField>

        <UFormField :label="t('activity.filters.category')">
          <USelectMenu
            v-model="categoryValue"
            :items="categoryItems"
            value-key="value"
            multiple
            :search-input="false"
            :placeholder="t('activity.filters.allCategories')"
            :aria-label="
              selectMenuLabel(
                t('activity.filters.category'),
                categoryItems,
                categoryValue,
                t('activity.filters.allCategories'),
              )
            "
            class="w-full"
          />
        </UFormField>

        <UFormField :label="t('activity.admin.filters.source')">
          <USelectMenu
            v-model="sourceValue"
            :items="sourceItems"
            value-key="value"
            multiple
            :search-input="false"
            :placeholder="t('activity.admin.filters.anySource')"
            :aria-label="
              selectMenuLabel(
                t('activity.admin.filters.source'),
                sourceItems,
                sourceValue,
                t('activity.admin.filters.anySource'),
              )
            "
            class="w-full"
          />
        </UFormField>

        <UFormField :label="t('activity.filters.from')">
          <ActivityDayInput
            :model-value="filters.from"
            :label="t('activity.filters.from')"
            :max="filters.to"
            @update:model-value="patch({ from: $event })"
          />
        </UFormField>

        <UFormField :label="t('activity.filters.to')">
          <ActivityDayInput
            :model-value="filters.to"
            :label="t('activity.filters.to')"
            :min="filters.from"
            @update:model-value="patch({ to: $event })"
          />
        </UFormField>

        <div class="flex items-end pb-1.5">
          <USwitch
            :model-value="filters.impersonated"
            :label="t('activity.admin.filters.impersonatedOnly')"
            @update:model-value="patch({ impersonated: $event })"
          />
        </div>
      </template>

      <UFormField v-else :label="t('activity.admin.impersonations.state')">
        <USelect v-model="stateValue" :items="stateItems" class="w-full" />
      </UFormField>
    </div>

    <div
      v-if="activeCount > 0"
      class="flex flex-wrap items-center justify-between gap-2"
    >
      <UBadge
        v-if="isLog && filters.impersonation"
        color="warning"
        variant="subtle"
        icon="i-lucide-venetian-mask"
        class="gap-1.5"
      >
        {{ t("activity.admin.filters.oneImpersonation") }}
        <UButton
          icon="i-lucide-x"
          color="warning"
          variant="link"
          size="xs"
          class="-me-1 p-0"
          :aria-label="t('activity.admin.filters.removeImpersonation')"
          @click="patch({ impersonation: null })"
        />
      </UBadge>
      <span v-else />
      <UButton
        color="neutral"
        variant="ghost"
        icon="i-lucide-filter-x"
        @click="clear"
      >
        {{ t("activity.filters.clear") }}
      </UButton>
    </div>
  </div>
</template>
