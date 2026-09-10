/**
 * Manual sign-in flow for the isolated adviser profile (M2).
 *
 * The extension cannot sign a user into ChatGPT: the credentials, the CAPTCHA, the 2FA prompt and the
 * consent screens belong to a human (INV-09). So this flow is deliberately *inert* — it opens a window,
 * watches for the session to appear, and stops. That limitation is structural rather than a convention:
 * {@link AdviserLoginPort} has no click, type, navigate, or solve method, so nothing downstream can
 * automate the login even by accident.
 *
 * The browser runtime implements the port in M3; everything here is the control logic around it.
 */

import type { AccountIdentityHint } from "./identity.js";
import type { AdviserProfile } from "../browser/profile.js";
import { writePrivateStateFile } from "../browser/state-storage.js";
import { join } from "node:path";

/**
 * Marker recording that this profile has completed at least one interactive sign-in.
 *
 * It exists so "no session right now" can be told apart from "never signed in here": the first is an
 * expired session worth repairing, the second is a fresh profile. The file holds no session material.
 */
export const SESSION_MARKER_FILE = "SESSION-ESTABLISHED";

export type SessionObservation =
  | { readonly kind: "signed-in"; readonly identity?: AccountIdentityHint }
  | { readonly kind: "signed-out" }
  /** A human gate. The flow stops immediately: polling through it would be automating it. */
  | { readonly kind: "human-verification"; readonly challenge: "cloudflare" | "captcha" | "login-checkpoint" }
  | { readonly kind: "unreachable"; readonly reason: "network" | "browser-failed" | "profile-locked" };

/**
 * The only browser capabilities the login flow is allowed to need.
 *
 * Deliberately narrow and deliberately free of page interaction: `open` shows a window to a human,
 * `observe` reads whether a session exists, `seal` lets the runtime flush storage after success.
 */
export interface AdviserLoginPort {
  readonly openAdviserWindow: (profile: AdviserProfile) => Promise<void>;
  readonly observeSession: (profile: AdviserProfile) => Promise<SessionObservation>;
  readonly sealSession: (profile: AdviserProfile) => Promise<void>;
}

export type ManualLoginOutcome =
  | {
      readonly ok: true;
      readonly identity?: AccountIdentityHint;
      /** Observations seen before success; tells a slow login from a login that needed a challenge. */
      readonly attempts: number;
      readonly markerWritten: boolean;
    }
  | {
      readonly ok: false;
      readonly failure: "timed-out" | "human-verification" | "unreachable" | "window-failed";
      readonly attempts: number;
      readonly detail: string;
      /** True when waiting longer cannot help (INV-09: stop and ask, do not spin). */
      readonly retryMayHelp: boolean;
    };

export interface ManualLoginOptions {
  readonly timeoutMs?: number;
  readonly pollIntervalMs?: number;
  /** Injectable clock and sleeper so no test waits in real time. */
  readonly now?: () => number;
  readonly sleep?: (ms: number) => Promise<void>;
  /** Overridable so tests need no real filesystem. */
  readonly writeMarker?: (path: string, content: string) => Promise<void>;
}

const DEFAULT_TIMEOUT_MS = 5 * 60_000;
const DEFAULT_POLL_MS = 1_500;

/**
 * Open the adviser window and wait for the human to finish signing in.
 *
 * A challenge is terminal rather than retried: continuing to observe while a CAPTCHA is on screen is
 * how an integration ends up automating a human gate by omission. The caller is expected to tell the
 * user what to do, then start a fresh run.
 */
export async function runManualLogin(
  profile: AdviserProfile,
  port: AdviserLoginPort,
  options: ManualLoginOptions = {},
): Promise<ManualLoginOutcome> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const pollIntervalMs = options.pollIntervalMs ?? DEFAULT_POLL_MS;
  const now = options.now ?? Date.now;
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));

  try {
    await port.openAdviserWindow(profile);
  } catch {
    return {
      ok: false,
      failure: "window-failed",
      attempts: 0,
      detail: "The adviser browser window could not be opened.",
      retryMayHelp: true,
    };
  }

  const deadline = now() + timeoutMs;
  let attempts = 0;
  for (;;) {
    attempts += 1;
    const observation = await port.observeSession(profile);
    switch (observation.kind) {
      case "signed-in": {
        // Seal before reporting success: an unflushed profile can come back logged out on next launch,
        // which is the "why is it asking again" bug this whole path exists to prevent.
        await port.sealSession(profile);
        const markerWritten = await writeSessionMarker(profile, options.writeMarker);
        return {
          ok: true,
          ...(observation.identity === undefined ? {} : { identity: observation.identity }),
          attempts,
          markerWritten,
        };
      }
      case "human-verification":
        return {
          ok: false,
          failure: "human-verification",
          attempts,
          detail: `ChatGPT presented a ${observation.challenge} challenge; finish it in the adviser window and try again.`,
          retryMayHelp: false,
        };
      case "unreachable":
        return {
          ok: false,
          failure: "unreachable",
          attempts,
          detail: `ChatGPT could not be reached during sign-in (${observation.reason}).`,
          retryMayHelp: observation.reason !== "profile-locked",
        };
      case "signed-out":
        if (now() >= deadline) {
          return {
            ok: false,
            failure: "timed-out",
            attempts,
            detail: "No ChatGPT session appeared before the sign-in window closed.",
            retryMayHelp: true,
          };
        }
        await sleep(pollIntervalMs);
    }
  }
}

/** Whether this profile has ever completed a sign-in. */
export function sessionMarkerPath(profile: AdviserProfile): string {
  return join(profile.userDataDir, SESSION_MARKER_FILE);
}

async function writeSessionMarker(
  profile: AdviserProfile,
  writeMarker: ((path: string, content: string) => Promise<void>) | undefined,
): Promise<boolean> {
  try {
    await (writeMarker ?? writePrivateStateFile)(
      sessionMarkerPath(profile),
      `Sign-in completed at ${new Date().toISOString()}. This file proves only that a sign-in happened, not that a session is currently valid.\n`,
    );
    return true;
  } catch {
    // A profile that signed in but could not record the marker is still signed in; the marker is an
    // optimisation for better messaging, never a precondition for using the session.
    return false;
  }
}

/**
 * Whether the UI should offer an interactive sign-in.
 *
 * "Never signed in here" and "session expired" both qualify; a pending human challenge does not, because
 * the user still has an unfinished action in the window that is already open.
 */
export function shouldOfferInteractiveLogin(input: {
  readonly everSignedInHere: boolean;
  readonly sessionObserved: boolean;
  readonly humanVerificationPending: boolean;
}): boolean {
  if (input.sessionObserved) return false;
  return !input.humanVerificationPending;
}
