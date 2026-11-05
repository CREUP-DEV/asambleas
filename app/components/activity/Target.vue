<script setup lang="ts">
import type { RouteLocationRaw } from "vue-router";
import type { ActivityItemDto } from "~~/shared/types/api";
import { assemblyPath } from "~/components/shell/Navigation.vue";
import { activityLink } from "~/composables/activity/-present";

/**
 * What an activity item is about, as a link to its page when the viewer
 * can open it: the amendment inside its document, the document, the
 * agenda, the live session or the assembly, then where it sits ("Reglamento
 * · 80.ª AGO"). Something the viewer can no longer see says so and keeps
 * only its assembly. On the Admin's log an account opens that account's
 * activity (`userLink`).
 */
const props = withDefaults(
  defineProps<{
    item: Pick<ActivityItemDto, "action" | "target">;
    /** The viewer's account: it reads "Tu cuenta". */
    selfId?: string | null;
    /** Where an account target leads (the Admin's log filtered by it). */
    userLink?: ((userId: string) => RouteLocationRaw) | null;
  }>(),
  { selfId: null, userLink: null },
);

const localePath = useLocalePath();
const { targetLabel, targetContext } = useActivityText();

const label = computed(() => targetLabel(props.item.target, props.selfId));
const context = computed(() => targetContext(props.item.target));

const to = computed<RouteLocationRaw | null>(() => {
  const target = props.item.target;
  if (target.available && target.type === "user" && props.userLink) {
    return props.userLink(target.id);
  }
  const link = activityLink(props.item);
  if (!link) return null;
  const base = assemblyPath(link.slug, link.section);
  if (!link.document) return localePath(base);
  return localePath({
    path: `${base}/${encodeURIComponent(link.document)}`,
    query: link.amendment ? { enmienda: link.amendment } : undefined,
  });
});
</script>

<template>
  <span class="min-w-0 break-words">
    <span
      v-if="!props.item.target.available"
      class="text-muted inline-flex items-center gap-1 italic"
    >
      <UIcon
        name="i-lucide-eye-off"
        class="size-3.5 shrink-0"
        aria-hidden="true"
      />
      {{ label }}
    </span>
    <ULink
      v-else-if="to"
      :to="to"
      class="text-default hover:text-primary focus-visible:outline-primary rounded-sm font-medium underline-offset-2 hover:underline focus-visible:outline-2 focus-visible:outline-offset-2"
    >
      {{ label }}
    </ULink>
    <span v-else-if="label" class="text-default font-medium">{{ label }}</span>
    <span v-if="context" class="text-muted">
      <template v-if="label"> · </template>{{ context }}
    </span>
  </span>
</template>
