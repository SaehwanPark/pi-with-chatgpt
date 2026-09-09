import { describe, expect, it } from "vitest";

import {
  createAdviserProfile,
  isLikelyUserBrowserProfile,
  ProfileOwnershipError,
} from "./profile.js";

const STATE_ROOT = "/home/dev/.local/share/pi-with-chatgpt";

describe("extension-owned adviser profile (INV-11)", () => {
  it("accepts a profile inside the extension state root", () => {
    const profile = createAdviserProfile({
      stateRoot: STATE_ROOT,
      userDataDir: `${STATE_ROOT}/browser`,
    });
    expect(profile).toEqual({
      kind: "extension-owned",
      profileId: "chatgpt-adviser",
      userDataDir: `${STATE_ROOT}/browser`,
      stateRoot: STATE_ROOT,
    });
  });

  it.each([
    "/home/dev/.config/google-chrome",
    "/home/dev/.config/google-chrome/Default",
    "/home/dev/.config/chromium/Default",
    "/home/dev/Library/Application Support/Google/Chrome/Profile 1",
    "C:\\Users\\dev\\AppData\\Local\\Google\\Chrome\\User Data",
  ])("refuses the user's own browser profile %s", (userDataDir) => {
    expect(isLikelyUserBrowserProfile(userDataDir)).toBe(true);
    expect(() => createAdviserProfile({ stateRoot: STATE_ROOT, userDataDir })).toThrow(ProfileOwnershipError);
  });

  it("refuses a profile outside the extension state root", () => {
    expect(() => createAdviserProfile({ stateRoot: STATE_ROOT, userDataDir: "/tmp/ad-hoc-profile" })).toThrow(
      ProfileOwnershipError,
    );
  });

  it("refuses empty and filesystem-root paths", () => {
    expect(() => createAdviserProfile({ stateRoot: STATE_ROOT, userDataDir: "  " })).toThrow(ProfileOwnershipError);
    expect(() => createAdviserProfile({ stateRoot: STATE_ROOT, userDataDir: "/" })).toThrow(ProfileOwnershipError);
    expect(() => createAdviserProfile({ stateRoot: "", userDataDir: `${STATE_ROOT}/browser` })).toThrow(
      ProfileOwnershipError,
    );
  });

  it("does not treat the extension's own paths as a user profile", () => {
    expect(isLikelyUserBrowserProfile(`${STATE_ROOT}/browser`)).toBe(false);
  });
});
