import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { App } from "./App";

describe("App", () => {
  beforeEach(() => vi.restoreAllMocks());

  it("renders connected state from the real API responses", async () => {
    vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({ status: "ok", timestamp: "2026-08-05T00:00:00Z" }),
        ),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            status: "ready",
            checks: {
              database: { status: "ready" },
              storage: { status: "ready" },
              configuration: { status: "ready" },
            },
          }),
        ),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            name: "Oloka Video",
            version: "1.2.3",
            environment: "development",
            gitCommitSha: "abc123",
            buildTimestamp: "2026-08-05T00:00:00Z",
          }),
        ),
      );

    render(<App />);

    expect(await screen.findByText("Connected")).toBeInTheDocument();
    expect(screen.getByText("1.2.3")).toBeInTheDocument();
    expect(screen.getByText("abc123")).toBeInTheDocument();
  });

  it("renders an error state when an API request fails", async () => {
    vi.spyOn(globalThis, "fetch").mockRejectedValue(
      new Error("Network unavailable"),
    );

    render(<App />);

    expect(await screen.findByText("Connection error")).toBeInTheDocument();
    expect(screen.getByText("Network unavailable")).toBeInTheDocument();
  });
});
