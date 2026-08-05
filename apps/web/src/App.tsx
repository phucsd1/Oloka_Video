import {
  healthResponseSchema,
  readyResponseSchema,
  versionResponseSchema,
  type ReadyResponse,
  type VersionResponse,
} from "@oloka/contracts";
import {
  DefinitionRow,
  StatusPill,
  Surface,
  type StatusTone,
} from "@oloka/design-system";
import { useEffect, useState } from "react";

type DashboardState =
  | { kind: "loading" }
  | { kind: "connected"; ready: ReadyResponse; version: VersionResponse }
  | { kind: "error"; message: string };

async function getJson(path: string): Promise<unknown> {
  const response = await fetch(path, {
    headers: { accept: "application/json" },
  });
  if (!response.ok) throw new Error(`${path} returned ${response.status}`);
  return response.json();
}

async function loadSystemState(): Promise<
  Extract<DashboardState, { kind: "connected" }>
> {
  const [healthData, readyData, versionData] = await Promise.all([
    getJson("/api/health"),
    getJson("/api/ready"),
    getJson("/api/version"),
  ]);
  healthResponseSchema.parse(healthData);
  return {
    kind: "connected",
    ready: readyResponseSchema.parse(readyData),
    version: versionResponseSchema.parse(versionData),
  };
}

function ReadinessBadge({ value }: { value: "ready" | "not_ready" }) {
  return (
    <StatusPill tone={value === "ready" ? "success" : "danger"}>
      {value === "ready" ? "Ready" : "Not ready"}
    </StatusPill>
  );
}

export function App() {
  const [state, setState] = useState<DashboardState>({ kind: "loading" });

  useEffect(() => {
    let active = true;
    loadSystemState()
      .then((result) => active && setState(result))
      .catch((error: unknown) => {
        if (active)
          setState({
            kind: "error",
            message:
              error instanceof Error
                ? error.message
                : "Unknown connection error",
          });
      });
    return () => {
      active = false;
    };
  }, []);

  const connectionTone: StatusTone =
    state.kind === "connected"
      ? "success"
      : state.kind === "error"
        ? "danger"
        : "neutral";
  const connectionLabel =
    state.kind === "connected"
      ? "Connected"
      : state.kind === "error"
        ? "Connection error"
        : "Connecting";

  return (
    <main className="page-shell">
      <header className="topbar">
        <a className="brand" href="/" aria-label="Oloka Video home">
          <span className="brand-mark">O</span>
          <span>Oloka Video</span>
        </a>
        <span className="environment-label">Online foundation</span>
      </header>

      <div className="content">
        <section className="hero" aria-labelledby="page-title">
          <div>
            <p className="eyebrow">System overview</p>
            <h1 id="page-title">A dependable start for every frame.</h1>
            <p className="hero-copy">
              Live infrastructure status for the Oloka Video development
              environment.
            </p>
          </div>
          <StatusPill tone={connectionTone}>{connectionLabel}</StatusPill>
        </section>

        {state.kind === "loading" && (
          <Surface
            className="state-panel loading-panel"
            aria-live="polite"
            aria-busy="true"
          >
            <span className="loading-line" />
            <div>
              <strong>Connecting to Oloka Video</strong>
              <p>Checking the API and persistent services.</p>
            </div>
          </Surface>
        )}

        {state.kind === "error" && (
          <Surface className="state-panel error-panel" role="alert">
            <span className="state-symbol">!</span>
            <div>
              <strong>We could not reach the foundation services.</strong>
              <p>{state.message}</p>
            </div>
          </Surface>
        )}

        {state.kind === "connected" && (
          <div className="dashboard-grid">
            <Surface className="status-card">
              <div className="card-heading">
                <div>
                  <p className="eyebrow">Runtime</p>
                  <h2>Service health</h2>
                </div>
                <StatusPill tone="success">API online</StatusPill>
              </div>
              <dl>
                <DefinitionRow
                  label="Database"
                  value={
                    <ReadinessBadge
                      value={state.ready.checks.database.status}
                    />
                  }
                />
                <DefinitionRow
                  label="Persistent storage"
                  value={
                    <ReadinessBadge value={state.ready.checks.storage.status} />
                  }
                />
                <DefinitionRow
                  label="Configuration"
                  value={
                    <ReadinessBadge
                      value={state.ready.checks.configuration.status}
                    />
                  }
                />
              </dl>
            </Surface>

            <Surface className="status-card build-card">
              <div className="card-heading">
                <div>
                  <p className="eyebrow">Release</p>
                  <h2>Build identity</h2>
                </div>
                <span className="version-chip">v{state.version.version}</span>
              </div>
              <dl>
                <DefinitionRow
                  label="Application version"
                  value={state.version.version}
                />
                <DefinitionRow
                  label="Git commit"
                  value={<code>{state.version.gitCommitSha}</code>}
                />
                <DefinitionRow
                  label="Environment"
                  value={state.version.environment}
                />
                <DefinitionRow
                  label="Built"
                  value={state.version.buildTimestamp}
                />
              </dl>
            </Surface>
          </div>
        )}
      </div>

      <footer>
        <span>Oloka Video</span>
        <span>Foundation status updates on every load.</span>
      </footer>
    </main>
  );
}
