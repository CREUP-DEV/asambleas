<script setup lang="ts">
import type { AmendmentDto } from "~~/shared/types/api";
import { transactionalProgressOf } from "~/composables/amendment/transactional";
import { useTransactionalProgressText } from "~/composables/amendment/useTransactionalProgressText";

/**
 * One line saying where a presented transactional stands and what it waits
 * for ("Espera la aprobación de CEA-AI", "Falta que acepten: CEUM, CEUCA",
 * "Lista para votar"). Nothing for other amendments, drafts or decided ones.
 * `proponentMemberId` is the document's presenter, found among the parties
 * by member (it may also have written a source).
 */
const props = withDefaults(
  defineProps<{ amendment: AmendmentDto; proponentMemberId?: string | null }>(),
  { proponentMemberId: null },
);

const { member } = useMe();
const { summary } = useTransactionalProgressText();

const view = computed(() =>
  transactionalProgressOf(
    props.amendment,
    member.value?.id ?? null,
    props.proponentMemberId,
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
      {{ summary(view) }}
    </span>
  </span>
</template>
