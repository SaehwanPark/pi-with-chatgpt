/**
 * Authoritative capability gate for consultation dispatch (INV-02, INV-04, INV-08, INV-11).
 *
 * The checklist is useful as a status projection, but a checklist assembled by a caller is not a
 * security boundary. This gate is the one production-facing seam that turns live browser observations
 * and the already-resolved GitHub anchor into a dispatch decision. Callers must ask it immediately
 * before submitting a consultation; a missing connector verifier is deliberately treated as
 * `unverified`, never as a successful no-op.
 *
 * The connector probe is a narrow, extension-owned capability. It receives only the canonical repository
 * key and full checkpoint SHA, and returns a closed outcome. It cannot accept a URL, selector, page,
 * script, or arbitrary transport, preserving the GitHub-only V1 boundary.
 */

import type { AdviserBrowserRuntime, SurfaceState } from "./runtime-types.js";
import type { ConsultationAnchor } from "../protocol/checkpoint.js";
import type { BrowserTransactionScheduler } from "./transaction.js";
import {
  evaluateConsultationPrerequisites,
  type CapabilityChecklist,
  type PrerequisiteEvaluation,
  type VerificationOutcome,
  type VerificationResult,
} from "./capability-checks.js";
import { DEFAULT_MODEL_PREFERENCE, resolveModelPreference } from "./model-selection.js";

/** The only connector-specific observation this gate accepts. */
export type GitHubConnectorProbe = (input: {
  readonly repository: ConsultationAnchor["repository"];
  readonly checkpointSha: ConsultationAnchor["resolvedCommit"];
}) => Promise<VerificationOutcome>;

export interface ConsultationCapabilityRequest {
  readonly anchor: ConsultationAnchor;
  /** Ranked, user-selected model ids. An empty list is refused rather than guessed. */
  readonly modelPreference?: readonly string[];
}

export type ConsultationCapabilityResult =
  | {
      readonly ok: true;
      readonly checklist: CapabilityChecklist;
      readonly evaluation: Extract<PrerequisiteEvaluation, { readonly ok: true }>;
      readonly modelId: string;
      readonly degraded: boolean;
      readonly modelReason?: string;
    }
  | {
      readonly ok: false;
      readonly checklist: CapabilityChecklist;
      readonly evaluation: Extract<PrerequisiteEvaluation, { readonly ok: false }>;
      /** Safe machine-readable summary; never includes page text or a local path. */
      readonly explanation: string;
    };

export interface ConsultationCapabilityGate {
  /**
   * Verify all four V1 prerequisites. A successful result is safe to use for one dispatch only.
   * Every production call performs a fresh probe; authorization changes must be visible on the next
   * dispatch rather than hidden behind a stale positive result.
   */
  ensureConsultationCapability(
    request: ConsultationCapabilityRequest,
    options?: { readonly transactionHeld?: boolean },
  ): Promise<ConsultationCapabilityResult>;
  /** Compatibility hook for callers that want to force a fresh check; checks are always fresh already. */
  invalidate(): void;
}

export interface ConsultationCapabilityGateOptions {
  readonly runtime: Pick<AdviserBrowserRuntime, "probeSurface" | "discoverModels">;
  /**
   * Verifies the ChatGPT account can use its GitHub connector for the exact repository/checkpoint. If
   * omitted, the gate remains safe by returning `unverified`.
   */
  readonly githubConnectorProbe?: GitHubConnectorProbe;
  /** Serialize probes with the complete browser transaction owned by the process-wide adviser tab. */
  readonly browserTransaction?: BrowserTransactionScheduler;
}

/**
 * Build the production gate. The gate is exported through the factory so tests and composition roots
 * can depend on the narrow interface without reaching into probe implementation details.
 */
export function createConsultationCapabilityGate(
  options: ConsultationCapabilityGateOptions,
): ConsultationCapabilityGate {
  const ensure = async (request: ConsultationCapabilityRequest): Promise<ConsultationCapabilityResult> => {
    const preference = request.modelPreference ?? DEFAULT_MODEL_PREFERENCE;
    return await probeCapabilities(options, request, preference, () => new Date());
  };

  return {
    async ensureConsultationCapability(request, ensureOptions = {}): Promise<ConsultationCapabilityResult> {
      // Capability probes navigate the same tracked tab as Project/conversation dispatch. Keep the
      // entire probe inside the process-wide transaction so another workspace cannot move the tab between
      // access, model, connector, and target checks. The production gate deliberately re-probes every
      // request: authorization can be revoked or an account/model can change between consultations.
      if (options.browserTransaction && ensureOptions.transactionHeld !== true) {
        return await options.browserTransaction.runExclusive(() => ensure(request));
      }
      return await ensure(request);
    },
    invalidate(): void {
      // Kept as a narrow compatibility hook for callers that previously invalidated the positive cache.
      // There is no cache now: every request is a fresh, serialized observation.
    },
  };
}

async function probeCapabilities(
  options: ConsultationCapabilityGateOptions,
  request: ConsultationCapabilityRequest,
  preference: readonly string[],
  now: () => Date,
): Promise<ConsultationCapabilityResult> {
  const checkedAt = now().toISOString();
  const results: VerificationResult[] = [];

  const access = await probeChatGptAccess(options.runtime);
  results.push({ item: "chatgpt-access", outcome: access });

  const model = await probeModel(options.runtime, access, preference);
  results.push(model.result);

  const connector = await probeConnector(options.githubConnectorProbe, request);
  results.push({ item: "github-connector", outcome: connector });

  const targetRepository: VerificationOutcome = request.anchor.remoteAvailability.status === "available"
    ? "verified"
    : "unavailable";
  results.push({ item: "target-repository", outcome: targetRepository });

  const checklist: CapabilityChecklist = { results, checkedAt };
  const evaluation = evaluateConsultationPrerequisites(checklist);
  if (!evaluation.ok || model.modelId === undefined) {
    const blocking = !evaluation.ok
      ? evaluation.blocking.map((entry) => `${entry.item}:${entry.outcome}`).join(", ")
      : "adviser-model:unavailable";
    return {
      ok: false,
      checklist,
      evaluation: evaluation.ok
        ? {
            ok: false,
            blocking: [{ item: "adviser-model", outcome: "unavailable" }],
          }
        : evaluation,
      explanation: `Consultation capability check failed (${blocking}).`,
    };
  }

  return {
    ok: true,
    checklist,
    evaluation,
    modelId: model.modelId,
    degraded: model.degraded,
    ...(model.reason === undefined ? {} : { modelReason: model.reason }),
  };
}

async function probeChatGptAccess(
  runtime: Pick<AdviserBrowserRuntime, "probeSurface">,
): Promise<VerificationOutcome> {
  try {
    const observation = await runtime.probeSurface();
    return isSignedInSurface(observation.state) ? "verified" : "unavailable";
  } catch {
    return "unavailable";
  }
}

function isSignedInSurface(state: SurfaceState): boolean {
  return state === "conversation-ready" || state === "generating" || state === "response-complete";
}

async function probeModel(
  runtime: Pick<AdviserBrowserRuntime, "discoverModels">,
  access: VerificationOutcome,
  preference: readonly string[],
): Promise<{
  readonly result: VerificationResult;
  readonly modelId: string | undefined;
  readonly degraded: boolean;
  readonly reason?: string;
}> {
  if (access !== "verified") {
    return {
      result: { item: "adviser-model", outcome: "unavailable" },
      modelId: undefined,
      degraded: true,
    };
  }

  try {
    const discovered = await runtime.discoverModels();
    if (!discovered.ok || discovered.models === undefined) {
      return {
        result: { item: "adviser-model", outcome: "unavailable" },
        modelId: undefined,
        degraded: true,
      };
    }
    const selection = resolveModelPreference(preference, discovered.models);
    if (!selection.ok) {
      return {
        result: { item: "adviser-model", outcome: "unavailable" },
        modelId: undefined,
        degraded: true,
      };
    }
    return {
      result: { item: "adviser-model", outcome: "verified" },
      modelId: selection.model.modelId,
      degraded: selection.degraded,
      ...(selection.reason === undefined ? {} : { reason: selection.reason }),
    };
  } catch {
    return {
      result: { item: "adviser-model", outcome: "unavailable" },
      modelId: undefined,
      degraded: true,
    };
  }
}

async function probeConnector(
  probe: GitHubConnectorProbe | undefined,
  request: ConsultationCapabilityRequest,
): Promise<VerificationOutcome> {
  if (probe === undefined) return "unverified";
  try {
    const outcome = await probe({
      repository: request.anchor.repository,
      checkpointSha: request.anchor.resolvedCommit,
    });
    // `not-applicable` is not a passing answer for the required V1 connector. Keep it distinct in the
    // probe vocabulary but normalize it to unverified before the strict prerequisite evaluation.
    return outcome === "not-applicable" ? "unverified" : outcome;
  } catch {
    return "unavailable";
  }
}
