/**
 * Redacted authentication status (M2).
 *
 * The command surface needs to answer "why can't it consult?" without a second implementation of the
 * credential path, and any status output ends up in terminals and logs. So this module is the only
 * place that assembles an auth picture for display, and it is built out of masked/summarised fields by
 * construction: no field here returns a token, a refresh token, a cookie, or a full account id.
 * `SecretText` makes accidental leakage loud elsewhere; this module makes it structurally hard here.
 */

import { constants } from "node:fs";
import { access, stat } from "node:fs/promises";
import { join } from "node:path";

import type { AdviserProfile } from "../browser/profile.js";
import { piOpenAiIdentity } from "./openai-identity.js";
import {
  readPiOpenAiCredential,
  defaultPiAuthPath,
  type PiCredentialAccessor,
  type PiCredentialFailure,
} from "./pi-credential.js";
import { SESSION_MARKER_FILE } from "./login-flow.js";

/** How long an account identifier may be shown. Enough to recognise an account, not to reuse it. */
const ACCOUNT_ID_PREFIX_LENGTH = 8;

export interface AdviserStatusInput {
  /**
   * Read the credential from this file instead of asking Pi.
   *
   * Absent means "use Pi's own precedence", which is what the user sees: Pi resolves env-var and
   * store-backed credentials that a path in this extension would never find. Supplying a path is a
   * deliberate narrowing for tests and for pointing the status surface at another store, and it also
   * inverts the reader's preference order (see `readPiOpenAiCredential`).
   */
  readonly piAuthPath?: string;
  /** Loader for Pi's package, injectable so the `pi-api` path is testable without Pi installed. */
  readonly loadPiModule?: () => Promise<PiCredentialAccessor>;
}

export interface AdviserStatus {
  readonly piAuthFile: { readonly path: string; readonly readable: boolean; readonly mode?: string };
  readonly openAiSignIn:
    | {
        readonly present: true;
        readonly via: "pi-api" | "auth-file" | "injected";
        readonly accountIdPrefix: string;
        readonly emailMasked?: string;
        readonly planHint?: string;
        readonly expired: boolean;
      }
    | {
        readonly present: false;
        readonly reason: "missing-file" | "unparsable" | "no-openai-credential" | "api-key-only";
      };
  readonly profile: { readonly userDataDir: string; readonly exists: boolean; readonly everSignedInHere: boolean };
  readonly isolation: { readonly extensionOwned: true; readonly sharesDefaultChromeProfile: false };
}

/**
 * One redacted snapshot for the status surface.
 *
 * Never throws: an unreadable file or a half-created profile is a state the user needs told about, not
 * an error that stops the command.
 */
export async function adviserStatus(profile: AdviserProfile, input: AdviserStatusInput = {}): Promise<AdviserStatus> {
  const piAuthPath = input.piAuthPath ?? defaultPiAuthPath();
  // Only an explicit path narrows where the credential is read from. Passing the default path through
  // unconditionally would ask the file instead of Pi, and a credential Pi resolves from its own store
  // would then be reported as "no file, sign in" to a user who is already signed in.
  const credentialSource = {
    ...(input.piAuthPath === undefined ? {} : { authPath: input.piAuthPath }),
    ...(input.loadPiModule === undefined ? {} : { loadPiModule: input.loadPiModule }),
  };
  return {
    piAuthFile: await describeAuthFile(piAuthPath),
    openAiSignIn: await describeSignIn(credentialSource),
    profile: await describeProfile(profile),
    // Constant by design: if this ever became data-dependent it would mean the profile could stop being
    // ours, which is INV-11 rather than a status detail.
    isolation: { extensionOwned: true, sharesDefaultChromeProfile: false },
  };
}

async function describeAuthFile(path: string): Promise<AdviserStatus["piAuthFile"]> {
  try {
    const info = await stat(path);
    // The mode is reported because a group-readable auth file is a real problem worth surfacing.
    return { path, readable: true, mode: (info.mode & 0o777).toString(8) };
  } catch {
    return { path, readable: false };
  }
}

async function describeSignIn(source: {
  readonly authPath?: string;
  readonly loadPiModule?: () => Promise<PiCredentialAccessor>;
}): Promise<AdviserStatus["openAiSignIn"]> {
  const read = await readPiOpenAiCredential(source);
  if (!read.ok) return { present: false, reason: reasonFor(read.failure) };
  const credential = read.credential;
  if (credential === undefined) return { present: false, reason: "no-openai-credential" };
  if (credential.kind !== "oauth") {
    // An API key is transport, not an account: saying "signed in" here would imply an entitlement the
    // adviser may not have.
    return { present: false, reason: "api-key-only" };
  }
  const identity = piOpenAiIdentity(credential);
  return {
    present: true,
    via: read.via,
    accountIdPrefix: (identity.accountIdHint ?? "unknown").slice(0, ACCOUNT_ID_PREFIX_LENGTH),
    ...(identity.emailMasked === undefined ? {} : { emailMasked: identity.emailMasked }),
    ...(identity.planHint === undefined ? {} : { planHint: identity.planHint }),
    expired: identity.expired,
  };
}

function reasonFor(failure: PiCredentialFailure): Extract<AdviserStatus["openAiSignIn"], { present: false }>["reason"] {
  switch (failure) {
    case "auth-file-missing":
      return "missing-file";
    case "auth-file-unreadable":
    case "auth-file-malformed":
    case "credential-shape-unrecognised":
      // Grouped deliberately: the user's action is the same (re-run Pi sign-in), and distinguishing a
      // malformed file from an unrecognised shape would require quoting file contents.
      return "unparsable";
    case "pi-package-unavailable":
      // The reader falls back to the file, so this only surfaces when both paths failed.
      return "unparsable";
  }
}

async function describeProfile(profile: AdviserProfile): Promise<AdviserStatus["profile"]> {
  const exists = await pathExists(profile.userDataDir);
  return {
    userDataDir: profile.userDataDir,
    exists,
    // "A human signed in here once" is what lets the UI offer *repair sign-in* instead of *sign in*
    // after an expiry.
    everSignedInHere: exists && (await pathExists(join(profile.userDataDir, SESSION_MARKER_FILE))),
  };
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path, constants.F_OK);
    return true;
  } catch {
    return false;
  }
}

/**
 * Assert that a status object is safe to render.
 *
 * Cheap belt-and-braces for tests and for any future field that grows into holding something else: a
 * status that starts carrying credential material fails loudly here rather than quietly in a log line.
 */
export function assertStatusIsRedacted(status: AdviserStatus): void {
  const serialized = JSON.stringify(status);
  if (/"(token|refreshToken|accessToken|access_token|refresh_token|codeVerifier|cookies?)"/iu.test(serialized)) {
    throw new Error("status snapshot contains a credential-shaped field");
  }
  if (serialized.includes("eyJ")) {
    // "eyJ" is base64 for "{" and therefore the prefix of every JWT.
    throw new Error("status snapshot contains what looks like a JWT");
  }
}
