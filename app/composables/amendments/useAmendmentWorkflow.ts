import {
  AMENDMENT_STATUSES,
  type AmendmentStatus,
} from "~~/shared/constants/statuses";
import { PERMISSION_KEYS } from "~~/shared/constants/permissions";

interface Amendment {
  id: string;
  status: string;
  submittedBy: string;
  type: string;
  parentAmendmentId: string | null;
  updatedAt: string | Date;
}

interface Document {
  proponentId: string | null;
}

export const useAmendmentWorkflow = (
  amendment: Ref<Amendment | null | undefined>,
  document: Ref<Document | null | undefined>,
) => {
  const { session } = useAuth();
  const { hasPermission, isAdmin, isSecretaria } = usePermissions();

  const userId = computed(() => session.value.data?.user?.id);

  const isAuthor = computed(
    () => amendment.value?.submittedBy === userId.value,
  );

  const isProponent = computed(
    () => document.value?.proponentId === userId.value,
  );

  const canEdit = computed(() => {
    if (!amendment.value) return false;
    if (amendment.value.status !== AMENDMENT_STATUSES.DRAFT) return false;
    if (!isAuthor.value && !isAdmin.value) return false;
    return hasPermission(PERMISSION_KEYS.AMENDMENT_MANAGE);
  });

  const canSubmit = computed(() => {
    if (!amendment.value) return false;
    if (amendment.value.status !== AMENDMENT_STATUSES.DRAFT) return false;
    return isAuthor.value;
  });

  const canReview = computed(() => {
    if (!amendment.value) return false;
    if (amendment.value.status !== AMENDMENT_STATUSES.PENDING_REVIEW)
      return false;
    return hasPermission(PERMISSION_KEYS.AMENDMENT_REVIEW);
  });

  const canDecideAsProponent = computed(() => {
    if (!amendment.value) return false;
    if (amendment.value.status !== AMENDMENT_STATUSES.ACCEPTED_SECRETARIA)
      return false;
    return isProponent.value || isAdmin.value;
  });

  const canRecordVote = computed(() => {
    if (!amendment.value) return false;
    if (amendment.value.status !== AMENDMENT_STATUSES.REJECTED_PROPONENT)
      return false;
    return hasPermission(PERMISSION_KEYS.ASSEMBLY_VOTE_RESULT);
  });

  const canCreateTransactional = computed(() => {
    if (!amendment.value) return false;
    if (amendment.value.status !== AMENDMENT_STATUSES.ACCEPTED_SECRETARIA)
      return false;
    return (
      isAuthor.value || isProponent.value || isAdmin.value || isSecretaria.value
    );
  });

  const isIncorporated = computed(() => {
    if (!amendment.value) return false;
    const incorporatedStatuses: AmendmentStatus[] = [
      AMENDMENT_STATUSES.FORMAL,
      AMENDMENT_STATUSES.ACCEPTED_PROPONENT,
      AMENDMENT_STATUSES.APPROVED_VOTE,
    ];
    return incorporatedStatuses.includes(
      amendment.value.status as AmendmentStatus,
    );
  });

  const isTerminal = computed(() => {
    if (!amendment.value) return false;
    const terminalStatuses: AmendmentStatus[] = [
      AMENDMENT_STATUSES.REJECTED_SECRETARIA,
      AMENDMENT_STATUSES.FORMAL,
      AMENDMENT_STATUSES.ACCEPTED_PROPONENT,
      AMENDMENT_STATUSES.REJECTED_VOTE,
      AMENDMENT_STATUSES.APPROVED_VOTE,
    ];
    return terminalStatuses.includes(amendment.value.status as AmendmentStatus);
  });

  const isTransactional = computed(() => !!amendment.value?.parentAmendmentId);

  return {
    isAuthor,
    isProponent,
    canEdit,
    canSubmit,
    canReview,
    canDecideAsProponent,
    canRecordVote,
    canCreateTransactional,
    isIncorporated,
    isTerminal,
    isTransactional,
  };
};
