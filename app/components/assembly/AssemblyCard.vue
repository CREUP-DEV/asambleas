<script setup lang="ts">
import type { AssemblyStatus } from "~~/shared/constants/statuses";
import { buildAssemblySlug, formatAssemblyLabel } from "~~/shared/utils/slug";

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
const assemblyLabel = computed(() => formatAssemblyLabel(props.assembly));
</script>

<template>
  <NuxtLink
    :to="localePath(`/asambleas/${buildAssemblySlug(props.assembly)}`)"
    class="motion-card group hover:border-primary/60 block rounded-xl border p-5"
    :aria-label="assemblyLabel"
  >
    <div class="flex items-start justify-between gap-3">
      <div class="min-w-0">
        <p class="text-muted text-xs font-medium uppercase tracking-wide">
          {{ t(`assembly.types.${props.assembly.type}`) }}
        </p>
        <h2
          class="group-hover:text-primary mt-0.5 text-lg font-semibold transition-colors"
        >
          {{ assemblyLabel }}
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
