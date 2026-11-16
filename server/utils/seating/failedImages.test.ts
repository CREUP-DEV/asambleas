import { afterEach, describe, expect, it } from "vitest";
import {
  FAILED_SEATING_IMAGES_LIMIT,
  forgetFailedSeatingImages,
  rememberFailedSeatingImage,
  seatingImageKey,
  withoutFailedSeatingImages,
} from "./failedImages";

const logo = { kind: "logo" as const, id: "g1", version: "3f2a" };
const photo = { kind: "photo" as const, id: "p1", version: "9f2c" };

afterEach(() => forgetFailedSeatingImages());

describe("failed seating images", () => {
  it("keys an image by kind, row and version, as the queue does", () => {
    expect(seatingImageKey(logo)).toBe("logo:g1:3f2a");
  });

  it("leaves out an image that failed at the same version only", () => {
    rememberFailedSeatingImage(logo);
    const next = { ...logo, version: "4b1c" };
    const sameIdAsPhoto = { ...photo, id: "g1", version: "3f2a" };
    expect(
      withoutFailedSeatingImages([logo, photo, next, sameIdAsPhoto]),
    ).toEqual([photo, next, sameIdAsPhoto]);
  });

  it("keeps whatever the caller passes along with the key", () => {
    const job = { ...photo, planId: "plan", intranetId: 501 };
    expect(withoutFailedSeatingImages([job])).toEqual([job]);
  });

  it("forgets the oldest failure past its limit", () => {
    for (let index = 0; index <= FAILED_SEATING_IMAGES_LIMIT; index += 1) {
      rememberFailedSeatingImage({ ...logo, id: `g${index}` });
    }
    const first = { ...logo, id: "g0" };
    const last = { ...logo, id: `g${FAILED_SEATING_IMAGES_LIMIT}` };
    expect(withoutFailedSeatingImages([first, last])).toEqual([first]);
  });

  it("keeps a failure that comes again as the most recent", () => {
    rememberFailedSeatingImage({ ...logo, id: "g0" });
    for (let index = 1; index < FAILED_SEATING_IMAGES_LIMIT; index += 1) {
      rememberFailedSeatingImage({ ...logo, id: `g${index}` });
    }
    rememberFailedSeatingImage({ ...logo, id: "g0" });
    rememberFailedSeatingImage({ ...logo, id: "new" });
    expect(
      withoutFailedSeatingImages([
        { ...logo, id: "g0" },
        { ...logo, id: "g1" },
      ]),
    ).toEqual([{ ...logo, id: "g1" }]);
  });
});
