import type { Clock } from "../kernel/clock.js";
import type { PreviewArtifactMaintenanceService } from "./preview-artifact-maintenance-service.js";

const DEFAULT_PREVIEW_MAINTENANCE_SHUTDOWN_GRACE_MS = 5_000;

export class PreviewMaintenanceShutdownTimeoutError extends Error {
  readonly activePass = true;

  constructor(
    readonly graceMs: number,
    private readonly settlement: Promise<void>,
  ) {
    super("Preview maintenance did not settle within shutdown grace");
    this.name = "PreviewMaintenanceShutdownTimeoutError";
  }

  waitForSettlement(): Promise<void> {
    return this.settlement;
  }
}

export interface PreviewArtifactMaintenanceRuntimeOptions {
  pollIntervalMs: number;
  clock: Clock;
  shutdownGraceMs?: number;
  onError?: (error: unknown) => void;
  onShutdownTimeout?: (event: { graceMs: number; activePass: true }) => void;
}

export class PreviewArtifactMaintenanceRuntime {
  private timer: NodeJS.Timeout | undefined;
  private inFlight: Promise<void> | undefined;
  private stopping = false;
  private stopPromise: Promise<void> | undefined;

  constructor(
    private readonly service: Pick<PreviewArtifactMaintenanceService, "run">,
    private readonly options: PreviewArtifactMaintenanceRuntimeOptions,
  ) {
    if (options.pollIntervalMs < 1)
      throw new Error("Preview maintenance poll interval must be positive");
  }

  async start(): Promise<void> {
    if (
      this.stopping ||
      this.timer !== undefined ||
      this.inFlight !== undefined
    )
      return;
    await this.runOnce();
    this.schedule();
  }

  runOnce(): Promise<void> {
    if (this.stopping) return Promise.resolve();
    if (this.inFlight !== undefined) return this.inFlight;
    const pass = this.pump();
    this.inFlight = pass;
    void pass.finally(() => {
      if (this.inFlight === pass) this.inFlight = undefined;
    });
    return pass;
  }

  stop(): Promise<void> {
    if (this.stopPromise !== undefined) return this.stopPromise;
    this.stopping = true;
    if (this.timer !== undefined) clearInterval(this.timer);
    this.timer = undefined;
    this.stopPromise = this.settleActivePass();
    return this.stopPromise;
  }

  private async settleActivePass(): Promise<void> {
    const inFlight = this.inFlight;
    if (inFlight === undefined) return;
    const graceMs =
      this.options.shutdownGraceMs ??
      DEFAULT_PREVIEW_MAINTENANCE_SHUTDOWN_GRACE_MS;
    let timeout: NodeJS.Timeout | undefined;
    const settled = await Promise.race([
      inFlight.then(() => true),
      new Promise<false>((resolve) => {
        timeout = setTimeout(() => resolve(false), graceMs);
        timeout.unref();
      }),
    ]).finally(() => {
      if (timeout !== undefined) clearTimeout(timeout);
    });
    if (!settled) {
      const error = new PreviewMaintenanceShutdownTimeoutError(
        graceMs,
        inFlight,
      );
      this.options.onShutdownTimeout?.({ graceMs, activePass: true });
      throw error;
    }
  }

  private schedule(): void {
    if (this.stopping || this.timer !== undefined) return;
    this.timer = setInterval(() => {
      void this.runOnce();
    }, this.options.pollIntervalMs);
    this.timer.unref();
  }

  private async pump(): Promise<void> {
    try {
      await this.service.run(this.options.clock.now());
    } catch (error) {
      this.options.onError?.(error);
    }
  }
}
