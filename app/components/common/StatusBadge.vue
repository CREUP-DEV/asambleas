<script lang="ts">
import type {
  AcceptanceDecision,
  AdmissionStatus,
  AmendmentStatus,
  AssemblyStatus,
  DocumentStatus,
  ProponentPosition,
  VoteResult,
} from "~~/shared/constants/domain";

export type StatusKind =
  | "assembly"
  | "document"
  | "amendment"
  | "admission"
  | "position"
  | "vote"
  | "acceptance";

export type StatusColor =
  | "primary"
  | "secondary"
  | "success"
  | "info"
  | "warning"
  | "error"
  | "neutral";

/** Badge colour of every status value, per kind. */
export const STATUS_COLORS: {
  assembly: Record<AssemblyStatus, StatusColor>;
  document: Record<DocumentStatus, StatusColor>;
  amendment: Record<AmendmentStatus, StatusColor>;
  admission: Record<AdmissionStatus, StatusColor>;
  position: Record<ProponentPosition, StatusColor>;
  vote: Record<VoteResult, StatusColor>;
  acceptance: Record<AcceptanceDecision, StatusColor>;
} = {
  assembly: {
    draft: "neutral",
    convened: "info",
    in_session: "success",
    closed: "neutral",
  },
  document: {
    draft: "neutral",
    submitted: "info",
    published: "success",
    withdrawn: "neutral",
    postponed: "warning",
  },
  amendment: {
    draft: "neutral",
    submitted: "info",
    inadmissible: "error",
    withdrawn: "neutral",
    transacted: "secondary",
    lapsed: "warning",
    approved: "success",
    rejected: "error",
  },
  admission: {
    pending: "warning",
    admitted: "success",
    inadmissible: "error",
  },
  position: {
    pending: "neutral",
    accept: "success",
    reject: "error",
    transact: "secondary",
  },
  vote: {
    approved: "success",
    rejected: "error",
  },
  acceptance: {
    pending: "warning",
    accepted: "success",
    rejected: "error",
  },
};

/** i18n key of a status label: `common.status.<kind>.<value>`. */
export function statusLabelKey(kind: StatusKind, value: string): string {
  return `common.status.${kind}.${value}`;
}
</script>

<script setup lang="ts">
/**
 * Coloured badge for a domain status (assembly, document, amendment,
 * admission, proponent position, vote result, transactional acceptance).
 * Unknown values fall back to a neutral badge with the raw value.
 */
const props = withDefaults(
  defineProps<{
    kind: StatusKind;
    value: string;
    size?: "xs" | "sm" | "md" | "lg" | "xl";
    variant?: "solid" | "outline" | "soft" | "subtle";
    icon?: string;
  }>(),
  { size: "sm", variant: "subtle", icon: undefined },
);

const { t, te } = useI18n();

const color = computed<StatusColor>(() => {
  const colors = STATUS_COLORS[props.kind] as Record<string, StatusColor>;
  return colors[props.value] ?? "neutral";
});

const label = computed(() => {
  const key = statusLabelKey(props.kind, props.value);
  return te(key) ? t(key) : props.value;
});
</script>

<template>
  <UBadge
    :color="color"
    :variant="variant"
    :size="size"
    :icon="icon"
    :label="label"
    :data-status="`${kind}:${value}`"
    class="whitespace-nowrap"
  />
</template>
