import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { App } from "./App";

describe("App", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    localStorage.clear();
    sessionStorage.clear();
  });

  it("renders the closed-beta Google entry for a visitor", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      new Response(JSON.stringify({ authenticated: false })),
    );

    render(<App />);

    expect(await screen.findByText("Continue with Google")).toHaveAttribute(
      "href",
      "/api/v1/auth/google/start",
    );
    expect(screen.getAllByText(/closed beta/i).length).toBeGreaterThan(0);
  });

  it("renders an error state when an API request fails", async () => {
    vi.spyOn(globalThis, "fetch").mockRejectedValue(
      new Error("Network unavailable"),
    );

    render(<App />);

    expect(await screen.findByText("Connection error")).toBeInTheDocument();
    expect(screen.getByText("Network unavailable")).toBeInTheDocument();
  });

  it("renders the pending state without product navigation", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          authenticated: true,
          user: {
            id: "00000000-0000-4000-8000-000000000001",
            email: "pending@example.test",
            displayName: "Pending Member",
            avatarUrl: null,
            role: "member",
            status: "pending",
            version: 1,
          },
        }),
      ),
    );

    render(<App />);

    expect(
      await screen.findByText("Your account is pending approval"),
    ).toBeInTheDocument();
    expect(screen.queryByText("Continue with Google")).not.toBeInTheDocument();
  });

  it("renders the bounded pending-user queue for an active admin", async () => {
    vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            authenticated: true,
            user: {
              id: "00000000-0000-4000-8000-000000000001",
              email: "admin@example.test",
              displayName: "Admin",
              avatarUrl: null,
              role: "admin",
              status: "active",
              version: 1,
            },
          }),
        ),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ users: [], nextCursor: null })),
      );

    render(<App />);

    expect(await screen.findByText("Pending users")).toBeInTheDocument();
    expect(await screen.findByText("No pending users.")).toBeInTheDocument();
  });

  it("keeps the CSRF token in memory while approving a pending user", async () => {
    const user = {
      id: "00000000-0000-4000-8000-000000000002",
      email: "pending@example.test",
      displayName: "Pending Member",
      avatarUrl: null,
      role: "member",
      status: "pending",
      version: 1,
    } as const;
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            authenticated: true,
            user: { ...user, role: "admin", status: "active" },
          }),
        ),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ users: [user], nextCursor: null })),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            csrfToken: "memory-only-csrf-token-value-1234567890",
          }),
        ),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ user }), { status: 200 }),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ users: [], nextCursor: null })),
      );

    render(<App />);
    fireEvent.click(await screen.findByRole("button", { name: "Approve" }));

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(5));
    expect(fetchMock.mock.calls[3]?.[1]).toMatchObject({
      headers: expect.objectContaining({
        "x-oloka-csrf": "memory-only-csrf-token-value-1234567890",
      }),
    });
    expect(JSON.stringify({ ...localStorage })).not.toContain(
      "memory-only-csrf",
    );
    expect(JSON.stringify({ ...sessionStorage })).not.toContain(
      "memory-only-csrf",
    );
  });
});
