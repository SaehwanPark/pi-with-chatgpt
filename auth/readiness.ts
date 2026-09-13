/**
 * Production adviser-auth resolution.
 *
 * `resolveAdviserAuth` is intentionally pure, but until now only its unit tests supplied the facts it
 * consumes. This adapter is the narrow effectful boundary used by commands and tools: it reads Pi's
 * credential through the supported Pi accessor, reads only the extension-owned profile marker, and
 * accepts a fresh observation from the isolated browser. It never treats Pi OAuth as proof that the
 * browser is signed in and never manufactures a browser identity when the page did not expose one.
 */

import { access, constants } from "node:fs/promises";

import type { AdviserProfile } from "../browser/profile.js";
import {
  classifyCapabilityProbe,
  type CapabilityObservation,
  type CapabilityRecord,
} from "../browser/capability.js";
import type { SessionObservation } from "./login-flow.js";
import { sessionMarkerPath } from "./login-flow.js";
import {
  resolveAdviserAuth,
  type AdviserAuthDecision,
} from "./adviser-auth.js";
import { piApiKeyIdentity, piOpenAiIdentity } from "./openai-identity.js";
import {
  readPiOpenAiCredential,
  type PiCredentialReaderOptions,
} from "./pi-credential.js";
import type { AccountMismatchDecision } from "./identity.js";

export type { AdviserAuthDecision } from "./adviser-auth.js";

export interface LiveAdviserAuthInput {
  readonly profile: AdviserProfile;
  /** Fresh observation from the extension-owned browser. Omission is explicitly unverified. */
  readonly browserSession?: SessionObservation;
  /** A choice can only come from a UI that showed and bound this exact account pair. */
  readonly mismatchDecision?: AccountMismatchDecision;
  /** Injectable only for tests and alternate Pi hosts; the production default is Pi's own accessor. */
  readonly credential?: PiCredentialReaderOptions;
  /** Optional cached capability record; a fresh browser observation is preferred when supplied. */
  readonly capability?: CapabilityRecord;
  /** Whether a closed Chromium profile is available for the human-gated import path. */
  readonly chromeImportAvailable?: boolean;
  /** Production dispatches require the browser to expose a comparable account identity. */
  readonly requireBrowserIdentity?: boolean;
}

/**
 * Resolve the complete auth/readiness state used at a production dispatch boundary.
 *
 * A signed-in observation with no account id remains an identity `unknown` result because asserting that
 * it belongs to Pi would be an account switch by assumption. The strict production default upgrades
 * that unknown observation to `browser-identity-unverified`; only an explicitly non-production caller
 * may opt out with `requireBrowserIdentity: false`. A demonstrated mismatch is returned as
 * `review-account-mismatch`, which is the fail-closed branch callers must refuse to dispatch.
 */
export async function resolveLiveAdviserAuth(input: LiveAdviserAuthInput): Promise<AdviserAuthDecision> {
  const read = await readPiOpenAiCredential(input.credential);
  const credential = read.ok ? read.credential : undefined;
  const piCredentialPresent = credential !== undefined;
  const piCredentialIsApiKey = credential?.kind === "api-key";
  const oauthIdentity = credential?.kind === "oauth" ? piOpenAiIdentity(credential) : undefined;
  const piIdentity = oauthIdentity ?? (credential?.kind === "api-key" ? piApiKeyIdentity() : undefined);

  const profilePresent = await pathExists(input.profile.userDataDir);
  const profileInitialized = profilePresent && (await pathExists(sessionMarkerPath(input.profile)));
  const capability = input.capability ?? capabilityForSession(input.browserSession);

  const decision = resolveAdviserAuth({
    piCredentialPresent,
    piCredentialIsApiKey,
    piCredentialExpired: oauthIdentity?.expired ?? false,
    piIdentity,
    profilePresent,
    profileInitialized,
    chromeImportAvailable: input.chromeImportAvailable ?? false,
    capability,
    browserIdentity: input.browserSession?.kind === "signed-in" ? input.browserSession.identity : undefined,
    mismatchDecision: input.mismatchDecision,
  });
  if (
    (input.requireBrowserIdentity ?? true) &&
    input.browserSession?.kind === "signed-in" &&
    input.browserSession.identity === undefined &&
    decision.action === "consult"
  ) {
    return {
      ...decision,
      state: "browser-identity-unverified",
      action: "review-account-mismatch",
      explanation: "The isolated ChatGPT browser account could not be identified; consultation is refused until it is verified.",
      requiresManualIntervention: true,
      identityComparison: "unknown",
      warnings: [...decision.warnings, "Browser account identity is unavailable; no account switch is permitted."],
    };
  }
  return decision;
}

/** The only dispatch predicate callers need; unresolved account mismatches never return `consult`. */
export function authDecisionAllowsConsultation(decision: AdviserAuthDecision): boolean {
  return decision.action === "consult";
}

function capabilityForSession(session: SessionObservation | undefined): CapabilityRecord | undefined {
  if (session === undefined) return undefined;
  const observation = capabilityObservationForSession(session);
  return classifyCapabilityProbe(observation);
}

function capabilityObservationForSession(session: SessionObservation): CapabilityObservation {
  switch (session.kind) {
    case "signed-in":
      return {
        kind: "signed-in",
        ...(session.identity?.accountIdHint === undefined ? {} : { accountIdHint: session.identity.accountIdHint }),
        ...(session.identity?.emailMasked === undefined ? {} : { emailHint: session.identity.emailMasked }),
        ...(session.identity?.planHint === undefined ? {} : { planHint: session.identity.planHint }),
      };
    case "signed-out":
      return { kind: "signed-out" };
    case "human-verification":
      return { kind: "human-verification", challenge: session.challenge };
    case "unreachable":
      return {
        kind: "environment-unavailable",
        reason:
          session.reason === "profile-locked"
            ? "profile-locked"
            : session.reason === "browser-failed"
              ? "runtime-error"
              : "network",
      };
  }
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path, constants.F_OK);
    return true;
  } catch {
    return false;
  }
}
