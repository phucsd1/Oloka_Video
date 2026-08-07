import {
  adminUsersResponseSchema,
  authSessionResponseSchema,
  csrfResponseSchema,
  type IdentityUser,
} from "@oloka/contracts";
import { Surface } from "@oloka/design-system";
import { useCallback, useEffect, useRef, useState } from "react";

type AppState =
  | { kind: "loading" }
  | { kind: "visitor" }
  | { kind: "authenticated"; user: IdentityUser }
  | { kind: "error"; message: string };

async function getJson(path: string): Promise<unknown> {
  const response = await fetch(path, {
    headers: { accept: "application/json" },
  });
  if (!response.ok) throw new Error(`${path} returned ${response.status}`);
  return response.json();
}

export function App() {
  const [state, setState] = useState<AppState>({ kind: "loading" });
  const csrfToken = useRef<string | null>(null);

  useEffect(() => {
    let active = true;
    getJson("/api/v1/auth/session")
      .then((value) => authSessionResponseSchema.parse(value))
      .then((session) => {
        if (!active) return;
        setState(
          session.authenticated
            ? { kind: "authenticated", user: session.user }
            : { kind: "visitor" },
        );
      })
      .catch((error: unknown) => {
        if (!active) return;
        setState({
          kind: "error",
          message: error instanceof Error ? error.message : "Unknown error",
        });
      });
    return () => {
      active = false;
      csrfToken.current = null;
    };
  }, []);

  const getCsrfToken = useCallback(async (): Promise<string> => {
    if (csrfToken.current !== null) return csrfToken.current;
    const response = csrfResponseSchema.parse(
      await getJson("/api/v1/auth/csrf"),
    );
    csrfToken.current = response.csrfToken;
    return response.csrfToken;
  }, []);

  const logout = useCallback(async () => {
    const token = await getCsrfToken();
    const response = await fetch("/api/v1/auth/logout", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-oloka-csrf": token,
      },
      body: "{}",
    });
    if (!response.ok) throw new Error(`Logout returned ${response.status}`);
    csrfToken.current = null;
    setState({ kind: "visitor" });
  }, [getCsrfToken]);

  return (
    <main className="page-shell">
      <header className="topbar">
        <a className="brand" href="/" aria-label="Oloka Video home">
          <span className="brand-mark">O</span>
          <span>Oloka Video</span>
        </a>
        <span className="environment-label">Closed beta</span>
      </header>

      <div className="content">
        {state.kind === "loading" && <LoadingState />}
        {state.kind === "error" && <ErrorState message={state.message} />}
        {state.kind === "visitor" && <VisitorState />}
        {state.kind === "authenticated" && state.user.status === "pending" && (
          <AccountState
            title="Your account is pending approval"
            message="An Oloka Video administrator must approve this closed-beta account before product access is available."
            onLogout={logout}
          />
        )}
        {state.kind === "authenticated" &&
          (state.user.status === "disabled" ||
            state.user.status === "rejected") && (
            <AccountState
              title={
                state.user.status === "disabled"
                  ? "This account is disabled"
                  : "This account request was rejected"
              }
              message="Product access is unavailable. Contact an Oloka Video administrator if you believe this status is incorrect."
              onLogout={logout}
            />
          )}
        {state.kind === "authenticated" && state.user.status === "active" && (
          <ActiveState
            user={state.user}
            getCsrfToken={getCsrfToken}
            onLogout={logout}
          />
        )}
      </div>

      <footer>
        <span>Oloka Video</span>
        <span>Identity and approval foundation</span>
      </footer>
    </main>
  );
}

function LoadingState() {
  return (
    <Surface
      className="state-panel loading-panel"
      aria-live="polite"
      aria-busy="true"
    >
      <span className="loading-line" />
      <div>
        <strong>Checking your session</strong>
        <p>Loading the current account state.</p>
      </div>
    </Surface>
  );
}

function ErrorState({ message }: { message: string }) {
  return (
    <Surface className="state-panel error-panel" role="alert">
      <span className="state-symbol">!</span>
      <div>
        <strong>Connection error</strong>
        <p>{message}</p>
      </div>
    </Surface>
  );
}

function VisitorState() {
  return (
    <section className="hero auth-hero" aria-labelledby="page-title">
      <div>
        <p className="eyebrow">Oloka Video closed beta</p>
        <h1 id="page-title">
          Build dependable video, one approved account at a time.
        </h1>
        <p className="hero-copy">
          Sign in with a verified Google account. New accounts wait for
          administrator approval before product access.
        </p>
        <a className="primary-action" href="/api/v1/auth/google/start">
          Continue with Google
        </a>
      </div>
    </section>
  );
}

function AccountState(props: {
  title: string;
  message: string;
  onLogout: () => Promise<void>;
}) {
  return (
    <Surface className="account-panel">
      <p className="eyebrow">Account status</p>
      <h1>{props.title}</h1>
      <p className="hero-copy">{props.message}</p>
      <button
        className="secondary-action"
        onClick={() => void props.onLogout()}
      >
        Sign out
      </button>
    </Surface>
  );
}

function ActiveState(props: {
  user: IdentityUser;
  getCsrfToken: () => Promise<string>;
  onLogout: () => Promise<void>;
}) {
  return (
    <div>
      <section className="hero compact-hero">
        <div>
          <p className="eyebrow">Approved account</p>
          <h1>Welcome, {props.user.displayName}.</h1>
          <p className="hero-copy">
            Identity is active. Project creation begins in a later slice.
          </p>
        </div>
        <button
          className="secondary-action"
          onClick={() => void props.onLogout()}
        >
          Sign out
        </button>
      </section>
      {props.user.role === "admin" && (
        <AdminApprovalPanel getCsrfToken={props.getCsrfToken} />
      )}
    </div>
  );
}

function AdminApprovalPanel(props: { getCsrfToken: () => Promise<string> }) {
  const [users, setUsers] = useState<IdentityUser[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      const result = adminUsersResponseSchema.parse(
        await getJson("/api/v1/admin/users?status=pending"),
      );
      setUsers(result.users);
      setError(null);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Admin list failed");
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const approve = async (user: IdentityUser) => {
    const token = await props.getCsrfToken();
    const response = await fetch(`/api/v1/admin/users/${user.id}`, {
      method: "PATCH",
      headers: {
        "content-type": "application/json",
        "x-oloka-csrf": token,
        "idempotency-key": crypto.randomUUID(),
      },
      body: JSON.stringify({
        status: "active",
        version: user.version,
        reason: "Approved through the admin account queue",
      }),
    });
    if (!response.ok) throw new Error(`Approval returned ${response.status}`);
    await refresh();
  };

  return (
    <Surface className="admin-panel">
      <div className="card-heading">
        <div>
          <p className="eyebrow">Administration</p>
          <h2>Pending users</h2>
        </div>
        <button className="secondary-action" onClick={() => void refresh()}>
          Refresh
        </button>
      </div>
      {users === null && error === null && <p>Loading pending users…</p>}
      {error !== null && <p role="alert">{error}</p>}
      {users?.length === 0 && <p>No pending users.</p>}
      {users?.map((user) => (
        <div className="admin-user-row" key={user.id}>
          <div>
            <strong>{user.displayName}</strong>
            <span>{user.email}</span>
          </div>
          <button className="primary-action" onClick={() => void approve(user)}>
            Approve
          </button>
        </div>
      ))}
    </Surface>
  );
}
