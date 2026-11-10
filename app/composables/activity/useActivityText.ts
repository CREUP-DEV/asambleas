import type {
  ActivityAccessDto,
  ActivityItemDto,
  ActivityTargetDto,
} from "~~/shared/types/api";
import type {
  ActivityCategory,
  AuditSource,
  ChangeEntity,
} from "~~/shared/constants/activity";
import {
  PERMISSION_DESCRIPTION_I18N_KEYS,
  type PermissionKey,
} from "~~/shared/constants/permissions";
import { roleLabelKey } from "~/components/shell/RoleBadge.vue";
import {
  activityActionKey,
  isActivityAction,
  userAgentSummary,
  type ActivityChangeValue,
  type ActivityDetail,
} from "./-present";

/** Longest text of a changed field shown in a sentence; the rest is cut. */
const CHANGE_TEXT_SHOWN = 120;

/** A date-time as the change payloads store it (ISO 8601). */
const ISO_DATE_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/;

/** Names a member the payload refers to by id; null when unknown. */
export type ActivityMemberName = (id: string) => string | null;

/**
 * Turns activity items into plain sentences in the viewer's language:
 * the action, what it is about, who did it, the details worth saying and
 * the device of an access. Dates use the shared formatters.
 */
export function useActivityText() {
  const { t, te, locale } = useI18n();

  function actionLabel(action: string): string {
    return t(activityActionKey(action));
  }

  /** The raw code of an action outside the catalogs (shown to Admins only). */
  function unknownActionCode(action: string): string | null {
    return isActivityAction(action) ? null : action;
  }

  function categoryLabel(category: ActivityCategory): string {
    return t(`activity.categories.${category}`);
  }

  function sourceLabel(source: AuditSource): string {
    return t(`activity.sources.${source}`);
  }

  function roleName(name: string | null): string {
    if (!name) return t("shell.roles.none");
    const key = roleLabelKey(name);
    return key ? t(key) : name;
  }

  function permissionName(key: string): string {
    const labelKey = PERMISSION_DESCRIPTION_I18N_KEYS[key as PermissionKey];
    return labelKey ? t(labelKey) : key;
  }

  function dateTime(value: string | null): string {
    return value ? formatDateTime(value, { locale: locale.value }) : "";
  }

  function time(value: string | null): string {
    return value ? formatTime(value, { locale: locale.value }) : "";
  }

  function memberText(
    id: string | null,
    memberName: ActivityMemberName | undefined,
  ): string {
    if (!id) return t("activity.details.noMember");
    return memberName?.(id) ?? t("activity.details.unknownMember");
  }

  function change(
    from: string | null,
    to: string | null,
    keys: { change: string; set: string; cleared: string },
  ): string {
    if (from && to) return t(keys.change, { from, to });
    if (to) return t(keys.set, { to });
    return t(keys.cleared, { from: from ?? "" });
  }

  /** The name of a field an edit changed ("Título", "Convocatoria"). */
  function changeFieldLabel(entity: ChangeEntity, field: string): string {
    if (entity === "calendar") {
      const note = field.endsWith(".note");
      const milestone = t(
        `calendar.milestones.${note ? field.slice(0, -".note".length) : field}`,
      );
      return note
        ? t("activity.changes.milestoneNote", { milestone })
        : milestone;
    }
    if (entity === "assembly" && field.startsWith("settings.")) {
      return t(`assembly.settings.${field.slice("settings.".length)}.label`);
    }
    if (entity === "document" && field === "acceptedAmendments") {
      return t("document.acceptedRule.label");
    }
    return t(`activity.changes.fields.${entity}.${field}`);
  }

  /** The i18n key that names a coded value of a field, when there is one. */
  function changeCodeKey(
    entity: ChangeEntity,
    field: string,
    code: string,
  ): string | null {
    let key: string | null = null;
    if (entity === "assembly" && field === "type") {
      key = `assembly.types.${code}`;
    } else if (entity === "assembly" && field.startsWith("settings.")) {
      key = `assembly.settings.${field.slice("settings.".length)}.options.${code}.label`;
    } else if (entity === "document" && field === "kind") {
      key = `document.kinds.${code}`;
    } else if (entity === "document" && field === "format") {
      key = `agenda.formats.${code}`;
    } else if (entity === "document" && field === "majority") {
      key = `document.majorities.${code}`;
    } else if (entity === "document" && field === "acceptedAmendments") {
      key = `document.acceptedRule.options.${code}`;
    }
    return key && te(key) ? key : null;
  }

  /** A changed field's value in words: a date, yes/no, a named code or text. */
  function changeValueText(
    entity: ChangeEntity,
    field: string,
    value: ActivityChangeValue,
  ): string {
    if (value === null || value === "") return t("activity.details.empty");
    if (typeof value === "boolean")
      return t(value ? "common.yes" : "common.no");
    if (typeof value === "number") return String(value);
    const code = changeCodeKey(entity, field, value);
    if (code) return t(code);
    if (ISO_DATE_TIME.test(value) && Number.isFinite(Date.parse(value))) {
      return dateTime(value);
    }
    const chars = Array.from(value);
    const shown =
      chars.length > CHANGE_TEXT_SHOWN
        ? `${chars.slice(0, CHANGE_TEXT_SHOWN - 1).join("")}…`
        : value;
    return t("activity.details.quoted", { text: shown });
  }

  /** One detail as a short sentence. */
  function detailText(
    detail: ActivityDetail,
    memberName?: ActivityMemberName,
  ): string {
    switch (detail.type) {
      case "status": {
        const label = (code: string) =>
          t(`common.status.${detail.entity}.${code}`);
        return detail.from
          ? t("activity.details.status", {
              from: label(detail.from),
              to: label(detail.to),
            })
          : t("activity.details.statusTo", { to: label(detail.to) });
      }
      case "role":
        return change(
          detail.from ? roleName(detail.from) : null,
          detail.to ? roleName(detail.to) : null,
          {
            change: "activity.details.role",
            set: "activity.details.roleSet",
            cleared: "activity.details.roleCleared",
          },
        );
      case "permissions":
        return [
          detail.added.length > 0
            ? t("activity.details.permissionsAdded", {
                list: detail.added.map(permissionName).join(", "),
              })
            : null,
          detail.removed.length > 0
            ? t("activity.details.permissionsRemoved", {
                list: detail.removed.map(permissionName).join(", "),
              })
            : null,
        ]
          .filter(Boolean)
          .join(" · ");
      case "granted":
        return t("activity.details.permissionsAdded", {
          list: detail.keys.map(permissionName).join(", "),
        });
      case "member":
        return change(
          detail.from ? memberText(detail.from, memberName) : null,
          detail.to ? memberText(detail.to, memberName) : null,
          {
            change: "activity.details.member",
            set: "activity.details.memberSet",
            cleared: "activity.details.memberCleared",
          },
        );
      case "intranet":
        return t("activity.details.intranetChange", {
          field: t(`activity.details.intranetFields.${detail.field}`),
          from: detail.from ?? t("activity.details.empty"),
          to: detail.to ?? t("activity.details.empty"),
        });
      case "note":
        return t("activity.details.note", { note: detail.text });
      case "late":
        return t("amendment.late");
      case "result":
        return t(`common.status.vote.${detail.result}`);
      case "position":
        return t(`amendment.position.options.${detail.position}`);
      case "acceptance":
        return t(`common.status.acceptance.${detail.decision}`);
      case "reclassified":
        return t(`amendment.reclassify.changed.${detail.to}`);
      case "reason":
        return t("activity.details.reason", { reason: detail.text });
      case "roleSyncFailed":
        return t("activity.details.roleSyncFailed");
      case "sync":
        return t("activity.details.sync", {
          created: detail.created,
          updated: detail.updated,
          deactivated: detail.deactivated,
        });
      case "ended":
        return detail.at
          ? t("activity.details.endedAt", {
              reason: t(`activity.endReasons.${detail.reason}`),
              time: dateTime(detail.at),
            })
          : t(`activity.endReasons.${detail.reason}`);
      case "ongoing":
        return t("activity.details.ongoing", { time: time(detail.until) });
      case "change":
        return t("activity.details.change", {
          field: changeFieldLabel(detail.entity, detail.field),
          from: changeValueText(detail.entity, detail.field, detail.from),
          to: changeValueText(detail.entity, detail.field, detail.to),
        });
      case "changed":
        return t("activity.details.changed", {
          field: changeFieldLabel(detail.entity, detail.field),
        });
      case "subItems":
        return t("activity.details.subItems", {
          list: detail.titles.join(", "),
        });
      case "moved":
        return t(
          "activity.details.moved",
          { count: detail.count },
          detail.count,
        );
      case "afterFinal":
        return t("activity.details.afterFinal");
      case "autoItem":
        return t("activity.details.autoItem");
      case "cascade":
        return t("activity.details.cascade");
      case "deletedDocuments":
        return t(
          "activity.details.deletedDocuments",
          { count: detail.count },
          detail.count,
        );
    }
  }

  /**
   * The main words of what an item is about: the amendment's code, the
   * document's title, the agenda item, the account, the role. "Tu cuenta"
   * when it is the viewer's own.
   */
  function targetLabel(
    target: ActivityTargetDto,
    selfId?: string | null,
  ): string {
    if (!target.available) return t("activity.target.unavailable");
    switch (target.type) {
      case "amendment":
        return target.label
          ? t("activity.target.amendment", { code: target.label })
          : t("activity.target.amendmentNoCode");
      case "document":
        return (
          target.label ??
          target.document?.title ??
          t("activity.target.document")
        );
      case "agenda_item":
        return target.label
          ? t("activity.target.agendaItem", { title: target.label })
          : t("activity.target.agendaItemNoTitle");
      case "user":
        if (selfId && target.id === selfId) return t("activity.target.you");
        return target.label ?? t("activity.target.user");
      case "role":
        return target.label
          ? t("activity.target.role", { role: roleName(target.label) })
          : t("activity.target.roleNoName");
      case "member":
        return target.label ?? t("activity.target.member");
      case "members":
        return t("activity.target.members");
      case "users":
        return t("activity.target.users");
      case "calendar_rules":
        return target.label
          ? t("activity.target.calendarRules", { type: target.label })
          : t("activity.target.calendarRulesNoType");
      case "vote":
      case "decision":
      case "live":
      case "speakers":
      case "headcount":
        return (
          target.document?.title ??
          target.assembly?.label ??
          t("activity.target.session")
        );
      case "assembly":
        return (
          target.assembly?.label ??
          target.label ??
          t("activity.target.assembly")
        );
      default:
        return target.label ?? target.assembly?.label ?? "";
    }
  }

  /**
   * Where the target sits, besides its main words: the document of an
   * amendment or agenda vote, and the assembly ("Reglamento · 80.ª AGO").
   * Kept when the target is no longer available, since the server keeps the
   * assembly then.
   */
  function targetContext(target: ActivityTargetDto): string {
    const main = targetLabel(target);
    const parts: string[] = [];
    if (target.available && target.document && target.document.title !== main) {
      parts.push(target.document.title);
    }
    if (target.assembly && target.assembly.label !== main) {
      parts.push(target.assembly.label);
    }
    return parts.join(" · ");
  }

  /** Who did it: "CEUM · Ana García", or the platform or the intranet. */
  function actorLabel(item: Pick<ActivityItemDto, "actor" | "source">): string {
    if (!item.actor) {
      return t(
        item.source === "intranet"
          ? "activity.actor.intranet"
          : "activity.actor.system",
      );
    }
    return item.actor.member
      ? `${item.actor.member.acronym} · ${item.actor.name}`
      : item.actor.name;
  }

  /** "Chrome en Windows"; null when the user agent says nothing useful. */
  function deviceLabel(access: ActivityAccessDto | null): string | null {
    const { browser, os } = userAgentSummary(access?.userAgent);
    if (browser && os) return t("activity.access.device", { browser, os });
    return browser ?? os;
  }

  /** "Chrome en Windows · IP 192.0.2.1"; null when nothing is known. */
  function accessLabel(access: ActivityAccessDto | null): string | null {
    if (!access) return null;
    const device = deviceLabel(access);
    const ip = access.ipAddress
      ? t("activity.access.ip", { ip: access.ipAddress })
      : null;
    return [device, ip].filter(Boolean).join(" · ") || null;
  }

  return {
    actionLabel,
    unknownActionCode,
    categoryLabel,
    sourceLabel,
    roleName,
    detailText,
    targetLabel,
    targetContext,
    actorLabel,
    deviceLabel,
    accessLabel,
    dateTime,
    time,
  };
}
