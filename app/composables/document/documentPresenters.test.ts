import { describe, expect, it } from "vitest";
import type { MemberRef } from "~~/shared/types/api";
import {
  choicePresenterIds,
  coPresentersDroppedWithoutLead,
  documentCoPresenters,
  documentPresenterMembers,
  formatMemberList,
  formPresenterChoice,
  handedOverMainPresenter,
  isDocumentPresenter,
  listSegments,
  mainPresenterMissing,
  needsMainPresenter,
  presenterChoiceFromDocument,
  presenterFields,
  presenterPartners,
  resolveMainPresenter,
  samePresenterFields,
  showsDocumentStatus,
  stablePresenterOrder,
  withDefaultMainPresenter,
  withMainAsLead,
  withPresenterLead,
} from "./documentPresenters";

function member(id: string): MemberRef {
  return {
    id,
    acronym: id.toUpperCase(),
    name: `Member ${id}`,
    kind: "asociado",
  };
}

const CEUM = member("ceum");
const UPV = member("upv");
const UV = member("uv");

describe("documentCoPresenters", () => {
  it("drops the main presenter and repeats", () => {
    expect(
      documentCoPresenters({ proponent: CEUM, coProponents: [UPV, CEUM, UPV] }),
    ).toEqual([UPV]);
  });

  it("reads a summary without co-presenters (older server)", () => {
    expect(documentCoPresenters({ proponent: CEUM })).toEqual([]);
    expect(documentPresenterMembers({ proponent: CEUM })).toEqual([CEUM]);
  });
});

describe("isDocumentPresenter", () => {
  const document = { proponent: CEUM, coProponents: [UPV] };

  it("counts the main presenter and the co-presenters", () => {
    expect(isDocumentPresenter(document, "ceum")).toBe(true);
    expect(isDocumentPresenter(document, "upv")).toBe(true);
    expect(isDocumentPresenter(document, "uv")).toBe(false);
  });

  it("is false without a member", () => {
    expect(isDocumentPresenter(document, null)).toBe(false);
    expect(isDocumentPresenter({ proponent: null }, undefined)).toBe(false);
  });
});

describe("showsDocumentStatus", () => {
  const published = {
    proponent: CEUM,
    coProponents: [UPV],
    status: "published",
  };

  it("says Publicado only to the presenters", () => {
    expect(showsDocumentStatus(published, "ceum")).toBe(true);
    expect(showsDocumentStatus(published, "upv")).toBe(true);
    expect(showsDocumentStatus(published, "uv")).toBe(false);
    expect(showsDocumentStatus(published, null)).toBe(false);
  });

  it("always shows any other status", () => {
    for (const status of ["draft", "submitted", "withdrawn", "postponed"]) {
      expect(showsDocumentStatus({ ...published, status }, "uv")).toBe(true);
    }
  });
});

describe("presenterPartners", () => {
  const document = { proponent: CEUM, coProponents: [UPV, UV] };

  it("tells a co-presenter who else presents it and who answers", () => {
    expect(presenterPartners(document, "upv")).toEqual({
      others: [CEUM, UV],
      main: CEUM,
      mainIsMine: false,
    });
  });

  it("tells the main presenter it answers", () => {
    expect(presenterPartners(document, "ceum")).toEqual({
      others: [UPV, UV],
      main: CEUM,
      mainIsMine: true,
    });
  });

  it("is null for a lone presenter or someone else", () => {
    expect(presenterPartners({ proponent: CEUM }, "ceum")).toBeNull();
    expect(presenterPartners(document, "other")).toBeNull();
  });
});

describe("presenter choice", () => {
  it("needs no choice for a lone presenter", () => {
    const choice = { leadId: "ceum", coIds: [], mainId: null };
    expect(needsMainPresenter(choice)).toBe(false);
    expect(resolveMainPresenter(choice)).toBe("ceum");
    expect(mainPresenterMissing(choice)).toBe(false);
    expect(presenterFields(choice)).toEqual({
      proponentMemberId: "ceum",
      coProponentMemberIds: [],
    });
  });

  it("requires a main presenter among several", () => {
    const choice = { leadId: "ceum", coIds: ["upv"], mainId: null };
    expect(needsMainPresenter(choice)).toBe(true);
    expect(mainPresenterMissing(choice)).toBe(true);
    expect(
      mainPresenterMissing({ ...choice, mainId: "uv" }),
      "a member who does not present it",
    ).toBe(true);
    expect(mainPresenterMissing({ ...choice, mainId: "upv" })).toBe(false);
  });

  it("never lists the main presenter among the co-presenters", () => {
    expect(
      presenterFields({
        leadId: "ceum",
        coIds: ["upv", "ceum", "uv"],
        mainId: "upv",
      }),
    ).toEqual({
      proponentMemberId: "upv",
      coProponentMemberIds: ["ceum", "uv"],
    });
  });

  it("takes the lone co-presenter as main when nobody leads", () => {
    const choice = { leadId: null, coIds: ["upv"], mainId: null };
    expect(choicePresenterIds(choice)).toEqual(["upv"]);
    expect(presenterFields(choice).proponentMemberId).toBe("upv");
  });

  it("compares the co-presenters in any order", () => {
    expect(
      samePresenterFields(
        { proponentMemberId: "ceum", coProponentMemberIds: ["upv", "uv"] },
        { proponentMemberId: "ceum", coProponentMemberIds: ["uv", "upv"] },
      ),
    ).toBe(true);
    expect(
      samePresenterFields(
        { proponentMemberId: "ceum", coProponentMemberIds: ["upv"] },
        { proponentMemberId: "upv", coProponentMemberIds: ["ceum"] },
      ),
    ).toBe(false);
    expect(
      samePresenterFields(
        { proponentMemberId: "ceum", coProponentMemberIds: ["upv"] },
        { proponentMemberId: "ceum", coProponentMemberIds: ["upv", "uv"] },
      ),
    ).toBe(false);
  });
});

describe("presenterChoiceFromDocument", () => {
  const document = { proponent: CEUM, coProponents: [UPV, UV] };

  it("leads with the main presenter", () => {
    expect(presenterChoiceFromDocument(document)).toEqual({
      leadId: "ceum",
      coIds: ["upv", "uv"],
      mainId: "ceum",
    });
  });

  it("keeps a co-presenter's own member fixed as the lead", () => {
    const choice = presenterChoiceFromDocument(document, "upv");
    expect(choice).toEqual({
      leadId: "upv",
      coIds: ["ceum", "uv"],
      mainId: "ceum",
    });
    expect(presenterFields(choice)).toEqual({
      proponentMemberId: "ceum",
      coProponentMemberIds: ["upv", "uv"],
    });
  });

  it("round-trips to the stored fields", () => {
    for (const own of [null, "ceum", "upv", "uv"]) {
      expect(
        samePresenterFields(
          presenterFields(presenterChoiceFromDocument(document, own)),
          { proponentMemberId: "ceum", coProponentMemberIds: ["upv", "uv"] },
        ),
      ).toBe(true);
    }
  });
});

describe("withPresenterLead", () => {
  it("takes the new lead out of the co-presenters", () => {
    expect(
      withPresenterLead(
        { leadId: "ceum", coIds: ["upv", "uv"], mainId: "uv" },
        "upv",
      ),
    ).toEqual({ leadId: "upv", coIds: ["uv"], mainId: "uv" });
  });

  it("moves the answer along when the previous lead had it", () => {
    expect(
      withPresenterLead(
        { leadId: "ceum", coIds: ["upv"], mainId: "ceum" },
        "uv",
      ),
    ).toEqual({ leadId: "uv", coIds: ["upv"], mainId: "uv" });
  });

  it("never picks who answers when nobody had been chosen", () => {
    expect(
      withPresenterLead({ leadId: null, coIds: ["upv"], mainId: null }, "uv"),
    ).toEqual({ leadId: "uv", coIds: ["upv"], mainId: null });
  });
});

describe("formPresenterChoice", () => {
  it("sends no co-presenters when nobody presents it", () => {
    const choice = formPresenterChoice({
      leadId: null,
      coIds: ["upv"],
      mainId: null,
    });
    expect(choice.coIds).toEqual([]);
    expect(needsMainPresenter(choice)).toBe(false);
    expect(mainPresenterMissing(choice)).toBe(false);
    expect(presenterFields(choice)).toEqual({
      proponentMemberId: null,
      coProponentMemberIds: [],
    });
  });

  it("keeps the co-presenters of a lead", () => {
    const choice = { leadId: "ceum", coIds: ["upv"], mainId: "ceum" };
    expect(formPresenterChoice(choice)).toEqual(choice);
  });
});

describe("withMainAsLead", () => {
  it("makes the chosen presenter the lead and the old lead a co-presenter", () => {
    expect(
      withMainAsLead(
        { leadId: "ceum", coIds: ["upv", "uv"], mainId: "ceum" },
        "upv",
      ),
    ).toEqual({ leadId: "upv", coIds: ["ceum", "uv"], mainId: "upv" });
  });

  it("only records the choice of the lead or of a non-presenter", () => {
    const choice = { leadId: "ceum", coIds: ["upv"], mainId: null };
    expect(withMainAsLead(choice, "ceum")).toEqual({
      ...choice,
      mainId: "ceum",
    });
    expect(withMainAsLead(choice, "other")).toEqual({
      ...choice,
      mainId: "other",
    });
    expect(withMainAsLead(choice, null)).toEqual(choice);
    expect(
      withMainAsLead({ leadId: null, coIds: ["upv"], mainId: null }, "upv"),
    ).toEqual({ leadId: null, coIds: ["upv"], mainId: "upv" });
  });

  it("stores what the form shows", () => {
    const swapped = withMainAsLead(
      { leadId: "ceum", coIds: ["upv"], mainId: "ceum" },
      "upv",
    );
    expect(presenterFields(swapped)).toEqual({
      proponentMemberId: "upv",
      coProponentMemberIds: ["ceum"],
    });
  });

  it("survives the lead watcher that runs after the swap", () => {
    const before = { leadId: "ceum", coIds: ["upv", "uv"], mainId: "ceum" };
    const swapped = withMainAsLead(before, "uv");
    // The form's watcher on the lead sees the old lead as `previous`.
    const after = withPresenterLead(
      { ...swapped, leadId: before.leadId },
      swapped.leadId,
    );
    expect(after).toEqual(swapped);
  });
});

describe("withDefaultMainPresenter", () => {
  it("lets the lead answer when a co-presenter is added", () => {
    expect(
      withDefaultMainPresenter({
        leadId: "ceum",
        coIds: ["upv"],
        mainId: null,
      }),
    ).toEqual({ leadId: "ceum", coIds: ["upv"], mainId: "ceum" });
  });

  it("keeps a choice among the presenters", () => {
    const choice = { leadId: "ceum", coIds: ["upv"], mainId: "upv" };
    expect(withDefaultMainPresenter(choice)).toBe(choice);
  });

  it("falls back to the lead when the chosen one left", () => {
    expect(
      withDefaultMainPresenter({
        leadId: "ceum",
        coIds: ["uv"],
        mainId: "upv",
      }),
    ).toEqual({ leadId: "ceum", coIds: ["uv"], mainId: "ceum" });
  });

  it("changes nothing for a lone presenter or without a lead", () => {
    const alone = { leadId: "ceum", coIds: [], mainId: null };
    expect(withDefaultMainPresenter(alone)).toBe(alone);
    const leadless = { leadId: null, coIds: ["upv", "uv"], mainId: null };
    expect(withDefaultMainPresenter(leadless)).toBe(leadless);
  });
});

describe("stablePresenterOrder", () => {
  it("keeps the places of those still there and adds new ones last", () => {
    expect(
      stablePresenterOrder(["ceum", "upv", "uv"], ["uv", "ceum", "um"]),
    ).toEqual(["ceum", "uv", "um"]);
  });

  it("does not move the presenters when the lead is swapped", () => {
    const before = { leadId: "ceum", coIds: ["upv", "uv"], mainId: "ceum" };
    const after = withMainAsLead(before, "uv");
    expect(
      stablePresenterOrder(
        choicePresenterIds(before),
        choicePresenterIds(after),
      ),
    ).toEqual(["ceum", "upv", "uv"]);
  });
});

describe("listSegments", () => {
  it("joins the items as each locale does", () => {
    expect(formatMemberList(["UPV", "UV", "UM"], "es")).toBe("UPV, UV y UM");
    expect(formatMemberList(["UPV", "UV"], "en")).toBe("UPV and UV");
    expect(formatMemberList(["UPV"], "es")).toBe("UPV");
    expect(formatMemberList([], "es")).toBe("");
  });

  it("returns every item once, in order", () => {
    const items = listSegments(4, "es").filter(
      (segment) => segment.kind === "item",
    );
    expect(items.map((segment) => segment.index)).toEqual([0, 1, 2, 3]);
  });
});

describe("handedOverMainPresenter", () => {
  it("names the presenter chosen instead of the user's own member", () => {
    expect(
      handedOverMainPresenter(
        { leadId: "ceum", coIds: ["upv"], mainId: "upv" },
        "ceum",
      ),
    ).toBe("upv");
  });

  it("is null while the user's own member answers", () => {
    expect(
      handedOverMainPresenter(
        { leadId: "ceum", coIds: ["upv"], mainId: "ceum" },
        "ceum",
      ),
    ).toBeNull();
    expect(
      handedOverMainPresenter(
        { leadId: "ceum", coIds: [], mainId: null },
        "ceum",
      ),
    ).toBeNull();
  });

  it("is null while nobody is chosen among several", () => {
    expect(
      handedOverMainPresenter(
        { leadId: "ceum", coIds: ["upv"], mainId: null },
        "ceum",
      ),
    ).toBeNull();
    expect(
      handedOverMainPresenter(
        { leadId: "ceum", coIds: ["upv"], mainId: "uv" },
        "ceum",
      ),
    ).toBeNull();
  });

  it("is null for a user whose member does not present it", () => {
    expect(
      handedOverMainPresenter(
        { leadId: "ceum", coIds: ["upv"], mainId: "upv" },
        "uv",
      ),
    ).toBeNull();
    expect(
      handedOverMainPresenter(
        { leadId: "ceum", coIds: ["upv"], mainId: "upv" },
        null,
      ),
    ).toBeNull();
  });
});

describe("coPresentersDroppedWithoutLead", () => {
  it("names the co-presenters kept while nobody leads", () => {
    expect(
      coPresentersDroppedWithoutLead({
        leadId: null,
        coIds: ["upv", "uv", "upv"],
        mainId: null,
      }),
    ).toEqual(["upv", "uv"]);
  });

  it("drops nobody while someone leads or there are none", () => {
    expect(
      coPresentersDroppedWithoutLead({
        leadId: "ceum",
        coIds: ["upv"],
        mainId: "ceum",
      }),
    ).toEqual([]);
    expect(
      coPresentersDroppedWithoutLead({ leadId: null, coIds: [], mainId: null }),
    ).toEqual([]);
  });
});
