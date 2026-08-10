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

  it("renders the canonical Project empty state for an active member", async () => {
    vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            authenticated: true,
            user: {
              id: "00000000-0000-4000-8000-000000000001",
              email: "member@example.test",
              displayName: "Active Member",
              avatarUrl: null,
              role: "member",
              status: "active",
              version: 1,
            },
          }),
        ),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ projects: [], nextCursor: null })),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ projects: [], nextCursor: null })),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ jobs: [], nextCursor: null })),
      );

    render(<App />);

    expect(await screen.findByText("No projects yet")).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Create project" }),
    ).toBeInTheDocument();
    expect(screen.getByText("Trash is empty")).toBeInTheDocument();
  });

  it("renders the bounded pending-user queue for an active admin", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation((input) => {
      const url = requestUrl(input);
      if (url === "/api/v1/auth/session")
        return Promise.resolve(
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
        );
      if (url.startsWith("/api/v1/admin/users"))
        return Promise.resolve(
          new Response(JSON.stringify({ users: [], nextCursor: null })),
        );
      if (url.startsWith("/api/v1/jobs"))
        return Promise.resolve(
          new Response(JSON.stringify({ jobs: [], nextCursor: null })),
        );
      return Promise.resolve(
        new Response(JSON.stringify({ projects: [], nextCursor: null })),
      );
    });

    render(<App />);

    expect(await screen.findByText("Pending users")).toBeInTheDocument();
    expect(await screen.findByText("No pending users.")).toBeInTheDocument();
  });

  it("renders persisted Job progress without a timer-generated value", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation((input) => {
      const url = requestUrl(input);
      if (url === "/api/v1/auth/session")
        return Promise.resolve(
          new Response(
            JSON.stringify({
              authenticated: true,
              user: {
                id: "00000000-0000-4000-8000-000000000001",
                email: "member@example.test",
                displayName: "Active Member",
                avatarUrl: null,
                role: "member",
                status: "active",
                version: 1,
              },
            }),
          ),
        );
      if (url.startsWith("/api/v1/jobs"))
        return Promise.resolve(
          new Response(
            JSON.stringify({
              jobs: [
                {
                  schemaVersion: 1,
                  id: "10000000-0000-4000-8000-000000000001",
                  projectId: "20000000-0000-4000-8000-000000000001",
                  type: "asset_ingestion",
                  status: "completed",
                  progressBasisPoints: 10000,
                  currentStepKey: "inspect_asset",
                  attemptCount: 1,
                  failureCode: null,
                  createdAt: "2026-08-09T00:00:00.000Z",
                  startedAt: "2026-08-09T00:00:01.000Z",
                  finishedAt: "2026-08-09T00:00:02.000Z",
                  updatedAt: "2026-08-09T00:00:02.000Z",
                  version: 3,
                },
              ],
              nextCursor: null,
            }),
          ),
        );
      return Promise.resolve(
        new Response(JSON.stringify({ projects: [], nextCursor: null })),
      );
    });

    render(<App />);

    expect(await screen.findByText("asset ingestion")).toBeInTheDocument();
    expect(screen.getByText("completed · attempt 1")).toBeInTheDocument();
    expect(screen.getByText("100%")).toBeInTheDocument();
    expect(screen.getByText("inspect_asset")).toBeInTheDocument();
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
    let adminLists = 0;
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockImplementation((input, init) => {
        const url = requestUrl(input);
        if (url === "/api/v1/auth/session")
          return Promise.resolve(
            new Response(
              JSON.stringify({
                authenticated: true,
                user: { ...user, role: "admin", status: "active" },
              }),
            ),
          );
        if (url === "/api/v1/auth/csrf")
          return Promise.resolve(
            new Response(
              JSON.stringify({
                csrfToken: "memory-only-csrf-token-value-1234567890",
              }),
            ),
          );
        if (url.startsWith("/api/v1/admin/users/") && init?.method === "PATCH")
          return Promise.resolve(
            new Response(JSON.stringify({ user }), { status: 200 }),
          );
        if (url.startsWith("/api/v1/admin/users")) {
          adminLists += 1;
          return Promise.resolve(
            new Response(
              JSON.stringify({
                users: adminLists === 1 ? [user] : [],
                nextCursor: null,
              }),
            ),
          );
        }
        if (url.startsWith("/api/v1/jobs"))
          return Promise.resolve(
            new Response(JSON.stringify({ jobs: [], nextCursor: null })),
          );
        return Promise.resolve(
          new Response(JSON.stringify({ projects: [], nextCursor: null })),
        );
      });

    render(<App />);
    fireEvent.click(await screen.findByRole("button", { name: "Approve" }));

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(8));
    const approvalCall = fetchMock.mock.calls.find(
      ([input, init]) =>
        requestUrl(input).startsWith("/api/v1/admin/users/") &&
        init?.method === "PATCH",
    );
    expect(approvalCall?.[1]).toMatchObject({
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

function requestUrl(input: RequestInfo | URL): string {
  if (typeof input === "string") return input;
  if (input instanceof URL) return input.href;
  return input.url;
}
