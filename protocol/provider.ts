/**
 * V1 has exactly one adviser provider (INV-16).
 *
 * This module exists so that "provider abstraction" cannot quietly become a second transport: a
 * provider must speak the same GitHub-only context contract, and adding one is a roadmap decision
 * rather than a configuration value. A future provider would add a member to
 * `V1_ADVISER_PROVIDERS` *and* the invariant review that documents why it does not relax INV-02.
 */

export const V1_ADVISER_PROVIDERS = ["chatgpt"] as const;

export type AdviserProvider = (typeof V1_ADVISER_PROVIDERS)[number];

export const DEFAULT_ADVISER_PROVIDER: AdviserProvider = "chatgpt";

export class UnsupportedAdviserProviderError extends Error {
  constructor(requested: string) {
    super(
      `Adviser provider "${requested}" is not supported in V1 (supported: ${V1_ADVISER_PROVIDERS.join(", ")}). ` +
        `Additional providers are a post-V1 decision.`,
    );
    this.name = "UnsupportedAdviserProviderError";
  }
}

export function requireAdviserProvider(value: string): AdviserProvider {
  if ((V1_ADVISER_PROVIDERS as readonly string[]).includes(value)) return value as AdviserProvider;
  throw new UnsupportedAdviserProviderError(value);
}
