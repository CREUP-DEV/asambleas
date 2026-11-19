<script setup lang="ts">
import type { AmendmentDto } from "~~/shared/types/api";
import { useSessionConsoleContext } from "~/composables/session/useSessionConsole";

/**
 * Before the Mesa decides an amendment: whether it acts on text approved
 * amendments already changed (user's decisions of 2026-11-19). It is
 * debated over the text as it stands, so the notice says with which, and
 * «Cómo queda» shows that passage now and as it would read if approved. A
 * deletion wins on its own; any other collision the Mesa words after
 * approving it.
 */
const props = withDefaults(
  defineProps<{
    amendment: AmendmentDto;
    /** One line, without the passage (the queue's cards). */
    compact?: boolean;
  }>(),
  { compact: false },
);

const session = useSessionConsoleContext();
const { t } = useI18n();

const impact = computed(() => session.impactOf(props.amendment));
const codes = (ids: readonly string[]) =>
  [...new Set(ids)].map(session.label).join(", ");

const text = computed(() => {
  const value = impact.value;
  if (!value) return "";
  if (value.supersedes.length > 0) {
    return t("session.collision.deletes", { codes: codes(value.supersedes) });
  }
  if (value.supersededBy.length > 0) {
    return t("session.collision.deleted", {
      codes: codes(value.supersededBy),
    });
  }
  return t("session.collision.meets", { codes: codes(value.others) });
});

const shown = ref(false);
</script>

<template>
  <div v-if="impact" class="space-y-2">
    <p class="text-default flex items-start gap-1.5 text-sm">
      <UIcon
        name="i-lucide-git-compare"
        class="text-warning mt-0.5 size-4 shrink-0"
        aria-hidden="true"
      />
      <span class="min-w-0">{{ text }}</span>
    </p>
    <template v-if="!compact">
      <UButton
        color="neutral"
        variant="link"
        size="sm"
        class="px-0"
        :icon="shown ? 'i-lucide-chevron-up' : 'i-lucide-chevron-down'"
        :label="t('session.collision.howItReads')"
        :aria-expanded="shown"
        @click="shown = !shown"
      />
      <div v-if="shown" class="grid gap-3 lg:grid-cols-2">
        <section class="min-w-0 space-y-1">
          <h4 class="text-muted text-xs font-medium tracking-wide uppercase">
            {{ t("session.collision.now") }}
          </h4>
          <ContentView
            :annotated="impact.now"
            mode="provenance"
            :label="session.label"
            :headings="false"
          />
        </section>
        <section class="min-w-0 space-y-1">
          <h4 class="text-muted text-xs font-medium tracking-wide uppercase">
            {{ t("session.collision.after") }}
          </h4>
          <ContentView
            :annotated="impact.after"
            mode="provenance"
            :label="session.label"
            :headings="false"
          />
        </section>
      </div>
    </template>
  </div>
</template>
