/**
 * Isolated, extension-owned adviser browser profile (INV-11).
 *
 * The adviser runtime must never touch the user's active browser: doing so would automate a profile
 * the user is working in, mix adviser cookies with personal ones, and create conflicts with other
 * Pi extensions. The rule is enforced structurally — an `AdviserProfile` can only be produced by
 * `createAdviserProfile`, which refuses any directory that is not inside the extension's own state
 * root and any directory that looks like a Chromium-family default profile.
 */

export const ADVISER_PROFILE_ID = "chatgpt-adviser" as const;

export interface AdviserProfile {
  readonly kind: "extension-owned";
  readonly profileId: typeof ADVISER_PROFILE_ID;
  /** Absolute path to a `--user-data-dir` owned by this extension. */
  readonly userDataDir: string;
  readonly stateRoot: string;
}

export class ProfileOwnershipError extends Error {
  readonly code: ProfileOwnershipRejection;

  constructor(code: ProfileOwnershipRejection, detail: string) {
    super(`Refusing to use "${detail}" as the adviser browser profile: ${code}.`);
    this.name = "ProfileOwnershipError";
    this.code = code;
  }
}

export type ProfileOwnershipRejection =
  | "empty-path"
  | "outside-state-root"
  | "state-root-not-extension-owned"
  | "looks-like-user-browser-profile"
  | "filesystem-root";

/**
 * Path segments that mark a browser directory as the user's own profile store rather than something
 * this extension created. Compared as whole path segments, case- and separator-insensitively, so the
 * Linux, macOS, and Windows spellings all land in the same net.
 */
const USER_PROFILE_MARKERS = [
  ".config/google-chrome",
  ".config/chromium",
  ".config/chromium-browser",
  ".config/bravesoftware",
  ".config/microsoft-edge",
  ".mozilla/firefox",
  "library/application support/google/chrome",
  "library/application support/chromium",
  "appdata/local/google/chrome",
  "appdata/local/chromium",
  "appdata/roaming/microsoft/edge",
  "user data",
] as const;

export function isLikelyUserBrowserProfile(candidatePath: string): boolean {
  const normalized = `/${candidatePath.replace(/\\/gu, "/").toLowerCase().replace(/^\/+/u, "").replace(/\/+$/u, "")}/`;
  return USER_PROFILE_MARKERS.some((marker) => normalized.includes(`/${marker}/`));
}

export interface AdviserProfileRequest {
  readonly stateRoot: string;
  readonly userDataDir: string;
}

export function createAdviserProfile(request: AdviserProfileRequest): AdviserProfile {
  const stateRoot = request.stateRoot.trim();
  const userDataDir = request.userDataDir.trim();

  if (stateRoot.length === 0) throw new ProfileOwnershipError("state-root-not-extension-owned", request.stateRoot);
  if (userDataDir.length === 0) throw new ProfileOwnershipError("empty-path", request.userDataDir);
  if (userDataDir === "/" || /^[a-z]:[\\/]$/iu.test(userDataDir)) throw new ProfileOwnershipError("filesystem-root", userDataDir);
  if (isLikelyUserBrowserProfile(userDataDir) || isLikelyUserBrowserProfile(stateRoot)) {
    throw new ProfileOwnershipError("looks-like-user-browser-profile", userDataDir);
  }
  if (!isUnder(stateRoot, userDataDir)) throw new ProfileOwnershipError("outside-state-root", userDataDir);

  return { kind: "extension-owned", profileId: ADVISER_PROFILE_ID, userDataDir, stateRoot };
}

/** Path containment without importing `path` semantics we would have to re-derive for win32. */
function isUnder(root: string, candidate: string): boolean {
  const normalize = (value: string): string => value.replace(/\\/gu, "/").replace(/\/+$/u, "");
  const normalizedRoot = normalize(root);
  const normalizedCandidate = normalize(candidate);
  return (
    normalizedCandidate === normalizedRoot ||
    normalizedCandidate.startsWith(`${normalizedRoot}/`)
  );
}
