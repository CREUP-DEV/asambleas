<script setup lang="ts">
import type { AmendmentStatus } from "~~/shared/constants/domain";
import type { AmendmentDto } from "~~/shared/types/api";
import { transactionalProgressOf } from "~/composables/amendment/transactional";
import { useTransactionalProgressText } from "~/composables/amendment/useTransactionalProgressText";

/**
 * One line saying where a transactional stands and what it waits for
 * ("Falta que respondan: CEUM, CAUB", "Rechazada por CEUM", "Sustituye a
 * CEUM 1 y CAUB 1"). Nothing for other amendments, drafts or decided ones
 * (except one a main author rejected). `labelOf` names the amendments it
 * combines and `statusOf` tells whether they were replaced (the workspace
 * list); without them it says it was accepted, naming nothing.
 */
const props = withDefaults(
  defineProps<{
    amendment: AmendmentDto;
    labelOf?: (id: string) => string;
    statusOf?: (id: string) => AmendmentStatus | undefined;
  }>(),
  { labelOf: undefined, statusOf: undefined },
);

const { member } = useMe();
const { summary } = useTransactionalProgressText();

const view = computed(() =>
  transactionalProgressOf(
    props.amendment,
    member.value?.id ?? null,
    props.statusOf,
  ),
);

const ICON_CLASSES = {
  info: "text-info",
  warning: "text-warning",
  error: "text-error",
  success: "text-success",
} as const;
</script>

<template>
  <span v-if="view" class="flex items-start gap-1.5 text-sm">
    <UIcon
      :name="view.icon"
      class="mt-0.5 size-4 shrink-0"
      :class="ICON_CLASSES[view.color]"
      aria-hidden="true"
    />
    <span
      :class="view.actorTurn ? 'text-highlighted font-medium' : 'text-default'"
    >
      {{ summary(view, labelOf) }}
    </span>
  </span>
</template>
