import type { TransactionRunner } from "../database/database.js";
import type { Clock } from "../kernel/clock.js";
import type { JobHandlerRegistry } from "./job-handler-registry.js";
import type { JobRepository } from "./job-repository.js";

export const DEFAULT_DISPATCHER_OPTIONS = {
  pollIntervalMs: 750,
  jitterMaxMs: 250,
  leaseDurationMs: 60_000,
  heartbeatIntervalMs: 20_000,
  reconcileIntervalMs: 30_000,
  capacity: 1,
} as const;

export interface DurableJobDispatcherOptions {
  transactions: TransactionRunner;
  repository: JobRepository;
  handlers: JobHandlerRegistry;
  clock: Clock;
  workerId: string;
  pollIntervalMs?: number;
  jitterMaxMs?: number;
  leaseDurationMs?: number;
  capacity?: number;
  reconcileIntervalMs?: number;
  heartbeatIntervalMs?: number;
  shutdownGraceMs?: number;
  random?: () => number;
}

export class DurableJobDispatcher {
  private readonly pollIntervalMs: number;
  private readonly jitterMaxMs: number;
  private readonly leaseDurationMs: number;
  private readonly capacity: number;
  private readonly heartbeatIntervalMs: number;
  private readonly random: () => number;
  private readonly reconcileIntervalMs: number;
  private readonly shutdownGraceMs: number;
  private timer: NodeJS.Timeout | undefined;
  private reconcileTimer: NodeJS.Timeout | undefined;
  private readonly heartbeatTimers = new Set<NodeJS.Timeout>();
  private stopping = false;
  private active = 0;

  constructor(private readonly options: DurableJobDispatcherOptions) {
    this.pollIntervalMs =
      options.pollIntervalMs ?? DEFAULT_DISPATCHER_OPTIONS.pollIntervalMs;
    this.jitterMaxMs =
      options.jitterMaxMs ?? DEFAULT_DISPATCHER_OPTIONS.jitterMaxMs;
    this.leaseDurationMs =
      options.leaseDurationMs ?? DEFAULT_DISPATCHER_OPTIONS.leaseDurationMs;
    this.capacity = options.capacity ?? DEFAULT_DISPATCHER_OPTIONS.capacity;
    this.heartbeatIntervalMs =
      options.heartbeatIntervalMs ??
      DEFAULT_DISPATCHER_OPTIONS.heartbeatIntervalMs;
    this.reconcileIntervalMs =
      options.reconcileIntervalMs ??
      DEFAULT_DISPATCHER_OPTIONS.reconcileIntervalMs;
    this.shutdownGraceMs = options.shutdownGraceMs ?? 5_000;
    this.random = options.random ?? Math.random;
  }

  start(): void {
    if (this.timer !== undefined || this.stopping) return;
    this.schedule(0);
    this.reconcileTimer = setInterval(() => {
      this.reconcileOnce();
    }, this.reconcileIntervalMs);
    this.reconcileTimer.unref();
  }

  async stop(): Promise<void> {
    this.stopping = true;
    if (this.timer !== undefined) clearTimeout(this.timer);
    this.timer = undefined;
    if (this.reconcileTimer !== undefined) clearInterval(this.reconcileTimer);
    this.reconcileTimer = undefined;
    for (const heartbeatTimer of this.heartbeatTimers)
      clearInterval(heartbeatTimer);
    this.heartbeatTimers.clear();
    const deadline = Date.now() + this.shutdownGraceMs;
    while (this.active > 0 && Date.now() < deadline) {
      await new Promise<void>((resolve) => setTimeout(resolve, 10));
    }
  }

  async runOnce(): Promise<boolean> {
    if (this.stopping || this.active >= this.capacity) return false;
    const cleanup = this.options.transactions.run("immediate", (context) =>
      this.options.repository.claimCancellationCleanup(context, {
        leaseOwner: this.options.workerId,
        now: this.options.clock.now(),
        leaseDurationMs: this.leaseDurationMs,
      }),
    );
    if (cleanup !== null) {
      this.active += 1;
      try {
        this.options.transactions.run("immediate", (context) =>
          this.options.repository.completeCancellationCleanup(context, {
            jobId: cleanup.jobId,
            leaseOwner: cleanup.leaseOwner,
            expectedJobVersion: cleanup.jobVersion,
            now: this.options.clock.now(),
          }),
        );
      } finally {
        this.active -= 1;
      }
      return true;
    }
    const claim = this.options.transactions.run("immediate", (context) =>
      this.options.repository.claimNext(context, {
        leaseOwner: this.options.workerId,
        now: this.options.clock.now(),
        leaseDurationMs: this.leaseDurationMs,
      }),
    );
    if (claim === null) return false;
    const handler = this.options.handlers.get(claim.type);
    if (handler === undefined)
      throw new Error(`No enabled handler for Job type ${claim.type}`);
    this.active += 1;
    claim.heartbeat = () => {
      if (this.stopping) return;
      try {
        const heartbeat = this.options.transactions.run(
          "immediate",
          (context) =>
            this.options.repository.heartbeat(context, {
              jobId: claim.jobId,
              stepId: claim.stepId,
              leaseOwner: claim.leaseOwner,
              expectedJobVersion: claim.jobVersion,
              expectedStepVersion: claim.stepVersion,
              now: this.options.clock.now(),
              leaseDurationMs: this.leaseDurationMs,
            }),
        );
        claim.jobVersion = heartbeat.jobVersion;
        claim.stepVersion = heartbeat.stepVersion;
        claim.leaseExpiresAt = heartbeat.leaseExpiresAt;
      } catch {
        // The guarded result transaction remains authoritative after lease loss.
      }
    };
    const heartbeatTimer = setInterval(
      () => claim.heartbeat?.(),
      this.heartbeatIntervalMs,
    );
    this.heartbeatTimers.add(heartbeatTimer);
    heartbeatTimer.unref();
    try {
      await handler.handle(claim);
    } finally {
      clearInterval(heartbeatTimer);
      this.heartbeatTimers.delete(heartbeatTimer);
      claim.heartbeat = undefined;
      this.active -= 1;
    }
    return true;
  }

  reconcileOnce(): void {
    if (this.stopping) return;
    this.options.transactions.run("immediate", (context) =>
      this.options.repository.reconcile(context, this.options.clock.now()),
    );
  }

  snapshot(): { active: number; capacity: number; stopping: boolean } {
    return {
      active: this.active,
      capacity: this.capacity,
      stopping: this.stopping,
    };
  }

  private schedule(delayMs: number): void {
    this.timer = setTimeout(() => {
      this.timer = undefined;
      void this.tick();
    }, delayMs);
    this.timer.unref();
  }

  private async tick(): Promise<void> {
    if (this.stopping) return;
    try {
      await this.runOnce();
    } finally {
      if (!this.stopping) {
        const jitter = Math.floor(this.random() * (this.jitterMaxMs + 1));
        this.schedule(this.pollIntervalMs + jitter);
      }
    }
  }
}
