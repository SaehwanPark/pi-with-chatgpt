/**
 * Credential material needs a type that cannot be printed by accident (INV-12).
 *
 * M2 is the first milestone that holds an OAuth access token in process memory, and the ways a
 * secret leaks are almost never dramatic: a `String(credential)` in a debug line, a `JSON.stringify`
 * of an object that happens to contain one, an `Error(\`failed for ${token}\`)`. A branded string
 * does not prevent those; a wrapper whose serialisation is inert does.
 *
 * `reveal()` is deliberately awkward to call so that every read site is greppable.
 */

/**
 * A secret value with inert serialisation.
 *
 * Instances are frozen and compare by value only through {@linkSecretText.expose}; they never expose
 * the underlying string to string concatenation, template literals, `JSON.stringify`, or `inspect`.
 */
export class SecretText {
  readonly #value: string;

  private constructor(value: string) {
    this.#value = value;
    // Frozen so a caller cannot attach enumerable properties that a debugger or a dump would show.
    Object.freeze(this);
  }

  /** Wrap credential material read from a store. Empty values stay empty (they are not secrets). */
  static from(value: string): SecretText {
    return new SecretText(value);
  }

  /**
   * The only accessor for the plaintext.
   *
   * Call sites are few and load-bearing: handing a token to the transport that needs it. Nothing
   * else may call this, and nothing may store the result.
   */
  expose(): string {
    return this.#value;
  }

  /** True when there is no material to use; callers must treat this as "not authenticated". */
  get empty(): boolean {
    return this.#value.length === 0;
  }

  /**
   * A stable, non-reversible handle for equality and logging.
   *
   * Two credentials holding the same token produce the same fingerprint, which is enough to detect
   * "the browser session and Pi agree" without comparing (or keeping) the tokens themselves.
   */
  get fingerprint(): string {
    return fingerprintOf(this.#value);
  }

  toString(): string {
    return "[redacted]";
  }

  toJSON(): string {
    return "[redacted]";
  }

  [Symbol.for("nodejs.util.inspect.custom")](): string {
    return "SecretText([redacted])";
  }
}

/**
 * FNV-1a over the value, hex encoded.
 *
 * This is not a security boundary — a token is high-entropy, so a 64-bit digest is not invertible in
 * practice, and nothing security-critical may be derived from it. It exists so a diagnostic can say
 * "same credential as before" without carrying the credential.
 */
function fingerprintOf(value: string): string {
  let hash = 0xcbf29ce484222325n;
  const prime = 0x100000001b3n;
  const mask = 0xffffffffffffffffn;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= BigInt(value.charCodeAt(index));
    hash = (hash * prime) & mask;
  }
  return hash.toString(16).padStart(16, "0");
}
