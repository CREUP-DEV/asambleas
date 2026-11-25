import { describe, expect, it } from "vitest";
import {
  avatarFetchUrl,
  avatarFileName,
  avatarUrl,
  avatarVersion,
  decideAvatar,
  isAllowedAvatarSource,
  parseAvatarFileName,
} from "./avatarFiles";

const USER = "AbCdEfGhIjKlMnOpQrStUvWxYz012345";
const GOOGLE =
  "https://lh3.googleusercontent.com/a/ACg8ocJx1Yv2abcDEF-ghiJKL_mno=s96-c";

describe("isAllowedAvatarSource", () => {
  it("takes Google's photo host over https", () => {
    expect(isAllowedAvatarSource(GOOGLE)).toBe(true);
  });

  it.each([
    ["no picture", null],
    ["empty", ""],
    ["not a URL", "lh3.googleusercontent.com/a/x"],
    ["http", "http://lh3.googleusercontent.com/a/x=s96-c"],
    ["another Google host", "https://lh4.googleusercontent.com/a/x"],
    ["a look-alike host", "https://lh3.googleusercontent.com.evil.test/a/x"],
    ["a subdomain", "https://x.lh3.googleusercontent.com/a/x"],
    ["credentials", "https://user:pw@lh3.googleusercontent.com/a/x"],
    ["a port", "https://lh3.googleusercontent.com:8443/a/x"],
    ["an address", "https://127.0.0.1/a/x"],
    ["a local file", "file:///etc/passwd"],
    ["too long", `https://lh3.googleusercontent.com/${"a".repeat(2100)}`],
  ])("refuses %s", (_label, source) => {
    expect(isAllowedAvatarSource(source)).toBe(false);
  });
});

describe("avatarFetchUrl", () => {
  it("asks Google for the stored size", () => {
    expect(avatarFetchUrl(GOOGLE)).toBe(
      "https://lh3.googleusercontent.com/a/ACg8ocJx1Yv2abcDEF-ghiJKL_mno=s192-c",
    );
    expect(avatarFetchUrl("https://lh3.googleusercontent.com/a/x=s64")).toBe(
      "https://lh3.googleusercontent.com/a/x=s192-c",
    );
  });

  it("fetches a source without a size as it is", () => {
    const plain = "https://lh3.googleusercontent.com/a/x";
    expect(avatarFetchUrl(plain)).toBe(plain);
  });
});

describe("file names", () => {
  it("name a photo by account and a hash of its source", () => {
    const version = avatarVersion(GOOGLE);
    expect(version).toMatch(/^[a-f0-9]{16}$/);
    expect(avatarVersion(GOOGLE)).toBe(version);
    expect(avatarVersion(`${GOOGLE}x`)).not.toBe(version);
    const name = avatarFileName(USER, version);
    expect(name).toBe(`${USER}-${version}.webp`);
    expect(parseAvatarFileName(name)).toEqual({ userId: USER, version });
  });

  it("never build a path out of anything else", () => {
    expect(() => avatarFileName("../etc", "0123456789abcdef")).toThrow();
    expect(() => avatarFileName(USER, "nothex")).toThrow();
    // Only an account id as better-auth makes it: 32 letters and digits.
    expect(() => avatarFileName(USER.slice(1), "0123456789abcdef")).toThrow();
    for (const name of [
      null,
      "",
      `${USER}x-0123456789abcdef.webp`,
      `${USER}-0123456789abcdef.png`,
      `../${USER}-0123456789abcdef.webp`,
      `${USER}-0123456789ABCDEF.webp`,
      `${USER}-0123456789abcdef.webp/x`,
    ]) {
      expect(parseAvatarFileName(name)).toBeNull();
    }
  });

  it("give the URL the DTOs send, or null", () => {
    const name = `${USER}-0123456789abcdef.webp`;
    expect(avatarUrl(name)).toBe(`/api/uploads/avatars/${name}`);
    expect(avatarUrl(null)).toBeNull();
    expect(avatarUrl("https://lh3.googleusercontent.com/a/x")).toBeNull();
  });
});

describe("decideAvatar", () => {
  const account = (image: string | null, accessRevoked = false) => ({
    image,
    accessRevoked,
  });

  it("fetches a picture not stored yet, or one that changed", () => {
    expect(decideAvatar(account(GOOGLE), null)).toBe("fetch");
    expect(
      decideAvatar(account(GOOGLE), {
        sourceUrl: "https://lh3.googleusercontent.com/a/old=s96-c",
      }),
    ).toBe("fetch");
  });

  it("leaves a source already fetched, with or without a file", () => {
    expect(decideAvatar(account(GOOGLE), { sourceUrl: GOOGLE })).toBe("none");
  });

  it("drops the photo of an account with no picture to show", () => {
    expect(decideAvatar(account(null), { sourceUrl: GOOGLE })).toBe("drop");
    expect(
      decideAvatar(account("https://example.test/me.png"), {
        sourceUrl: GOOGLE,
      }),
    ).toBe("drop");
    expect(decideAvatar(account(null), null)).toBe("none");
  });

  it("never fetches for an account without access, and drops its photo", () => {
    expect(decideAvatar(account(GOOGLE, true), null)).toBe("none");
    expect(decideAvatar(account(GOOGLE, true), { sourceUrl: GOOGLE })).toBe(
      "drop",
    );
  });
});
