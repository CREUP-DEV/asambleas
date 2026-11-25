<script setup lang="ts">
import type { AmendmentDto } from "~~/shared/types/api";
import type { AmendmentOp, Block } from "~~/shared/types/content";
import { globalReplaceExcerpt } from "~~/shared/utils/content/globalReplace";

/**
 * Wraps the diff of an amendment (the default slot, given the operations
 * to show as `ops`). A global replacement is said first, in one line:
 * «Sustituye «X» por «Y» en todo el texto · N apariciones», so its
 * fragments never read as loose changes. With `limit` (the room views,
 * GLOBAL_REPLACE_ROOM_BLOCKS), the diff gets only the occurrences of its
 * first paragraphs and a muted line under it says how many are left.
 * Any other amendment passes through untouched.
 */
const props = withDefaults(
  defineProps<{
    amendment: Pick<AmendmentDto, "ops" | "globalReplace">;
    /** The base text, to find the first paragraphs; null while loading. */
    base: Block[] | null;
    /** Paragraphs with occurrences shown; every one when unset. */
    limit?: number;
    /**
     * Size and leading of the two lines, never their colour ("" inherits);
     * the diff keeps its own.
     */
    textClass?: string;
  }>(),
  { limit: undefined, textClass: "text-sm" },
);

defineSlots<{
  /** The diff, given the operations to show. */
  default(props: { ops: AmendmentOp[] }): unknown;
}>();

const { t } = useI18n();

const excerpt = computed(() =>
  props.amendment.globalReplace
    ? globalReplaceExcerpt(props.base, props.amendment.ops, props.limit)
    : { ops: props.amendment.ops, more: 0 },
);
const count = computed(() => props.amendment.ops.length);
</script>

<template>
  <div class="flex min-w-0 flex-col gap-2">
    <p
      v-if="amendment.globalReplace"
      class="min-w-0 break-words"
      :class="textClass"
    >
      <UIcon
        name="i-lucide-replace-all"
        class="text-muted me-1 size-[1.15em] align-middle"
        aria-hidden="true"
      />{{
        t("amendment.detail.globalReplace", {
          find: amendment.globalReplace.find,
          replace: amendment.globalReplace.replace,
        })
      }}
      <span class="text-muted">
        · {{ t("amendment.detail.occurrences", { count }, count) }}
      </span>
    </p>
    <slot :ops="excerpt.ops" />
    <p v-if="excerpt.more > 0" class="text-muted" :class="textClass">
      {{
        t(
          "amendment.detail.moreOccurrences",
          { count: excerpt.more },
          excerpt.more,
        )
      }}
    </p>
  </div>
</template>
