import { describe, expect, it } from "vitest";
import {
  parseSeatingImageFileName,
  seatingImageDir,
  seatingImageFileName,
  seatingImagePath,
  seatingImageUrl,
} from "./files";

const ID = "a1b2c3d4e5f6g7h8i9j0k1l2";
const PLAN = "p1b2c3d4e5f6g7h8i9j0k1l2";

describe("seating image file names", () => {
  it("names a file by kind, row and version", () => {
    expect(
      seatingImageFileName({ kind: "photo", id: ID, version: "9f2c" }),
    ).toBe(`photo-${ID}-9f2c.webp`);
    expect(
      parseSeatingImageFileName(
        `logo-${ID}-3f2a0b1c2d3e4f5a6b7c8d9e0f1a2b3c.webp`,
      ),
    ).toEqual({
      kind: "logo",
      id: ID,
      version: "3f2a0b1c2d3e4f5a6b7c8d9e0f1a2b3c",
    });
  });

  it.each([
    "",
    `photo-${ID}-9f2c.png`,
    `photo-${ID}-9F2C.webp`,
    `avatar-${ID}-9f2c.webp`,
    `photo-${ID}.webp`,
    `photo-short-9f2c.webp`,
    `photo-${ID}-9f2c.webp.png`,
    `../photo-${ID}-9f2c.webp`,
    `photo-${ID}-..%2f.webp`,
    `photo-${ID}-${"a".repeat(65)}.webp`,
    `photo-${ID}-9f2c.webp\u0000`,
  ])("refuses anything else: %j", (name) => {
    expect(parseSeatingImageFileName(name)).toBeNull();
    expect(seatingImagePath(PLAN, name)).toBeNull();
  });

  it("refuses to make a name it would not serve", () => {
    expect(() =>
      seatingImageFileName({ kind: "photo", id: ID, version: "../x" }),
    ).toThrow(RangeError);
  });

  it("keeps every file inside its plan's folder", () => {
    const name = `photo-${ID}-9f2c.webp`;
    expect(seatingImagePath(PLAN, name)).toMatch(
      new RegExp(`seating[\\\\/]${PLAN}[\\\\/]${name}$`),
    );
    expect(() => seatingImageDir("../etc")).toThrow(RangeError);
  });

  it("serves it by the assembly's id", () => {
    expect(
      seatingImageUrl("cm0assemblyid000000000000", `logo-${ID}-1.webp`),
    ).toBe(
      `/api/assemblies/cm0assemblyid000000000000/seating/images/logo-${ID}-1.webp`,
    );
  });
});
