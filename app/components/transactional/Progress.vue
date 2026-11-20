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
    /** A grouped amendment that is late and awaits the assembly. */
    awaitsAdmissionOf?: (id: string) => boolean;
  }>(),
  { labelOf: undefined, statusOf: undefined, awaitsAdmissionOf: undefined },
);

const { member } = useMe();
const { summary, summaryLinks } = useTransactionalProgressText();

const view = computed(() =>
  transactionalProgressOf(
    props.amendment,
    member.value?.id ?? null,
    props.statusOf,
    props.awaitsAdmissionOf,
  ),
);

const links = computed(() =>
  view.value ? summaryLinks(view.value, props.labelOf) : null,
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
      <!-- The amendments it replaced open, with a preview, where the page
           provides AMENDMENT_LINKS_KEY. -->
      <i18n-t
        v-if="links && labelOf"
        :keypath="links.key"
        tag="span"
        scope="global"
      >
        <template #list>
          <AmendmentCodeLinks :ids="links.ids" :label-of="labelOf" />
        </template>
      </i18n-t>
      <template v-else>{{ summary(view, labelOf) }}</template>
    </span>
  </span>
</template>
