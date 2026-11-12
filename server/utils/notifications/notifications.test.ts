import { describe, expect, it, vi } from "vitest";

vi.mock("../../db", () => ({ db: {} }));

const { noticesForEvent } = await import("./rules");
const { eventMayNotify } = await import("./triggers");
const { renderDigestEmail, renderNoticeEmail } = await import("./template");
const { readSmtpConfig, describeSmtpError } = await import("./mailer");
const { readNotificationSettings } =
  await import("~~/shared/utils/schemas/notifications");
const { DEFAULT_NOTIFICATION_SETTINGS } =
  await import("~~/shared/constants/notifications");

type Event = Parameters<typeof noticesForEvent>[0];
type Facts = Parameters<typeof noticesForEvent>[1];

function event(type: string, payload: Record<string, unknown> = {}): Event {
  return {
    id: "ev1",
    assemblyId: "asm1",
    entityType: type.startsWith("document") ? "document" : "amendment",
    entityId: "ent1",
    type,
    payload,
    actorUserId: "u1",
    actorMemberId: "m1",
    impersonationId: null,
  };
}

const documentFacts = (presenters: string[]): Facts => ({
  documentPresenterIds: presenters,
  amendment: null,
});

const amendmentFacts = (
  overrides: Partial<NonNullable<Facts["amendment"]>> = {},
): Facts => ({
  documentPresenterIds: [],
  amendment: {
    transactional: false,
    status: "submitted",
    validated: false,
    authorIds: ["m2", "m3"],
    parties: [],
    ...overrides,
  },
});

const kinds = (notices: ReturnType<typeof noticesForEvent>) =>
  notices.map((notice) => notice.kind);

describe("eventMayNotify", () => {
  it("queues only the events that may send an email", () => {
    expect(eventMayNotify("document_submitted", {})).toBe(true);
    expect(eventMayNotify("speaking_turn_added", {})).toBe(false);
    expect(eventMayNotify("document_content_updated", {})).toBe(false);
  });

  it("queues a document update only when presenters or the deadline change", () => {
    expect(
      eventMayNotify("document_updated", {
        changes: { title: { from: "a", to: "b" } },
      }),
    ).toBe(false);
    expect(
      eventMayNotify("document_updated", {
        changes: { dueAt: { from: null, to: "2026-12-01T00:00:00Z" } },
      }),
    ).toBe(true);
    expect(
      eventMayNotify("document_updated", {
        changes: { proponentMemberId: { from: "a", to: "b" } },
      }),
    ).toBe(true);
  });

  it("queues an acceptance only when it accepts", () => {
    expect(
      eventMayNotify("acceptance_recorded", { decision: "accepted" }),
    ).toBe(true);
    expect(
      eventMayNotify("acceptance_recorded", { decision: "rejected" }),
    ).toBe(false);
  });
});

describe("noticesForEvent", () => {
  it("tells the roles about submissions", () => {
    expect(
      kinds(
        noticesForEvent(event("document_submitted"), documentFacts(["m1"])),
      ),
    ).toEqual(["document_submitted"]);
    expect(
      kinds(noticesForEvent(event("amendment_submitted"), amendmentFacts())),
    ).toEqual(["amendment_submitted"]);
  });

  it("asks the pending parties of a transactional proposed by a member", () => {
    const notices = noticesForEvent(
      event("amendment_submitted", { awaitsAuthors: true }),
      amendmentFacts({
        transactional: true,
        parties: [
          { memberId: "m1", decision: "accepted" },
          { memberId: "m4", decision: "pending" },
        ],
      }),
    );
    expect(notices).toEqual([
      {
        kind: "transactional_acceptance_requested",
        memberIds: ["m4"],
        dedupeKey: "transactional_acceptance_requested:ev1",
      },
    ]);
  });

  it("tells the roles once a transactional reaches the Secretaría", () => {
    const ready = amendmentFacts({
      transactional: true,
      parties: [
        { memberId: "m1", decision: "accepted" },
        { memberId: "m4", decision: "accepted" },
      ],
    });
    const fromSubmission = noticesForEvent(
      event("amendment_submitted", { admission: "pending" }),
      ready,
    );
    const fromAcceptance = noticesForEvent(
      event("acceptance_recorded", { decision: "accepted" }),
      ready,
    );
    expect(kinds(fromSubmission)).toEqual(["transactional_ready"]);
    expect(kinds(fromAcceptance)).toEqual(["transactional_ready"]);
    // Whichever path gets it there, one email per account.
    expect(fromSubmission[0]!.dedupeKey).toBe(fromAcceptance[0]!.dedupeKey);
  });

  it("does not tell about a transactional still waiting or already validated", () => {
    const waiting = amendmentFacts({
      transactional: true,
      parties: [
        { memberId: "m1", decision: "accepted" },
        { memberId: "m4", decision: "pending" },
      ],
    });
    expect(
      noticesForEvent(
        event("acceptance_recorded", { decision: "accepted" }),
        waiting,
      ),
    ).toEqual([]);
    const validated = amendmentFacts({
      transactional: true,
      validated: true,
      parties: [{ memberId: "m4", decision: "accepted" }],
    });
    expect(
      noticesForEvent(
        event("acceptance_recorded", { decision: "accepted" }),
        validated,
      ),
    ).toEqual([]);
  });

  it("never tells about the Mesa's own transactional", () => {
    const mesa = amendmentFacts({ transactional: true });
    expect(
      noticesForEvent(
        event("amendment_submitted", { admission: "admitted" }),
        mesa,
      ),
    ).toEqual([]);
    expect(
      noticesForEvent(event("amendment_validated", { method: "mesa" }), mesa),
    ).toEqual([]);
  });

  it("tells the Mesa and the authors what was validated", () => {
    expect(
      noticesForEvent(
        event("amendment_validated", { publish: true }),
        amendmentFacts(),
      ),
    ).toEqual([
      {
        kind: "submission_validated",
        memberIds: [],
        dedupeKey: "submission_validated:ev1",
      },
      {
        kind: "presenter_validated",
        memberIds: ["m2", "m3"],
        dedupeKey: "presenter_validated:ev1",
      },
    ]);
    expect(
      kinds(
        noticesForEvent(event("document_published"), documentFacts(["m2"])),
      ),
    ).toEqual(["submission_validated", "presenter_validated"]);
  });

  it("tells the new presenters only when a document changes hands", () => {
    const notices = noticesForEvent(
      event("document_updated", {
        changes: {
          proponentMemberId: { from: "m2", to: "m5" },
          coProponentMemberIds: { from: ["m3"], to: ["m3", "m6"] },
        },
      }),
      documentFacts(["m5", "m3", "m6"]),
    );
    expect(notices).toEqual([
      {
        kind: "presenter_assigned",
        memberIds: ["m5", "m6"],
        dedupeKey: "presenter_assigned:ev1",
      },
    ]);
  });

  it("tells the presenters about a new deadline, but not the newly assigned twice", () => {
    const notices = noticesForEvent(
      event("document_updated", {
        changes: {
          coProponentMemberIds: { from: [], to: ["m6"] },
          dueAt: { from: null, to: "2026-12-01T10:00:00Z" },
        },
      }),
      documentFacts(["m5", "m6"]),
    );
    expect(notices.map((notice) => [notice.kind, notice.memberIds])).toEqual([
      ["presenter_assigned", ["m6"]],
      ["presenter_changed", ["m5"]],
    ]);
  });

  it("drops a members' notice with nobody to tell", () => {
    expect(
      noticesForEvent(
        event("document_correction_requested"),
        documentFacts([]),
      ),
    ).toEqual([]);
  });

  it("tells the authors when their amendment is settled or changed", () => {
    for (const type of [
      "amendment_approved",
      "amendment_rejected",
      "amendment_inadmissible",
      "amendment_lapsed",
      "amendment_transacted",
      "amendment_withdrawn",
    ]) {
      expect(kinds(noticesForEvent(event(type), amendmentFacts()))).toEqual([
        "presenter_decided",
      ]);
    }
    expect(
      kinds(noticesForEvent(event("amendment_reclassified"), amendmentFacts())),
    ).toEqual(["presenter_changed"]);
    expect(
      kinds(
        noticesForEvent(
          event("amendment_correction_requested"),
          amendmentFacts(),
        ),
      ),
    ).toEqual(["presenter_correction"]);
  });
});

describe("DEFAULT_NOTIFICATION_SETTINGS", () => {
  it("sends presented amendments in the daily summary and the rest at once", () => {
    for (const [kind, settings] of Object.entries(
      DEFAULT_NOTIFICATION_SETTINGS.kinds,
    )) {
      expect(settings.frequency, kind).toBe(
        kind === "amendment_submitted" ? "daily" : "immediate",
      );
    }
  });
});

describe("readNotificationSettings", () => {
  it("reads nothing stored as the defaults", () => {
    expect(readNotificationSettings(undefined)).toEqual(
      readNotificationSettings(DEFAULT_NOTIFICATION_SETTINGS),
    );
  });

  it("fills a kind or a field the row lacks and drops unknown ones", () => {
    const settings = readNotificationSettings({
      enabled: false,
      kinds: {
        document_submitted: {
          enabled: false,
          roles: ["Presidencia", "Admin", "Admin"],
        },
        old_kind: { enabled: true, roles: [], frequency: "daily" },
      },
    });
    expect(settings.enabled).toBe(false);
    expect(settings.kinds.document_submitted).toEqual({
      enabled: false,
      roles: ["Admin", "Presidencia"],
      frequency: "immediate",
    });
    expect(settings.kinds.submission_validated).toEqual(
      DEFAULT_NOTIFICATION_SETTINGS.kinds.submission_validated,
    );
    expect("old_kind" in settings.kinds).toBe(false);
  });
});

describe("templates", () => {
  const notice = {
    tag: "80.ª AGO" as string | null,
    subject: "Enmienda presentada al documento «<Ley>»",
    heading: "Nueva enmienda",
    lead: "CEUAH ha presentado una enmienda al documento «<Ley>».",
    details: [{ label: "Asamblea", value: "80.ª AGO" }],
    note: { label: "Nota", text: "Línea 1\nLínea <2>" },
    action: { label: "Revisar", url: "https://asambleas.example/a?b=1&c=2" },
  };
  const frame = { origin: "https://asambleas.example", reason: "Por tu rol." };

  it("escapes every value and keeps a plain text part", () => {
    const email = renderNoticeEmail(notice, frame);
    expect(email.html).not.toContain("<Ley>");
    expect(email.html).toContain("«&lt;Ley&gt;»");
    expect(email.html).toContain("Línea 1<br />Línea &lt;2&gt;");
    expect(email.html).toContain(
      'href="https://asambleas.example/a?b=1&amp;c=2"',
    );
    expect(email.html).toContain(
      "https://asambleas.example/marca/horizontal-completo-granate.png",
    );
    expect(email.text).toContain(
      "Revisar: https://asambleas.example/a?b=1&c=2",
    );
    expect(email.text).toContain("Asamblea: 80.ª AGO");
  });

  it("puts the assembly in brackets before the subject", () => {
    expect(renderNoticeEmail(notice, frame).subject).toBe(
      "[80.ª AGO] Enmienda presentada al documento «<Ley>»",
    );
    expect(renderNoticeEmail({ ...notice, tag: null }, frame).subject).toBe(
      "Enmienda presentada al documento «<Ley>»",
    );
    expect(renderNoticeEmail(notice, frame).html).toContain(
      "<title>[80.ª AGO] Enmienda",
    );
  });

  it("puts several notices in one summary", () => {
    const email = renderDigestEmail(
      [notice, { ...notice, heading: "Otra" }],
      frame,
    );
    expect(email.subject).toBe(
      "[80.ª AGO] Resumen de avisos: 2 novedades en la plataforma de asambleas",
    );
    expect(email.text).toContain("Otra");
  });

  it("names each assembly of a summary once", () => {
    const email = renderDigestEmail(
      [notice, notice, { ...notice, tag: "34.ª AGE" }],
      frame,
    );
    expect(email.subject.startsWith("[80.ª AGO, 34.ª AGE] ")).toBe(true);
  });
});

describe("mailer configuration", () => {
  it("needs a host and a sender", () => {
    expect(readSmtpConfig({ NUXT_SMTP_HOST: "smtp" })).toBeNull();
    expect(
      readSmtpConfig({
        NUXT_SMTP_HOST: "smtp",
        NUXT_SMTP_FROM_EMAIL: "asambleas@creup.org",
        NUXT_SMTP_SECURE: "true",
      }),
    ).toMatchObject({ host: "smtp", port: 465, secure: true, user: null });
  });

  it("never logs an address", () => {
    expect(
      describeSmtpError(
        new Error("550 <ana@creup.es>: mailbox unavailable\nmore"),
      ),
    ).toBe("550 <[address]>: mailbox unavailable");
  });
});
