import { describe, it, expect } from "vitest";
import {
  TX_PHASE_PIPELINE,
  TX_PHASE_SUBMIT_POLL,
  stepIndexIn,
  isStepCompleted,
  isStepActive,
  isTerminalPhase,
  TX_PHASE_LABELS,
} from "./transactionPhase";

describe("transactionPhase helpers", () => {
  it("marks success as past all steps", () => {
    expect(stepIndexIn(TX_PHASE_PIPELINE, "success")).toBe(TX_PHASE_PIPELINE.length);
  });

  it("resolves active indices in the full pipeline", () => {
    expect(stepIndexIn(TX_PHASE_PIPELINE, "building")).toBe(0);
    expect(stepIndexIn(TX_PHASE_PIPELINE, "simulating")).toBe(1);
    expect(stepIndexIn(TX_PHASE_PIPELINE, "waiting_for_wallet")).toBe(2);
    expect(stepIndexIn(TX_PHASE_PIPELINE, "submitting")).toBe(3);
    expect(stepIndexIn(TX_PHASE_PIPELINE, "polling")).toBe(4);
  });

  it("does not match idle or failure to a step index", () => {
    expect(stepIndexIn(TX_PHASE_PIPELINE, "idle")).toBe(-1);
    expect(stepIndexIn(TX_PHASE_PIPELINE, "failure")).toBe(-1);
  });

  it("computes completed vs active steps during waiting_for_wallet", () => {
    const phase = "waiting_for_wallet";
    expect(isStepCompleted(TX_PHASE_PIPELINE, phase, 0)).toBe(true);
    expect(isStepCompleted(TX_PHASE_PIPELINE, phase, 1)).toBe(true);
    expect(isStepCompleted(TX_PHASE_PIPELINE, phase, 2)).toBe(false);
    expect(isStepActive(TX_PHASE_PIPELINE, phase, 2)).toBe(true);
    expect(isStepActive(TX_PHASE_PIPELINE, phase, 3)).toBe(false);
  });

  it("marks all steps complete on success", () => {
    for (let i = 0; i < TX_PHASE_PIPELINE.length; i++) {
      expect(isStepCompleted(TX_PHASE_PIPELINE, "success", i)).toBe(true);
    }
  });

  it("submit/poll preset has two steps", () => {
    expect(TX_PHASE_SUBMIT_POLL).toEqual(["submitting", "polling"]);
  });

  it("detects terminal phases", () => {
    expect(isTerminalPhase("success")).toBe(true);
    expect(isTerminalPhase("failure")).toBe(true);
    expect(isTerminalPhase("polling")).toBe(false);
  });

  describe("user-facing finalization messaging", () => {
    it.each([
      ["building", "Building transaction"],
      ["simulating", "Simulating"],
      ["waiting_for_wallet", "Waiting for wallet"],
      ["submitting", "Submitting"],
      ["polling", "Confirming on network"],
    ] as const)("keeps pending phase %s deterministic", (phase, expected) => {
      expect(TX_PHASE_LABELS[phase]).toBe(expected);
      expect(isTerminalPhase(phase)).toBe(false);
    });

    it("uses a stable failure label when finalization fails", () => {
      expect(TX_PHASE_LABELS.failure).toBe("Failed");
      expect(isTerminalPhase("failure")).toBe(true);
    });

    it("uses the failure state after a polling timeout", () => {
      const phaseAfterTimeout = "failure" as const;
      expect(TX_PHASE_LABELS[phaseAfterTimeout]).toBe("Failed");
      expect(stepIndexIn(TX_PHASE_PIPELINE, phaseAfterTimeout)).toBe(-1);
      expect(isStepActive(TX_PHASE_PIPELINE, phaseAfterTimeout, 4)).toBe(false);
    });

    it("keeps successful finalization terminal and explicit", () => {
      expect(TX_PHASE_LABELS.success).toBe("Success");
      expect(isTerminalPhase("success")).toBe(true);
      expect(stepIndexIn(TX_PHASE_PIPELINE, "success")).toBe(TX_PHASE_PIPELINE.length);
    });
  });
});
