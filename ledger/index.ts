/**
 * `ledger/` — durable consultation state that outlives model context.
 *
 * M0 fixes the record shape, the credential-free write guard, and the persist-before-dispatch /
 * persist-before-wake-up ordering. The append-only store implementation lands in M6.
 */

export * from "./record.js";
