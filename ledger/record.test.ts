import { describe, expect, it } from "vitest";

import {
  assertLedgerRecordSafe,
  assertPersistenceOrder,
  LEDGER_PUBLICATION_TARGETS,
  PERSISTENCE_STEPS,
  UnsafeLedgerRecordError,
} from "./record.js";
import { ledgerRecord, unsafeRecord } from "../test/fixtures.js";

describe("durable provenance (INV-15)", () => {
  it("persists the job before dispatch and the response before wake-up", () => {
    expect(PERSISTENCE_STEPS).toEqual(["job-persisted", "dispatched", "response-persisted", "delivered"]);
    expect(() => assertPersistenceOrder(PERSISTENCE_STEPS)).not.toThrow();
    expect(() => assertPersistenceOrder(["job-persisted", "dispatched"])).not.toThrow();
  });

  it("rejects dispatching before the job is persisted", () => {
    expect(() => assertPersistenceOrder(["dispatched", "job-persisted"])).toThrow(UnsafeLedgerRecordError);
  });

  it("rejects waking the session before the response is persisted", () => {
    expect(() => assertPersistenceOrder(["job-persisted", "dispatched", "delivered", "response-persisted"])).toThrow(
      /persisted before session wake-up/u,
    );
  });

  it("treats an omitted persistence step as a violation, not as nothing to check", () => {
    // Failing open here would make "forget to record the persist" the way to pass the guard.
    expect(() => assertPersistenceOrder(["dispatched"])).toThrow(UnsafeLedgerRecordError);
    expect(() => assertPersistenceOrder([])).not.toThrow(); // nothing dispatched, nothing promised
    expect(() => assertPersistenceOrder(["job-persisted", "dispatched", "delivered"])).toThrow(
      UnsafeLedgerRecordError,
    );
  });

  it("rejects a PEM private key that arrived inside adviser text", () => {
    const record = { ...ledgerRecord(), adviserAnswer: "try -----BEGIN RSA PRIVATE KEY-----\nMIIB" };
    expect(() => assertLedgerRecordSafe(record)).toThrow(UnsafeLedgerRecordError);
  });

  it("has no publication target: the ledger is never pushed anywhere automatically", () => {
    expect(LEDGER_PUBLICATION_TARGETS).toEqual(["none"]);
  });
});

describe("credential containment in ledger records (INV-12)", () => {
  it("accepts an ordinary record", () => {
    expect(() => assertLedgerRecordSafe(ledgerRecord())).not.toThrow();
    expect(() => assertLedgerRecordSafe(ledgerRecord({ notes: "provenance only, no secrets" }))).not.toThrow();
  });

  it("rejects credential-shaped field names", () => {
    expect(() => assertLedgerRecordSafe(unsafeRecord({ accessToken: "abcdef1234567890" }))).toThrow(
      /field "accessToken"/u,
    );
  });

  it("rejects credential-shaped values, including nested ones", () => {
    expect(() =>
      assertLedgerRecordSafe(ledgerRecord({ adviserAnswer: "use Authorization: Bearer abcdef.ghijkl012345 next time" })),
    ).toThrow(/secret pattern/u);
    expect(() =>
      assertLedgerRecordSafe(
        ledgerRecord({
          actionItems: [{ ordinal: 1, summary: "ghp_abcdefghijklmnopqrstuvwxyz0123", disposition: "pending" }],
        }),
      ),
    ).toThrow(/secret pattern/u);
  });

  it("keeps browser profile paths out of records", () => {
    expect(() =>
      assertLedgerRecordSafe(unsafeRecord({ userDataDir: "/home/dev/.local/share/pi-with-chatgpt/browser" })),
    ).toThrow(/field "userDataDir"/u);
  });
});
