import { describe, it, expect } from "vitest";
import {
  canRolePerform,
  canRolePerformAction,
  getCapabilitiesForRole,
  normalizeRole,
  describeRole,
} from "./permissions";
import { ROLE_CAPABILITIES } from "./types";

describe("permission matrix (client mirror)", () => {
  it("defines role->capabilities matching server", () => {
    expect(ROLE_CAPABILITIES.viewer).toEqual(["view"]);
    expect(ROLE_CAPABILITIES.reviewer).toEqual(["view", "approve"]);
    expect(ROLE_CAPABILITIES.manager).toEqual(["view", "propose", "execute"]);
    expect(ROLE_CAPABILITIES.owner).toEqual(["view", "propose", "approve", "execute", "manage_members"]);
  });

  it("viewer allowed only view (role combo 1)", () => {
    expect(canRolePerform("viewer", "view")).toBe(true);
    expect(canRolePerform("viewer", "propose")).toBe(false);
    expect(canRolePerform("viewer", "approve")).toBe(false);
    expect(canRolePerform("viewer", "execute")).toBe(false);
  });

  it("reviewer allowed view+approve, denied propose/execute (role combo 2)", () => {
    expect(canRolePerform("reviewer", "view")).toBe(true);
    expect(canRolePerform("reviewer", "approve")).toBe(true);
    expect(canRolePerform("reviewer", "propose")).toBe(false);
    expect(canRolePerform("reviewer", "execute")).toBe(false);
  });

  it("manager allowed propose+execute, denied approve (role combo 3)", () => {
    expect(canRolePerform("manager", "view")).toBe(true);
    expect(canRolePerform("manager", "propose")).toBe(true);
    expect(canRolePerform("manager", "execute")).toBe(true);
    expect(canRolePerform("manager", "approve")).toBe(false);
  });

  it("owner allowed all", () => {
    for (const cap of ["view", "propose", "approve", "execute", "manage_members"] as const) {
      expect(canRolePerform("owner", cap)).toBe(true);
    }
  });

  it("canRolePerformAction uses action mapping", () => {
    expect(canRolePerformAction("viewer", "propose")).toBe(false);
    expect(canRolePerformAction("manager", "propose")).toBe(true);
    expect(canRolePerformAction("reviewer", "approve")).toBe(true);
    expect(canRolePerformAction("manager", "approve")).toBe(false);
    expect(canRolePerformAction(null, "view")).toBe(false);
    expect(canRolePerformAction(undefined, "view")).toBe(false);
  });

  it("normalizeRole case-insensitive", () => {
    expect(normalizeRole("OWNER")).toBe("owner");
    expect(normalizeRole("Viewer")).toBe("viewer");
    expect(normalizeRole("bad")).toBeNull();
  });

  it("getCapabilitiesForRole returns empty for null", () => {
    expect(getCapabilitiesForRole(null)).toEqual([]);
    expect(getCapabilitiesForRole(undefined)).toEqual([]);
  });

  it("describeRole gives human labels", () => {
    expect(describeRole("owner")).toMatch(/Owner/);
    expect(describeRole("viewer")).toMatch(/Viewer/);
  });
});
