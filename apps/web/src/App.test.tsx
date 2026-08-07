import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { App } from "./App";

describe("App", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    localStorage.clear();
    sessionStorage.clear();
    window.history.replaceState({}, "", "/");
  });

  it("renders a fixed generic auth error without exposing callback query text", () => {
    const fetchMock = vi.spyOn(globalThis, "fetch");
    window.history.replaceState(
      {},
      "",
      "/auth/error?error_description=sensitive&code=secret&state=opaque",
    );

    render(<App />);

    expect(
      screen.getByText("Google sign-in did not complete"),
    ).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Try again" })).toHaveAttribute(
      "href",
      "/api/v1/auth/google/start",
    );
    expect(
      screen.queryByText(/sensitive|secret|opaque/i),
    ).not.toBeInTheDocument();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("renders the closed-beta Google entry for a visitor", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          error: {
            code: "AUTHENTICATION_REQUIRED",
            retryable: true,
            messageKey: "error.auth.required",
            suggestedAction: "Sign in again with Google",
            requestId: "request-visitor",
          },
        }),
        { status: 401 },
      ),
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

  it("renders canonical API guidance and request ID without legacy message fields", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          error: {
            code: "INTERNAL_ERROR",
            retryable: true,
            messageKey: "error.internal",
            suggestedAction: "Retry later and provide the request ID",
            requestId: "request-support-123",
          },
        }),
        { status: 500 },
      ),
    );

    render(<App />);

    expect(
      await screen.findByText("Retry later and provide the request ID"),
    ).toBeInTheDocument();
    expect(screen.getByText(/request-support-123/)).toBeInTheDocument();
    expect(screen.getByText(/error\.internal/)).toBeInTheDocument();
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
