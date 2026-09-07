import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { VaultActionGate, VaultRouteGuard } from "../VaultActionGate";

describe("VaultActionGate — client hide/disable based on role", () => {
  // Three role combinations required by acceptance: viewer, reviewer, manager are distinct.
  it("hide mode: viewer sees view but not propose", () => {
    render(
      <>
        <VaultActionGate role="viewer" requiredCapability="view" mode="hide">
          <span data-testid="view-allowed">view btn</span>
        </VaultActionGate>
        <VaultActionGate role="viewer" requiredCapability="propose" mode="hide" fallback={<span data-testid="propose-fallback">no propose</span>}>
          <span>propose btn</span>
        </VaultActionGate>
      </>
    );
    expect(screen.getByTestId("view-allowed")).toBeInTheDocument();
    expect(screen.getByTestId("propose-fallback")).toBeInTheDocument();
  });

  it("hide mode: reviewer sees approve but not execute", () => {
    render(
      <>
        <VaultActionGate role="reviewer" requiredCapability="approve" mode="hide">
          <span data-testid="approve-allowed">approve</span>
        </VaultActionGate>
        <VaultActionGate role="reviewer" requiredCapability="execute" mode="hide">
          <span data-testid="execute-allowed">execute</span>
        </VaultActionGate>
      </>
    );
    expect(screen.getByTestId("approve-allowed")).toBeInTheDocument();
    expect(screen.queryByTestId("execute-allowed")).not.toBeInTheDocument();
  });

  it("hide mode: manager sees propose+execute but not approve", () => {
    render(
      <>
        <VaultActionGate role="manager" requiredCapability="propose" mode="hide">
          <span data-testid="mgr-propose">propose</span>
        </VaultActionGate>
        <VaultActionGate role="manager" requiredCapability="execute" mode="hide">
          <span data-testid="mgr-execute">execute</span>
        </VaultActionGate>
        <VaultActionGate role="manager" requiredCapability="approve" mode="hide">
          <span data-testid="mgr-approve">approve</span>
        </VaultActionGate>
      </>
    );
    expect(screen.getByTestId("mgr-propose")).toBeInTheDocument();
    expect(screen.getByTestId("mgr-execute")).toBeInTheDocument();
    expect(screen.queryByTestId("mgr-approve")).not.toBeInTheDocument();
  });

  it("disable mode: renders disabled wrapper with aria-disabled", () => {
    render(
      <VaultActionGate role="viewer" requiredCapability="propose" mode="disable" disabledReason="needs propose">
        <button>Propose</button>
      </VaultActionGate>
    );
    const wrapper = screen.getByText("Propose").closest("[aria-disabled='true']");
    expect(wrapper).not.toBeNull();
    expect(wrapper).toHaveAttribute("title", "needs propose");
    expect(wrapper).toHaveAttribute("data-role", "viewer");
  });

  it("supports requiredAction mapping (propose -> propose capability)", () => {
    render(
      <VaultActionGate role="manager" requiredAction="propose" mode="hide">
        <span data-testid="action-propose">ok</span>
      </VaultActionGate>
    );
    expect(screen.getByTestId("action-propose")).toBeInTheDocument();
  });

  it("null role denies all", () => {
    render(
      <VaultActionGate role={null} requiredCapability="view" mode="hide">
        <span data-testid="null-view">x</span>
      </VaultActionGate>
    );
    expect(screen.queryByTestId("null-view")).not.toBeInTheDocument();
  });

  it("VaultRouteGuard shows fallback when forbidden, children when allowed", () => {
    const { rerender } = render(
      <VaultRouteGuard role="viewer" requiredCapability="propose" fallback={<span data-testid="fallback">denied</span>}>
        <span data-testid="child">allowed</span>
      </VaultRouteGuard>
    );
    expect(screen.getByTestId("fallback")).toBeInTheDocument();
    expect(screen.queryByTestId("child")).not.toBeInTheDocument();

    rerender(
      <VaultRouteGuard role="manager" requiredCapability="propose" fallback={<span data-testid="fallback2">denied</span>}>
        <span data-testid="child2">allowed</span>
      </VaultRouteGuard>
    );
    expect(screen.getByTestId("child2")).toBeInTheDocument();
  });

  it("VaultRouteGuard shows default forbidden message when no fallback", () => {
    render(
      <VaultRouteGuard role="viewer" requiredCapability="execute">
        <span>secret</span>
      </VaultRouteGuard>
    );
    expect(screen.getByTestId("vault-route-forbidden")).toBeInTheDocument();
  });
});
