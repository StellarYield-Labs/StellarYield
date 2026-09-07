/**
 * Tests for #167 — disconnected-state coverage for the Google Sheets panel.
 */

import { render, screen } from "@testing-library/react";
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import GoogleSheetsPanel from "./GoogleSheetsPanel";

const SHEETS_STORAGE_KEY = "stellar_yield_google_sheets";

describe("GoogleSheetsPanel — disconnected state", () => {
  beforeEach(() => {
    localStorage.clear();
  });

  afterEach(() => {
    localStorage.clear();
  });

  it("renders the disconnected state when no Google Sheets config is linked", () => {
    render(<GoogleSheetsPanel walletAddress="GABC123" />);

    expect(
      screen.getByText(/connect your google account to automatically sync/i),
    ).toBeInTheDocument();
    expect(screen.queryByText("Connected")).not.toBeInTheDocument();
    expect(screen.queryByText(/unlink account/i)).not.toBeInTheDocument();
  });

  it("shows the connect action and it is enabled/clickable", () => {
    render(<GoogleSheetsPanel walletAddress="GABC123" />);

    const connectButton = screen.getByRole("button", {
      name: /connect google account/i,
    });
    expect(connectButton).toBeInTheDocument();
    expect(connectButton).toBeEnabled();
  });

  it("shows the link-spreadsheet form (not the sync-settings panel) while disconnected", () => {
    render(<GoogleSheetsPanel walletAddress="GABC123" />);

    expect(
      screen.getByRole("heading", { name: /link spreadsheet/i }),
    ).toBeInTheDocument();
    expect(screen.getByPlaceholderText(/paste google sheets id/i)).toBeInTheDocument();
    expect(
      screen.queryByRole("heading", { name: /sync settings/i }),
    ).not.toBeInTheDocument();
  });
});

describe("GoogleSheetsPanel — connected state (unchanged)", () => {
  beforeEach(() => {
    localStorage.clear();
    localStorage.setItem(
      SHEETS_STORAGE_KEY,
      JSON.stringify({
        spreadsheetId: "abc123",
        sheetName: "Yield Metrics",
        isLinked: true,
        linkedAt: Date.now(),
      }),
    );
  });

  afterEach(() => {
    localStorage.clear();
  });

  it("renders the connected state and hides the connect action", () => {
    render(<GoogleSheetsPanel walletAddress="GABC123" />);

    expect(screen.getByText("Connected")).toBeInTheDocument();
    expect(screen.getByText(/syncing to: yield metrics/i)).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: /connect google account/i }),
    ).not.toBeInTheDocument();
  });

  it("shows the unlink action instead of the link-spreadsheet form", () => {
    render(<GoogleSheetsPanel walletAddress="GABC123" />);

    expect(screen.getByRole("button", { name: /unlink account/i })).toBeInTheDocument();
    expect(
      screen.getByRole("heading", { name: /sync settings/i }),
    ).toBeInTheDocument();
    expect(
      screen.queryByPlaceholderText(/paste google sheets id/i),
    ).not.toBeInTheDocument();
  });
});
