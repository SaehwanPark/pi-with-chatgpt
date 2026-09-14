import { describe, expect, it } from "vitest";

import { AdviserHealthCircuit } from "./health.js";

describe("AdviserHealthCircuit", () => {
  it("opens after repeated transport failures and closes after a successful probe", () => {
    let now = 0;
    const circuit = new AdviserHealthCircuit({ now: () => now, cooldownMs: 100, windowMs: 1_000 });

    expect(circuit.admit().allowed).toBe(true);
    circuit.recordTransportFailure();
    circuit.recordTransportFailure();
    circuit.recordTransportFailure();
    expect(circuit.state()).toBe("open");
    expect(circuit.admit()).toMatchObject({ allowed: false, state: "open" });

    now = 101;
    expect(circuit.admit()).toMatchObject({ allowed: true, state: "half-open", probe: true });
    expect(circuit.admit().allowed).toBe(false);
    circuit.recordSuccess();
    expect(circuit.state()).toBe("healthy");
    expect(circuit.admit().allowed).toBe(true);
  });

  it("does not retain failures outside the rolling window", () => {
    let now = 0;
    const circuit = new AdviserHealthCircuit({ now: () => now, windowMs: 50 });
    circuit.recordTransportFailure();
    circuit.recordTransportFailure();
    now = 100;
    expect(circuit.state()).toBe("healthy");
    circuit.recordTransportFailure();
    expect(circuit.state()).toBe("degraded");
  });
});
