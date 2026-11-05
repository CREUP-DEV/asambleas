<script setup lang="ts">
import {
  homeWorkAmendmentQuery,
  type HomeWorkNews,
  type HomeWorkPhrase,
  type HomeWorkWho,
} from "~/components/home/-work";
import { assemblyPath } from "~/components/shell/Navigation.vue";

/**
 * "Novedades": what others decided about the user's documents and
 * amendments, one plain sentence each ("UPV, proponente principal, aceptó
 * tu enmienda CEUM 2"), with the document, the assembly and when. Each
 * sentence opens the document with the amendment. Long lists show the
 * latest few and fold the rest away.
 */
const props = withDefaults(
  defineProps<{
    news: HomeWorkNews[];
    showAssembly?: boolean;
    /** Rows shown before "Mostrar más". */
    initial?: number;
  }>(),
  { showAssembly: true, initial: 4 },
);

const { t, locale } = useI18n();
const localePath = useLocalePath();
const now = useAppNow();

const TONE: Record<HomeWorkNews["tone"], { icon: string; color: string }> = {
  success: { icon: "i-lucide-circle-check", color: "text-success" },
  error: { icon: "i-lucide-circle-x", color: "text-error" },
  neutral: { icon: "i-lucide-bell-dot", color: "text-info" },
};

const expanded = ref(false);
const shown = computed(() =>
  expanded.value ? props.news : props.news.slice(0, props.initial),
);
const hidden = computed(() => props.news.length - shown.value.length);

function phrase(value: HomeWorkPhrase | HomeWorkWho | null): string {
  if (!value) return "";
  return "name" in value ? value.name : t(value.key, value.params);
}

function sentence(item: HomeWorkNews): string {
  return t(item.sentence.key, {
    ...item.sentence.params,
    who: phrase(item.who),
    amendment: phrase(item.phrase),
  });
}

function context(item: HomeWorkNews): string {
  const parts = [t("home.work.amendmentTo", { document: item.document.title })];
  if (props.showAssembly) parts.push(item.assembly.label);
  return parts.join(" · ");
}

function when(item: HomeWorkNews): string {
  return formatRelative(item.at, { locale: locale.value, now: now.value });
}

function exact(item: HomeWorkNews): string {
  return formatDateTime(item.at, { locale: locale.value });
}

/** The document, with the amendment open when the news is about one. */
function path(item: HomeWorkNews): string {
  return localePath(
    `${assemblyPath(item.assembly.slug, "documents")}/${encodeURIComponent(item.document.slug)}${homeWorkAmendmentQuery(item.amendment)}`,
  );
}
</script>

<template>
  <div class="space-y-3">
    <ul class="divide-default -my-2.5 divide-y">
      <li v-for="item in shown" :key="item.key" class="flex gap-3 py-2.5">
        <UIcon
          :name="TONE[item.tone].icon"
          class="mt-0.5 size-5 shrink-0"
          :class="TONE[item.tone].color"
          aria-hidden="true"
        />
        <div class="min-w-0 flex-1">
          <NuxtLink
            :to="path(item)"
            class="text-default hover:text-primary focus-visible:outline-primary rounded-sm break-words focus-visible:outline-2 focus-visible:outline-offset-2"
          >
            {{ sentence(item) }}
          </NuxtLink>
          <p class="text-muted text-xs break-words">
            {{ context(item) }} ·
            <time :datetime="item.at" :title="exact(item)">{{
              when(item)
            }}</time>
          </p>
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
