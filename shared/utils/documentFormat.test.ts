import { describe, expect, it } from "vitest";
import { DOCUMENT_KIND_DEFAULTS, DOCUMENT_KINDS } from "../constants/domain";
import {
  fileFormatRefused,
  kindAcceptsFile,
  mayUseFileFormat,
} from "./documentFormat";

describe("kindAcceptsFile", () => {
  it("follows the amendable default of each kind", () => {
    for (const kind of DOCUMENT_KINDS) {
      expect(kindAcceptsFile(kind)).toBe(
        !DOCUMENT_KIND_DEFAULTS[kind].amendable,
      );
    }
    expect(kindAcceptsFile("resolution")).toBe(false);
    expect(kindAcceptsFile("report")).toBe(true);
  });
});

describe("mayUseFileFormat", () => {
  it("lets managers use a PDF for every kind", () => {
    expect(DOCUMENT_KINDS.every((kind) => mayUseFileFormat(kind, true))).toBe(
      true,
    );
  });

  it("lets members use a PDF only where no amendments are taken", () => {
    expect(mayUseFileFormat("positioning", false)).toBe(false);
    expect(mayUseFileFormat("report", false)).toBe(true);
  });
});

describe("fileFormatRefused", () => {
  it("refuses a member creating a PDF of an amendable kind", () => {
    expect(
      fileFormatRefused({
        manager: false,
        current: null,
        next: { kind: "resolution", format: "file" },
      }),
    ).toBe(true);
  });

  it("accepts a member's text, or a PDF of a kind with no amendments", () => {
    expect(
      fileFormatRefused({
        manager: false,
        current: null,
        next: { kind: "resolution", format: "structured" },
      }),
    ).toBe(false);
    expect(
      fileFormatRefused({
        manager: false,
        current: null,
        next: { kind: "report", format: "file" },
      }),
    ).toBe(false);
  });

  it("never refuses a manager", () => {
    expect(
      fileFormatRefused({
        manager: true,
        current: null,
        next: { kind: "resolution", format: "file" },
      }),
    ).toBe(false);
    expect(
      fileFormatRefused({
        manager: true,
        current: { kind: "resolution", format: "structured" },
        next: { kind: "resolution", format: "file" },
      }),
    ).toBe(false);
  });

  it("refuses a member switching an amendable kind to PDF", () => {
    expect(
      fileFormatRefused({
        manager: false,
        current: { kind: "positioning", format: "structured" },
        next: { kind: "positioning", format: "file" },
      }),
    ).toBe(true);
  });

  it("refuses a member moving a PDF to an amendable kind", () => {
    expect(
      fileFormatRefused({
        manager: false,
        current: { kind: "report", format: "file" },
        next: { kind: "resolution", format: "file" },
      }),
    ).toBe(true);
  });

  it("leaves alone a PDF the Secretaría stored for an amendable kind", () => {
    const stored = { kind: "resolution", format: "file" } as const;
    expect(
      fileFormatRefused({ manager: false, current: stored, next: stored }),
    ).toBe(false);
    expect(
      fileFormatRefused({
        manager: false,
        current: stored,
        next: { kind: "resolution", format: "structured" },
      }),
    ).toBe(false);
  });
});
