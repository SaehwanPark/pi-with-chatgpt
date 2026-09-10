/**
 * ChatGPT web capability verification (INV-08, INV-11).
 *
 * "Can we consult ChatGPT right now?" has more than two answers, and collapsing them is what makes an
 * adviser integration feel broken: an operator who hit a Cloudflare challenge needs "open the profile
 * and solve it", not "not logged in", and someone on a free plan needs "this plan is not supported",
 * not a retry loop. This module keeps the distinctions explicit.
 *
 * Layering: the *observations* come from the browser runtime (M3 owns Playwright). Everything here is
 * classification and persistence, so the state machine is reviewable and testable without a browser,
 * and M3 can only report things this vocabulary can express.
 */

import { readFile } from "node:fs/promises";

import type { AdviserNextAction } from "../protocol/adviser.js";
import { writePrivateStateFile } from "./state-storage.js";

/** What the browser runtime observed when it tried to reach ChatGPT. */
export type CapabilityObservation =
  | {
      readonly kind: "signed-in";
      readonly accountIdHint?: string;
      readonly emailHint?: string;
      readonly planHint?: string;
    }
  | { readonly kind: "signed-out" }
  /** Reached ChatGPT but a human gate is in the way. Never retried automatically (INV-11). */
  | { readonly kind: "human-verification"; readonly challenge: "cloudflare" | "captcha" | "login-checkpoint" }
  | { readonly kind: "rate-limited"; readonly retryAfterSeconds?: number }
  | { readonly kind: "plan-unsupported"; readonly planHint: string }
  | {
      readonly kind: "environment-unavailable";
      readonly reason: "browser-not-installed" | "no-display" | "profile-locked" | "network" | "runtime-error";
      readonly detail?: string;
    };

export type CapabilityStatus =
  | "ready"
  | "sign-in-required"
  | "manual-intervention-required"
  | "plan-unsupported"
  | "rate-limited"
  | "environment-unavailable";

export interface CapabilityRecord {
  readonly status: CapabilityStatus;
  /** ISO timestamp of the probe itself, not of this record's write. */
  readonly checkedAt: string;
  /** Human-facing explanation. Must never contain cookie, token, or page content. */
  readonly explanation: string;
  /** True when no automatic retry can help and a person has to act (INV-11). */
  readonly requiresManualIntervention: boolean;
  readonly nextAction: AdviserNextAction;
  readonly retryAfterSeconds?: number;
  /** Stable machine-readable reason, safe to log. */
  readonly reason?: string;
}

/**
 * Classify one probe.
 *
 * The mapping is deliberately total over {@link CapabilityObservation}: a new observation kind must not
 * be able to fall through to "ready", which is the one classification that would cause a consultation
 * to be dispatched into a failure.
 */
export function classifyCapabilityProbe(
  observation: CapabilityObservation,
  checkedAt: string = new Date().toISOString(),
): CapabilityRecord {
  switch (observation.kind) {
    case "signed-in":
      return {
        status: "ready",
        checkedAt,
        explanation: "ChatGPT is reachable and the adviser profile is signed in.",
        requiresManualIntervention: false,
        nextAction: "consult",
        ...(observation.planHint === undefined ? {} : { reason: `plan:${observation.planHint}` }),
      };
    case "signed-out":
      return {
        status: "sign-in-required",
        checkedAt,
        explanation: "The adviser profile can reach ChatGPT but is not signed in.",
        requiresManualIntervention: true,
        nextAction: "manual-login",
        reason: "signed-out",
      };
    case "human-verification":
      return {
        status: "manual-intervention-required",
        checkedAt,
        explanation: `ChatGPT presented a ${observation.challenge} challenge. Automating it is not allowed; it must be solved in the adviser window.`,
        requiresManualIntervention: true,
        nextAction: "solve-verification",
        reason: observation.challenge,
      };
    case "rate-limited":
      return {
        status: "rate-limited",
        checkedAt,
        explanation:
          observation.retryAfterSeconds === undefined
            ? "ChatGPT is rate limiting this account."
            : `ChatGPT is rate limiting this account; retry in about ${String(observation.retryAfterSeconds)}s.`,
        requiresManualIntervention: false,
        nextAction: "wait-for-rate-limit",
        ...(observation.retryAfterSeconds === undefined ? {} : { retryAfterSeconds: observation.retryAfterSeconds }),
        reason: "rate-limited",
      };
    case "plan-unsupported":
      return {
        status: "plan-unsupported",
        checkedAt,
        explanation: `Plan "${observation.planHint}" is not supported for adviser consultation.`,
        requiresManualIntervention: true,
        nextAction: "stop-unsupported-plan",
        reason: `plan:${observation.planHint}`,
      };
    case "environment-unavailable":
      return {
        status: "environment-unavailable",
        checkedAt,
        explanation: explanationForEnvironment(observation.reason),
        requiresManualIntervention: true,
        nextAction: "repair-environment",
        reason: observation.reason,
      };
    // `detail` is deliberately dropped: runtime error strings carry absolute paths and, rarely, URLs,
    // and this record is written to disk and shown in logs.
  }
}

function explanationForEnvironment(reason: "browser-not-installed" | "no-display" | "profile-locked" | "network" | "runtime-error"): string {
  switch (reason) {
    case "browser-not-installed":
      return "No usable Chrome or Chromium was found. Install one, or point the extension at a Chromium build.";
    case "no-display":
      return "No display is available and a visible adviser window is required. Run on a machine with a GUI, or use an existing signed-in profile through a remote desktop session.";
    case "profile-locked":
      return "The adviser browser profile is held by another running instance.";
    case "network":
      return "ChatGPT could not be reached over the network.";
    case "runtime-error":
      return "The browser runtime failed to start.";
  }
}

/** Ready means exactly one thing: a consultation may be dispatched. */
export function capabilityAllowsConsultation(record: CapabilityRecord | undefined): boolean {
  return record?.status === "ready";
}

export interface CapabilityStateFile {
  readonly schema: 1;
  readonly updatedAt: string;
  readonly record: CapabilityRecord;
}

export function serializeCapabilityState(record: CapabilityRecord): string {
  const file: CapabilityStateFile = { schema: 1, updatedAt: record.checkedAt, record };
  return JSON.stringify(file, null, 2);
}

export type CapabilityStateParse =
  | { readonly ok: true; readonly record: CapabilityRecord }
  | { readonly ok: false; readonly failure: "absent" | "malformed" | "unknown-schema" };

export function parseCapabilityState(text: string): CapabilityStateParse {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { ok: false, failure: "malformed" };
  }
  if (typeof parsed !== "object" || parsed === null) return { ok: false, failure: "malformed" };
  const file = parsed as Record<string, unknown>;
  if (file["schema"] !== 1) return { ok: false, failure: "unknown-schema" };
  const record = file["record"];
  if (typeof record !== "object" || record === null) return { ok: false, failure: "malformed" };
  const candidate = record as Record<string, unknown>;
  if (
    typeof candidate["status"] !== "string" ||
    typeof candidate["checkedAt"] !== "string" ||
    typeof candidate["explanation"] !== "string" ||
    typeof candidate["requiresManualIntervention"] !== "boolean" ||
    typeof candidate["nextAction"] !== "string"
  ) {
    return { ok: false, failure: "malformed" };
  }
  return { ok: true, record: record as CapabilityRecord };
}

/**
 * Persist the last verification result.
 *
 * The file is `0600` under the extension's own state root. Only the classification is stored: no
 * cookies, no page text, and no account identifiers beyond what {@link CapabilityRecord} already
 * carries, so the file is safe to attach to a bug report.
 */
export async function saveCapabilityState(
  path: string,
  record: CapabilityRecord,
): Promise<void> {
  await writePrivateStateFile(path, serializeCapabilityState(record));
}

export async function loadCapabilityState(path: string): Promise<CapabilityStateParse> {
  try {
    return parseCapabilityState(await readFile(path, { encoding: "utf8" }));
  } catch (cause: unknown) {
    if ((cause as { code?: string }).code === "ENOENT") return { ok: false, failure: "absent" };
    return { ok: false, failure: "malformed" };
  }
}


