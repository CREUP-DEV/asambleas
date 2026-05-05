<script setup lang="ts">
import type { AssemblyStatus } from "~~/shared/constants/statuses";

interface Assembly {
  id: string;
  number: number;
  type: string;
  status: AssemblyStatus;
  startDate: string | Date;
  endDate: string | Date;
  location: string;
}

const props = defineProps<{
  assembly: Assembly;
}>();

const { t, locale } = useI18n();
const localePath = useLocalePath();

const dateFormatter = computed(
  () =>
    new Intl.DateTimeFormat(locale.value, {
      dateStyle: "medium",
      timeStyle: "short",
    }),
);

const formatDate = (d: string | Date) =>
  dateFormatter.value.format(new Date(d));
</script>

<template>
  <NuxtLink
    :to="localePath(`/asambleas/${props.assembly.id}`)"
    class="hover:bg-elevated block rounded-xl border p-5 transition-colors"
    :aria-label="
      t('assembly.typesShort.' + props.assembly.type) +
      ' ' +
      props.assembly.number
    "
  >
    <div class="flex items-start justify-between gap-3">
      <div class="min-w-0">
        <p class="text-muted text-xs font-medium uppercase tracking-wide">
          {{ t(`assembly.types.${props.assembly.type}`) }}
        </p>
        <h2 class="mt-0.5 text-lg font-semibold">
          {{ t("assembly.numberShort") }} {{ props.assembly.number }}
        </h2>
      </div>
      <AssemblyStatusBadge :status="props.assembly.status" />
    </div>

    <div class="text-muted mt-3 flex flex-col gap-1 text-sm">
      <div class="flex items-center gap-2">
        <UIcon name="i-tabler-calendar" class="size-4 shrink-0" />
        <span>{{ formatDate(props.assembly.startDate) }}</span>
        <span>→</span>
        <span>{{ formatDate(props.assembly.endDate) }}</span>
      </div>
      <div class="flex items-center gap-2">
        <UIcon name="i-tabler-map-pin" class="size-4 shrink-0" />
        <span class="truncate">{{ props.assembly.location }}</span>
      </div>
    </div>
  </NuxtLink>
</template>
