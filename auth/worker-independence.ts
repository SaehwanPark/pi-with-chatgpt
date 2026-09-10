/**
 * Worker/adviser independence (M2).
 *
 * The whole premise of this project is that the model doing the work and the model giving advice are
 * different: a cheap or local worker (Qwen via Ollama, an OpenRouter model, an API-key-backed model)
 * consults a paid ChatGPT sign-in. Two confusions break that, and both are easy to write by accident:
 *
 *   1. gating the adviser on the *worker's* provider — which would disable the adviser exactly for the
 *      local-worker users it exists for; and
 *   2. reusing the *worker's* credential as the adviser's, which turns an API key into an assumed
 *      ChatGPT account (and is why an API-key credential resolves to no identity at all).
 *
 * This module states the rule in one place: the adviser's account comes from Pi's OpenAI sign-in, and
 * nothing else about the worker is consulted. The tests pin that a local worker is eligible, which is
 * the case a future "just check the active provider" refactor would silently break.
 */

import { PI_OPENAI_PROVIDER_ID } from "./pi-credential.js";

export interface WorkerRuntimeFacts {
  /** Pi provider id for the *worker*, e.g. `ollama`, `openrouter`, `openai-codex`. */
  readonly workerProviderId: string;
  /** Model id the worker is running. Never compared with the adviser's model. */
  readonly workerModelId: string;
  /** Whether Pi holds an OpenAI OAuth credential (the only adviser identity source in V1). */
  readonly openAiSignInAvailable: boolean;
}

export const WORKER_INDEPENDENCE_RULE =
  "The adviser account comes from Pi's OpenAI sign-in; the worker provider and model are never consulted.";

export type AdviserEligibility =
  | { readonly eligible: true; readonly reason: "worker-independent"; readonly credentialProviderId: string }
  | { readonly eligible: false; readonly reason: "no-openai-sign-in"; readonly credentialProviderId: string };

/**
 * Can this worker consult the adviser?
 *
 * `workerProviderId` and `workerModelId` are accepted so the call site has to say what it is running —
 * and so a reviewer can see that neither is read. That is the point of the signature: independence is
 * easier to preserve when the data is visibly present and visibly unused.
 */
export function assessAdviserEligibility(facts: WorkerRuntimeFacts): AdviserEligibility {
  if (!facts.openAiSignInAvailable) {
    return { eligible: false, reason: "no-openai-sign-in", credentialProviderId: PI_OPENAI_PROVIDER_ID };
  }
  return { eligible: true, reason: "worker-independent", credentialProviderId: PI_OPENAI_PROVIDER_ID };
}

/**
 * One line for the status surface naming both sides.
 *
 * Naming them together is the UX version of the invariant: when the two are always displayed as
 * separate facts, "why is it using that account?" stops being a mystery. Provider and model ids are not
 * secrets, and no identity material belongs in this string.
 */
export function describeWorkerAndAdviser(
  facts: WorkerRuntimeFacts,
  adviser?: { readonly accountLabel?: string; readonly planHint?: string },
): string {
  const adviserPart =
    adviser?.accountLabel === undefined
      ? "adviser: no OpenAI sign-in"
      : `adviser: ${adviser.accountLabel}${adviser.planHint === undefined ? "" : ` (${adviser.planHint})`}`;
  return `worker: ${facts.workerProviderId}/${facts.workerModelId}; ${adviserPart}`;
}
