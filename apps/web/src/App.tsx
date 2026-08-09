import {
  adminUsersResponseSchema,
  assetListResponseSchema,
  assetSchema,
  authSessionResponseSchema,
  csrfResponseSchema,
  errorEnvelopeSchema,
  jobEventHistoryResponseSchema,
  jobListResponseSchema,
  jobSchema,
  projectListResponseSchema,
  projectSchema,
  uploadSessionSchema,
  type Asset,
  type IdentityUser,
  type Job,
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
      <JobActivity getCsrfToken={props.getCsrfToken} />
      {props.user.role === "admin" && (
        <AdminApprovalPanel getCsrfToken={props.getCsrfToken} />
      )}
    </div>
  );
}

function JobActivity(props: { getCsrfToken: () => Promise<string> }) {
  const [jobs, setJobs] = useState<Job[] | null>(null);
  const [history, setHistory] = useState<Record<string, string[]>>({});
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      const result = jobListResponseSchema.parse(
        await getJson("/api/v1/jobs?limit=10"),
      );
      setJobs(result.jobs);
      setError(null);
    } catch (reason) {
      setError(
        reason instanceof Error ? reason.message : "Job activity failed",
      );
    }
  }, []);

  useEffect(() => {
    void refresh();
    const poll = window.setInterval(() => void refresh(), 5_000);
    return () => window.clearInterval(poll);
  }, [refresh]);

  useEffect(() => {
    const streams = (jobs ?? [])
      .filter(
        (job) => !["completed", "failed", "cancelled"].includes(job.status),
      )
      .map((job) => {
        const stream = new EventSource(`/api/v1/jobs/${job.id}/events`);
        stream.onmessage = () => void refresh();
        stream.addEventListener("job.progress", () => void refresh());
        stream.addEventListener("job.succeeded", () => void refresh());
        stream.addEventListener("job.failed", () => void refresh());
        stream.addEventListener("job.cancelled", () => void refresh());
        return stream;
      });
    return () => streams.forEach((stream) => stream.close());
  }, [jobs, refresh]);

  const cancel = async (job: Job) => {
    try {
      jobSchema.parse(
        await mutateJson(
          `/api/v1/jobs/${job.id}/cancel`,
          "POST",
          { expectedVersion: job.version },
          props.getCsrfToken,
        ),
      );
      await refresh();
    } catch (reason) {
      setError(
        reason instanceof Error ? reason.message : "Job cancellation failed",
      );
    }
  };

  const loadHistory = async (job: Job) => {
    try {
      const result = jobEventHistoryResponseSchema.parse(
        await getJson(`/api/v1/jobs/${job.id}/event-history?limit=20`),
      );
      setHistory((current) => ({
        ...current,
        [job.id]: result.events.map(
          (event) => `${event.sequence}. ${event.type}`,
        ),
      }));
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Job history failed");
    }
  };

  return (
    <Surface className="job-activity" aria-labelledby="job-activity-title">
      <div className="card-heading">
        <div>
          <p className="eyebrow">Durable activity</p>
          <h2 id="job-activity-title">Recent jobs</h2>
        </div>
        <button className="secondary-action" onClick={() => void refresh()}>
          Refresh
        </button>
      </div>
      {error !== null && (
        <p className="inline-error" role="alert">
          {error}
        </p>
      )}
      {jobs === null && error === null && <p>Loading durable Job state…</p>}
      {jobs?.length === 0 && <p>No jobs admitted yet.</p>}
      <div className="job-list">
        {jobs?.map((job) => (
          <article className="job-row" key={job.id}>
            <div>
              <strong>{job.type.replaceAll("_", " ")}</strong>
              <span>
                {job.status} · attempt {job.attemptCount}
              </span>
              <small>{job.currentStepKey ?? "No active step"}</small>
            </div>
            <div
              className="job-progress"
              aria-label={`${job.progressBasisPoints / 100}% complete`}
            >
              <span style={{ width: `${job.progressBasisPoints / 100}%` }} />
            </div>
            <b>{(job.progressBasisPoints / 100).toFixed(0)}%</b>
            <button
              className="secondary-action"
              onClick={() => void loadHistory(job)}
            >
              History
            </button>
            {[
              "queued",
              "running",
              "waiting_provider",
              "retry_scheduled",
            ].includes(job.status) && (
              <button
                className="danger-action"
                onClick={() => void cancel(job)}
              >
                Cancel
              </button>
            )}
            {history[job.id] !== undefined && (
              <ol className="job-history">
                {history[job.id]?.map((event) => (
                  <li key={event}>{event}</li>
                ))}
              </ol>
            )}
          </article>
        ))}
      </div>
    </Surface>
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
    <div className="project-with-assets">
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
                onClick={() =>
                  void update({ favorite: !props.project.favorite })
                }
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
      {!editing && (
        <AssetWorkspace
          project={props.project}
          getCsrfToken={props.getCsrfToken}
        />
      )}
    </div>
  );
}

function AssetWorkspace(props: {
  project: Project;
  getCsrfToken: () => Promise<string>;
}) {
  const [assets, setAssets] = useState<Asset[] | null>(null);
  const [search, setSearch] = useState("");
  const [progress, setProgress] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const refresh = useCallback(async () => {
    const query =
      search.trim() === "" ? "" : `?search=${encodeURIComponent(search)}`;
    try {
      const result = assetListResponseSchema.parse(
        await getJson(`/api/v1/projects/${props.project.id}/assets${query}`),
      );
      setAssets(result.assets);
      setError(null);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Asset list failed");
    }
  }, [props.project.id, search]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const upload = async (file: File) => {
    setBusy(true);
    setProgress(0);
    setError(null);
    try {
      const resumeKey = `oloka-upload:${props.project.id}:${file.name}:${file.size}`;
      let uploadId = localStorage.getItem(resumeKey);
      let assetId: string | undefined;
      if (uploadId === null) {
        const initialized = (await mutateJson(
          `/api/v1/projects/${props.project.id}/uploads`,
          "POST",
          {
            originalFilename: file.name,
            kind: inferAssetKind(file),
            ...(file.type === "" ? {} : { declaredMime: file.type }),
            declaredSize: file.size,
          },
          props.getCsrfToken,
        )) as { asset: unknown; upload: unknown };
        assetId = assetSchema.parse(initialized.asset).id;
        uploadId = uploadSessionSchema.parse(initialized.upload).uploadId;
        localStorage.setItem(resumeKey, uploadId);
      }
      const head = await fetch(`/api/v1/uploads/${uploadId}`, {
        method: "HEAD",
      });
      if (!head.ok) throw new Error(`Upload status returned ${head.status}`);
      let offset = Number(head.headers.get("upload-offset") ?? "0");
      const chunkSize = Math.min(
        8 * 1024 * 1024,
        Number(head.headers.get("upload-chunk-size") ?? 8 * 1024 * 1024),
      );
      while (offset < file.size) {
        const bytes = new Uint8Array(
          await file.slice(offset, offset + chunkSize).arrayBuffer(),
        );
        const response = await fetch(`/api/v1/uploads/${uploadId}`, {
          method: "PATCH",
          headers: {
            "content-type": "application/offset+octet-stream",
            "upload-offset": String(offset),
            "upload-chunk-sha256": await sha256Hex(bytes),
            "x-oloka-csrf": await props.getCsrfToken(),
          },
          body: bytes,
        });
        if (!response.ok) throw await apiError(response);
        offset = Number(
          response.headers.get("upload-offset") ?? offset + bytes.byteLength,
        );
        setProgress(Math.round((offset / file.size) * 100));
      }
      const completed = assetSchema
        .extend({ job: jobSchema.optional() })
        .parse(
          await mutateJson(
            `/api/v1/uploads/${uploadId}/complete`,
            "POST",
            {},
            props.getCsrfToken,
          ),
        );
      assetId ??= completed.id;
      localStorage.removeItem(resumeKey);
      setProgress(100);
      await refresh();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Upload failed");
    } finally {
      setBusy(false);
    }
  };

  const removeAsset = async (asset: Asset) => {
    setBusy(true);
    try {
      await mutateJson(
        `/api/v1/assets/${asset.id}`,
        "DELETE",
        { expectedVersion: asset.version },
        props.getCsrfToken,
      );
      await refresh();
    } catch (reason) {
      setError(
        reason instanceof Error ? reason.message : "Asset delete failed",
      );
    } finally {
      setBusy(false);
    }
  };

  return (
    <Surface className="asset-workspace">
      <div className="asset-toolbar">
        <div>
          <p className="eyebrow">Private media</p>
          <h4>Assets</h4>
        </div>
        <label className="upload-button">
          Upload file
          <input
            type="file"
            disabled={busy}
            onChange={(event) => {
              const file = event.target.files?.[0];
              if (file !== undefined) void upload(file);
              event.currentTarget.value = "";
            }}
          />
        </label>
      </div>
      <div className="asset-search-row">
        <input
          value={search}
          onChange={(event) => setSearch(event.target.value)}
          placeholder="Search original filename"
          aria-label={`Search assets in ${props.project.name}`}
        />
        <button className="secondary-action" onClick={() => void refresh()}>
          Search
        </button>
      </div>
      {progress !== null && progress < 100 && (
        <div className="upload-progress" aria-live="polite">
          <span style={{ width: `${progress}%` }} />
          <small>{progress}% uploaded</small>
        </div>
      )}
      {error !== null && <p className="inline-error">{error}</p>}
      {assets === null && error === null && <p>Loading assets…</p>}
      {assets?.length === 0 && (
        <p className="asset-empty">No private media yet.</p>
      )}
      <div className="asset-grid">
        {assets?.map((asset) => (
          <AssetCard
            key={asset.id}
            asset={asset}
            busy={busy}
            onDelete={() => void removeAsset(asset)}
          />
        ))}
      </div>
    </Surface>
  );
}

function AssetCard(props: {
  asset: Asset;
  busy: boolean;
  onDelete: () => void;
}) {
  const contentUrl = `/api/v1/assets/${props.asset.id}/content`;
  return (
    <article className="asset-card">
      <div className="asset-preview">
        {props.asset.ingestionStatus === "ready" &&
          props.asset.kind === "image" && (
            <img
              src={contentUrl}
              alt={props.asset.originalFilename}
              loading="lazy"
            />
          )}
        {props.asset.ingestionStatus === "ready" &&
          props.asset.kind === "video" && (
            <video controls preload="metadata" src={contentUrl} />
          )}
        {props.asset.ingestionStatus === "ready" &&
          props.asset.kind === "audio" && (
            <audio controls preload="metadata" src={contentUrl} />
          )}
        {(props.asset.kind === "font" ||
          props.asset.ingestionStatus !== "ready") && (
          <span>{props.asset.ingestionStatus}</span>
        )}
      </div>
      <strong title={props.asset.originalFilename}>
        {props.asset.originalFilename}
      </strong>
      <small>
        {props.asset.kind} · {formatBytes(props.asset.byteSize)} ·{" "}
        {props.asset.ingestionStatus}
      </small>
      <div className="asset-actions">
        {props.asset.ingestionStatus === "ready" && (
          <a
            className="secondary-action"
            href={contentUrl}
            download={props.asset.originalFilename}
          >
            Download
          </a>
        )}
        <button
          className="danger-action"
          disabled={props.busy}
          onClick={props.onDelete}
        >
          Delete
        </button>
      </div>
    </article>
  );
}

function inferAssetKind(file: File): "image" | "video" | "audio" | "font" {
  if (file.type.startsWith("image/")) return "image";
  if (file.type.startsWith("video/")) return "video";
  if (file.type.startsWith("audio/")) return "audio";
  return "font";
}

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  const digest = await crypto.subtle.digest("SHA-256", copy.buffer);
  return Array.from(new Uint8Array(digest), (value) =>
    value.toString(16).padStart(2, "0"),
  ).join("");
}

async function apiError(response: Response): Promise<ApiError> {
  const envelope = errorEnvelopeSchema.parse(await response.json());
  return new ApiError(
    envelope.error.code,
    envelope.error.messageKey,
    envelope.error.suggestedAction,
    envelope.error.requestId,
  );
}

function formatBytes(value: number | null): string {
  if (value === null) return "pending";
  if (value < 1024) return `${value} B`;
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KB`;
  return `${(value / (1024 * 1024)).toFixed(1)} MB`;
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
