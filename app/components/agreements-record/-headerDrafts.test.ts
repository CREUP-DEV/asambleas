import { describe, expect, it } from "vitest";
import {
  headerNeedsSave,
  releaseHeaderDraft,
  syncHeaderDrafts,
} from "./-headerDrafts";

type Key = "secretary_name" | "secretary_title" | "city";

function fields(
  values: Partial<Record<Key, string | null>>,
): { key: Key; corrected: string | null }[] {
  return (["secretary_name", "secretary_title", "city"] as const).map(
    (key) => ({ key, corrected: values[key] ?? null }),
  );
}

describe("syncHeaderDrafts", () => {
  it("fills every draft the first time", () => {
    const drafts: Record<Key, string> = {
      secretary_name: "",
      secretary_title: "",
      city: "",
    };
    const synced: Partial<Record<Key, string>> = {};
    syncHeaderDrafts(drafts, synced, fields({ city: "Granada" }));
    expect(drafts).toEqual({
      secretary_name: "",
      secretary_title: "",
      city: "Granada",
    });
  });

  it("keeps what is being typed in another field when one is saved", () => {
    const drafts: Record<Key, string> = {
      secretary_name: "",
      secretary_title: "",
      city: "",
    };
    const synced: Partial<Record<Key, string>> = {};
    syncHeaderDrafts(drafts, synced, fields({}));
    drafts.secretary_title = "Secretaria";
    drafts.city = "Mála";
    // «Cargo» saved; «Ciudad» is still being typed.
    syncHeaderDrafts(drafts, synced, fields({ secretary_title: "Secretaria" }));
    expect(drafts.city).toBe("Mála");
    expect(drafts.secretary_title).toBe("Secretaria");
  });

  it("follows the server on a field nobody is editing", () => {
    const drafts: Record<Key, string> = {
      secretary_name: "",
      secretary_title: "",
      city: "",
    };
    const synced: Partial<Record<Key, string>> = {};
    syncHeaderDrafts(drafts, synced, fields({ city: "Granada" }));
    syncHeaderDrafts(drafts, synced, fields({ city: "Málaga" }));
    expect(drafts.city).toBe("Málaga");
    // A correction taken back empties it.
    syncHeaderDrafts(drafts, synced, fields({}));
    expect(drafts.city).toBe("");
  });

  it("keeps the words of a save that failed on the network or the server", () => {
    const drafts: Record<Key, string> = {
      secretary_name: "",
      secretary_title: "",
      city: "",
    };
    const synced: Partial<Record<Key, string>> = {};
    syncHeaderDrafts(drafts, synced, fields({ city: "Granada" }));
    drafts.city = "Málaga";
    // The page reads the record again: the old words come back.
    syncHeaderDrafts(drafts, synced, fields({ city: "Granada" }));
    expect(drafts.city).toBe("Málaga");
  });
});

describe("releaseHeaderDraft", () => {
  it("shows someone else's words after a save refused as stale", () => {
    const drafts: Record<Key, string> = {
      secretary_name: "",
      secretary_title: "",
      city: "",
    };
    const synced: Partial<Record<Key, string>> = {};
    syncHeaderDrafts(drafts, synced, fields({ city: "Granada" }));
    drafts.city = "Málaga";
    drafts.secretary_title = "Secre";
    // «Málaga» got a 409: another member saved «Sevilla» first.
    releaseHeaderDraft(drafts, synced, "city");
    syncHeaderDrafts(drafts, synced, fields({ city: "Sevilla" }));
    expect(drafts.city).toBe("Sevilla");
    // Another field being typed is left alone.
    expect(drafts.secretary_title).toBe("Secre");
    // The field then shows the correction, so leaving it sends nothing.
    expect(headerNeedsSave(drafts.city, "Sevilla", undefined)).toBe(false);
  });
});

describe("headerNeedsSave", () => {
  it("saves only words that differ from the correction", () => {
    expect(headerNeedsSave("Granada", "Granada", undefined)).toBe(false);
    expect(headerNeedsSave(" Granada ", "Granada", undefined)).toBe(false);
    expect(headerNeedsSave("Málaga", "Granada", undefined)).toBe(true);
    expect(headerNeedsSave("", null, undefined)).toBe(false);
    expect(headerNeedsSave("", "Granada", undefined)).toBe(true);
  });

  it("does not send the same words twice while they are on their way", () => {
    expect(headerNeedsSave("Málaga", "Granada", "Málaga")).toBe(false);
    expect(headerNeedsSave("Almería", "Granada", "Málaga")).toBe(true);
  });
});
