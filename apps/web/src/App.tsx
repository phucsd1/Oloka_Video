import {
  adminUsersResponseSchema,
  authSessionResponseSchema,
  csrfResponseSchema,
  errorEnvelopeSchema,
  projectListResponseSchema,
  projectSchema,
  type IdentityUser,
  type Project,
} from "@oloka/contracts";
import { Surface } from "@oloka/design-system";
import { useCallback, useEffect, useRef, useState } from "react";
import type { FormEvent } from "react";

type AppState =
  | { kind: "loading" }
  | { kind: "visitor" }
  | { kind: "authenticated"; user: IdentityUser }
  | {
      kind: "error";
      message: string;
      requestId?: string;
      messageKey?: string;
    };

class ApiError extends Error {
  constructor(
    readonly code: string,
    readonly messageKey: string,
    readonly suggestedAction: string,
    readonly requestId: string,
  ) {
    super(suggestedAction);
    this.name = "ApiError";
  }
}

async function getJson(path: string): Promise<unknown> {
  const response = await fetch(path, {
    headers: { accept: "application/json" },
  });
  if (!response.ok) {
    const envelope = errorEnvelopeSchema.parse(await response.json());
    throw new ApiError(
      envelope.error.code,
      envelope.error.messageKey,
      envelope.error.suggestedAction,
      envelope.error.requestId,
    );
  }
  return response.json();
}

async function mutateJson(
  path: string,
  method: "POST" | "PATCH" | "DELETE",
  body: unknown,
  getCsrfToken: () => Promise<string>,
): Promise<unknown> {
  const response = await fetch(path, {
    method,
    headers: {
      accept: "application/json",
      "content-type": "application/json",
      "x-oloka-csrf": await getCsrfToken(),
      "idempotency-key": crypto.randomUUID(),
    },
    body: JSON.stringify(body),
  });
  if (!response.ok) {
    const envelope = errorEnvelopeSchema.parse(await response.json());
    throw new ApiError(
      envelope.error.code,
      envelope.error.messageKey,
      envelope.error.suggestedAction,
      envelope.error.requestId,
    );
  }
  return response.json();
}

export function App() {
  const [state, setState] = useState<AppState>({ kind: "loading" });
  const csrfToken = useRef<string | null>(null);
  const authErrorRoute = window.location.pathname === "/auth/error";

  useEffect(() => {
    if (authErrorRoute) return;
    let active = true;
    getJson("/api/v1/auth/session")
      .then((value) => authSessionResponseSchema.parse(value))
      .then((session) => {
        if (!active) return;
        setState({ kind: "authenticated", user: session.user });
      })
      .catch((error: unknown) => {
        if (!active) return;
        if (
          error instanceof ApiError &&
          error.code === "AUTHENTICATION_REQUIRED"
        ) {
          setState({ kind: "visitor" });
        } else {
          setState({
            kind: "error",
            message: error instanceof Error ? error.message : "Unknown error",
            ...(error instanceof ApiError
              ? { requestId: error.requestId, messageKey: error.messageKey }
              : {}),
          });
        }
      });
    return () => {
      active = false;
      csrfToken.current = null;
    };
  }, [authErrorRoute]);

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
        {authErrorRoute && <AuthErrorState />}
        {!authErrorRoute && state.kind === "loading" && <LoadingState />}
        {!authErrorRoute && state.kind === "error" && (
          <ErrorState
            message={state.message}
            requestId={state.requestId}
            messageKey={state.messageKey}
          />
        )}
        {!authErrorRoute && state.kind === "visitor" && <VisitorState />}
        {!authErrorRoute &&
          state.kind === "authenticated" &&
          state.user.status === "pending" && (
            <AccountState
              title="Your account is pending approval"
              message="An Oloka Video administrator must approve this closed-beta account before product access is available."
              onLogout={logout}
            />
          )}
        {!authErrorRoute &&
          state.kind === "authenticated" &&
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
        {!authErrorRoute &&
          state.kind === "authenticated" &&
          state.user.status === "active" && (
            <ActiveState
              user={state.user}
              getCsrfToken={getCsrfToken}
              onLogout={logout}
            />
          )}
      </div>

      <footer>
        <span>Oloka Video</span>
        <span>Canonical Project lifecycle</span>
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

function ErrorState(props: {
  message: string;
  requestId?: string;
  messageKey?: string;
}) {
  return (
    <Surface className="state-panel error-panel" role="alert">
      <span className="state-symbol">!</span>
      <div>
        <strong>Connection error</strong>
        <p>{props.message}</p>
        {props.requestId !== undefined && (
          <small>
            Support reference: {props.requestId} ({props.messageKey})
          </small>
        )}
      </div>
    </Surface>
  );
}

function AuthErrorState() {
  return (
    <Surface className="account-panel" role="alert">
      <p className="eyebrow">Sign-in status</p>
      <h1>Google sign-in did not complete</h1>
      <p className="hero-copy">
        The sign-in attempt could not be completed safely. No provider details
        are shown here. Please start a new attempt.
      </p>
      <div className="card-heading">
        <a className="primary-action" href="/api/v1/auth/google/start">
          Try again
        </a>
        <a className="secondary-action" href="/">
          Return home
        </a>
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
            Create and organize private video projects. Project metadata stays
            canonical in SQLite and can be restored from trash for 30 days.
          </p>
        </div>
        <button
          className="secondary-action"
          onClick={() => void props.onLogout()}
        >
          Sign out
        </button>
      </section>
      <ProjectWorkspace getCsrfToken={props.getCsrfToken} />
      {props.user.role === "admin" && (
        <AdminApprovalPanel getCsrfToken={props.getCsrfToken} />
      )}
    </div>
  );
}

function ProjectWorkspace(props: { getCsrfToken: () => Promise<string> }) {
  const [projects, setProjects] = useState<Project[] | null>(null);
  const [trash, setTrash] = useState<Project[] | null>(null);
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [versionConflict, setVersionConflict] = useState(false);
  const [busy, setBusy] = useState(false);

  const refresh = useCallback(async () => {
    try {
      const [activeResult, trashResult] = await Promise.all([
        getJson("/api/v1/projects"),
        getJson("/api/v1/trash/projects"),
      ]);
      setProjects(projectListResponseSchema.parse(activeResult).projects);
      setTrash(projectListResponseSchema.parse(trashResult).projects);
      setError(null);
    } catch (reason) {
      setError(
        reason instanceof Error ? reason.message : "Project list failed",
      );
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const runMutation = useCallback(
    async (operation: () => Promise<unknown>) => {
      setBusy(true);
      setVersionConflict(false);
      try {
        await operation();
        await refresh();
        setError(null);
      } catch (reason) {
        if (reason instanceof ApiError && reason.code === "VERSION_CONFLICT") {
          setVersionConflict(true);
          await refresh();
        } else {
          setError(
            reason instanceof Error ? reason.message : "Project action failed",
          );
        }
      } finally {
        setBusy(false);
      }
    },
    [refresh],
  );

  const createProject = async (event: FormEvent) => {
    event.preventDefault();
    await runMutation(async () => {
      projectSchema.parse(
        await mutateJson(
          "/api/v1/projects",
          "POST",
          { name, ...(description.trim() === "" ? {} : { description }) },
          props.getCsrfToken,
        ),
      );
      setName("");
      setDescription("");
    });
  };

  return (
    <section className="project-workspace" aria-labelledby="projects-title">
      <Surface className="project-create-panel">
        <div className="card-heading">
          <div>
            <p className="eyebrow">Project library</p>
            <h2 id="projects-title">Your projects</h2>
          </div>
          <button className="secondary-action" onClick={() => void refresh()}>
            Refresh
          </button>
        </div>
        <form
          className="project-create-form"
          onSubmit={(event) => void createProject(event)}
        >
          <label>
            Project name
            <input
              required
              maxLength={200}
              value={name}
              onChange={(event) => setName(event.target.value)}
              placeholder="Campaign or video name"
            />
          </label>
          <label>
            Description <span>optional</span>
            <textarea
              maxLength={2000}
              value={description}
              onChange={(event) => setDescription(event.target.value)}
              placeholder="A short note about this project"
            />
          </label>
          <button
            className="primary-action"
            disabled={busy || name.trim() === ""}
          >
            Create project
          </button>
        </form>
      </Surface>

      {versionConflict && (
        <p className="inline-notice" role="alert">
          This project changed elsewhere. The latest version is now loaded.
        </p>
      )}
      {error !== null && (
        <p className="inline-error" role="alert">
          {error}
        </p>
      )}
      {projects === null && error === null && (
        <p aria-live="polite">Loading projects…</p>
      )}
      {projects?.length === 0 && (
        <Surface className="project-empty-state">
          <strong>No projects yet</strong>
          <p>
            Create the first canonical project above. No demo data is added.
          </p>
        </Surface>
      )}
      <div className="project-list">
        {projects?.map((project) => (
          <ProjectCard
            key={project.id}
            project={project}
            busy={busy}
            onMutate={runMutation}
            getCsrfToken={props.getCsrfToken}
          />
        ))}
      </div>

      <div className="trash-heading">
        <div>
          <p className="eyebrow">30-day retention</p>
          <h2>Trash</h2>
        </div>
      </div>
      {trash === null && error === null && (
        <p aria-live="polite">Loading trash…</p>
      )}
      {trash?.length === 0 && <p className="trash-empty">Trash is empty</p>}
      <div className="project-list trash-list">
        {trash?.map((project) => (
          <Surface className="project-card" key={project.id}>
            <div>
              <span className="project-status">Soft deleted</span>
              <h3>{project.name}</h3>
              <p>{project.description ?? "No description"}</p>
            </div>
            <button
              className="secondary-action"
              disabled={busy}
              onClick={() =>
                void runMutation(() =>
                  mutateJson(
                    `/api/v1/projects/${project.id}/restore`,
                    "POST",
                    { expectedVersion: project.version },
                    props.getCsrfToken,
                  ),
                )
              }
            >
              Restore
            </button>
          </Surface>
        ))}
      </div>
    </section>
  );
}

function ProjectCard(props: {
  project: Project;
  busy: boolean;
  getCsrfToken: () => Promise<string>;
  onMutate: (operation: () => Promise<unknown>) => Promise<void>;
}) {
  const [editing, setEditing] = useState(false);
  const [name, setName] = useState(props.project.name);
  const [description, setDescription] = useState(
    props.project.description ?? "",
  );

  useEffect(() => {
    setName(props.project.name);
    setDescription(props.project.description ?? "");
  }, [props.project]);

  const update = (body: Record<string, unknown>) =>
    props.onMutate(() =>
      mutateJson(
        `/api/v1/projects/${props.project.id}`,
        "PATCH",
        { ...body, expectedVersion: props.project.version },
        props.getCsrfToken,
      ),
    );

  return (
    <Surface className="project-card">
      {editing ? (
        <form
          className="project-edit-form"
          onSubmit={(event) => {
            event.preventDefault();
            void update({
              name,
              description: description.trim() === "" ? null : description,
            }).then(() => setEditing(false));
          }}
        >
          <label>
            Name
            <input
              required
              maxLength={200}
              value={name}
              onChange={(event) => setName(event.target.value)}
            />
          </label>
          <label>
            Description
            <textarea
              maxLength={2000}
              value={description}
              onChange={(event) => setDescription(event.target.value)}
            />
          </label>
          <div className="project-actions">
            <button className="primary-action" disabled={props.busy}>
              Save
            </button>
            <button
              type="button"
              className="secondary-action"
              onClick={() => setEditing(false)}
            >
              Cancel
            </button>
          </div>
        </form>
      ) : (
        <>
          <div>
            <span className="project-status">
              {props.project.favorite ? "Favorite" : "Active"}
            </span>
            <h3>{props.project.name}</h3>
            <p>{props.project.description ?? "No description"}</p>
            <small>Version {props.project.version}</small>
          </div>
          <div className="project-actions">
            <button
              className="secondary-action"
              disabled={props.busy}
              onClick={() => void update({ favorite: !props.project.favorite })}
            >
              {props.project.favorite ? "Unfavorite" : "Favorite"}
            </button>
            <button
              className="secondary-action"
              disabled={props.busy}
              onClick={() => setEditing(true)}
            >
              Edit
            </button>
            <button
              className="danger-action"
              disabled={props.busy}
              onClick={() =>
                void props.onMutate(() =>
                  mutateJson(
                    `/api/v1/projects/${props.project.id}`,
                    "DELETE",
                    { expectedVersion: props.project.version },
                    props.getCsrfToken,
                  ),
                )
              }
            >
              Move to trash
            </button>
          </div>
        </>
      )}
    </Surface>
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
