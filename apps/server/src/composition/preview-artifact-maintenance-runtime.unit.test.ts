import { afterEach, describe, expect, it, vi } from "vitest";
import { PreviewArtifactMaintenanceRuntime } from "./preview-artifact-maintenance-runtime.js";

afterEach(() => {
  vi.useRealTimers();
});

describe("PreviewArtifactMaintenanceRuntime", () => {
  it("serializes repeated timer ticks and stops future passes", async () => {
    vi.useFakeTimers();
    let calls = 0;
    let active = 0;
    let maximumActive = 0;
    let releaseSlowPass: (() => void) | undefined;
    const slowPass = new Promise<void>((resolve) => {
      releaseSlowPass = resolve;
    });
    const service = {
      run: vi.fn(async () => {
        calls += 1;
        active += 1;
        maximumActive = Math.max(maximumActive, active);
        if (calls === 2) await slowPass;
        active -= 1;
        return { scheduled: 0, purged: 0, failed: 0 };
      }),
    };
    const runtime = new PreviewArtifactMaintenanceRuntime(service, {
      pollIntervalMs: 10,
      clock: { now: () => 1_700_000_000_000 },
    });

    await runtime.start();
    await vi.advanceTimersByTimeAsync(10);
    await vi.waitFor(() => expect(service.run).toHaveBeenCalledTimes(2));
    await vi.advanceTimersByTimeAsync(50);

    expect(service.run).toHaveBeenCalledTimes(2);
    expect(maximumActive).toBe(1);

    releaseSlowPass?.();
    await vi.advanceTimersByTimeAsync(0);
    await runtime.stop();
    await vi.advanceTimersByTimeAsync(100);
    expect(service.run).toHaveBeenCalledTimes(2);
  });

  it("waits for an active pass during stop and stops immediately when idle", async () => {
    let release: (() => void) | undefined;
    let active = 0;
    const service = {
      run: vi.fn(async () => {
        active += 1;
        await new Promise<void>((resolve) => {
          release = resolve;
        });
        active -= 1;
        return { scheduled: 0, purged: 0, failed: 0 };
      }),
    };
    const runtime = new PreviewArtifactMaintenanceRuntime(service, {
      pollIntervalMs: 1_000,
      clock: { now: () => 1_700_000_000_000 },
    });
    const start = runtime.start();
    await vi.waitFor(() => expect(active).toBe(1));

    let stopped = false;
    const stop = runtime.stop().then(() => {
      stopped = true;
    });
    await Promise.resolve();
    expect(stopped).toBe(false);
    expect(service.run).toHaveBeenCalledTimes(1);

    release?.();
    await Promise.all([start, stop]);
    expect(active).toBe(0);
    expect(stopped).toBe(true);
    await runtime.stop();
  });

  it("stops while idle without starting a maintenance pass", async () => {
    const service = { run: vi.fn() };
    const runtime = new PreviewArtifactMaintenanceRuntime(service, {
      pollIntervalMs: 10,
      clock: { now: () => 1_700_000_000_000 },
    });

    await runtime.stop();
    expect(service.run).not.toHaveBeenCalled();
    await runtime.start();
    expect(service.run).not.toHaveBeenCalled();
  });

  it("bounds shutdown without pretending a blocked pass settled", async () => {
    vi.useFakeTimers();
    const service = {
      run: vi.fn(() => new Promise<never>(() => undefined)),
    };
    const onShutdownTimeout = vi.fn();
    const runtime = new PreviewArtifactMaintenanceRuntime(service, {
      pollIntervalMs: 10,
      shutdownGraceMs: 25,
      clock: { now: () => 1_700_000_000_000 },
      onShutdownTimeout,
    });
    void runtime.start();
    await vi.waitFor(() => expect(service.run).toHaveBeenCalledTimes(1));

    const stopExpectation = runtime.stop();
    await vi.advanceTimersByTimeAsync(25);
    await stopExpectation;
    expect(onShutdownTimeout).toHaveBeenCalledTimes(1);
    expect(service.run).toHaveBeenCalledTimes(1);
  });
});
