<script setup lang="ts">
import {
  homeWorkAmendmentQuery,
  type HomeWorkUpdate,
  type HomeWorkUpdateKind,
} from "~/components/home/-work";
import { assemblyPath } from "~/components/shell/Navigation.vue";

/**
 * Where the user's documents and amendments stand when there is nothing for
 * them to do: one line each, with a sentence that says what happens next
 * (a late amendment says the assembly still has to decide whether to treat
 * it; a transactional the user proposed, that it waits for the main authors
 * of what it replaces). Long lists show the first few and fold the rest
 * away.
 */
const props = withDefaults(
  defineProps<{
    updates: HomeWorkUpdate[];
    showAssembly?: boolean;
    /** Rows shown before "Mostrar más". */
    initial?: number;
  }>(),
  { showAssembly: true, initial: 5 },
);

const { t, te } = useI18n();
const localePath = useLocalePath();

const UPDATE_ICONS: Record<HomeWorkUpdateKind, { icon: string; tone: string }> =
  {
    document_review: { icon: "i-lucide-hourglass", tone: "text-info" },
    amendment_authors: { icon: "i-lucide-handshake", tone: "text-info" },
    amendment_review: { icon: "i-lucide-hourglass", tone: "text-info" },
    amendment_late: { icon: "i-lucide-clock-alert", tone: "text-warning" },
    amendment_validated: { icon: "i-lucide-eye-off", tone: "text-muted" },
    document_published: { icon: "i-lucide-circle-check", tone: "text-success" },
    amendment_published: {
      icon: "i-lucide-circle-check",
      tone: "text-success",
    },
    amendment_other: { icon: "i-lucide-circle-dot", tone: "text-muted" },
  };

const expanded = ref(false);
const shown = computed(() =>
  expanded.value ? props.updates : props.updates.slice(0, props.initial),
);
const hidden = computed(() => props.updates.length - shown.value.length);

function title(update: HomeWorkUpdate): string {
  if (!update.amendment) return update.document.title;
  return update.amendment.code
    ? t("home.work.amendment", { code: update.amendment.code })
    : t("home.work.amendmentDraft");
}

function context(update: HomeWorkUpdate): string {
  const parts: string[] = [];
  if (update.amendment) {
    parts.push(t("home.work.amendmentTo", { document: update.document.title }));
  }
  if (props.showAssembly) parts.push(update.assembly.label);
  return parts.join(" · ");
}

function sentence(update: HomeWorkUpdate): string {
  if (update.kind !== "amendment_other") {
    return t(`home.work.updates.${update.kind}`);
  }
  const key = `common.status.amendment.${update.amendment?.status ?? ""}`;
  return t("home.work.updates.amendment_other", {
    status: te(key) ? t(key) : (update.amendment?.status ?? ""),
  });
}

/** The document, with the amendment open when the update is about one. */
function path(update: HomeWorkUpdate): string {
  return localePath(
    `${assemblyPath(update.assembly.slug, "documents")}/${encodeURIComponent(update.document.slug)}${homeWorkAmendmentQuery(update.amendment)}`,
  );
}
</script>

<template>
  <div class="space-y-3">
    <ul class="divide-default -my-2.5 divide-y">
      <li
        v-for="update in shown"
        :key="update.key"
        class="flex gap-3 py-2.5"
        :data-update="update.kind"
      >
        <UIcon
          :name="UPDATE_ICONS[update.kind].icon"
          class="mt-0.5 size-5 shrink-0"
          :class="UPDATE_ICONS[update.kind].tone"
          aria-hidden="true"
        />
        <div class="min-w-0 flex-1">
          <NuxtLink
            :to="path(update)"
            class="text-highlighted hover:text-primary focus-visible:outline-primary rounded-sm font-medium break-words focus-visible:outline-2 focus-visible:outline-offset-2"
          >
            {{ title(update) }}
          </NuxtLink>
          <p v-if="context(update)" class="text-muted text-xs break-words">
            {{ context(update) }}
          </p>
          <p class="text-default text-sm">{{ sentence(update) }}</p>
        </div>
      </li>
    </ul>
    <UButton
      v-if="hidden > 0 || expanded"
      color="neutral"
      variant="link"
      size="sm"
      class="px-0"
      :trailing-icon="
        expanded ? 'i-lucide-chevron-up' : 'i-lucide-chevron-down'
      "
      :aria-expanded="expanded"
      :label="
        expanded
          ? t('home.mine.showLess')
          : t('home.mine.showMore', { count: hidden }, hidden)
      "
      @click="expanded = !expanded"
    />
  </div>
</template>
