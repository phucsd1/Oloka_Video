import { describe, expect, it, vi } from "vitest";
import type { OutboxConsumer } from "./consumer.js";
import { OutboxRuntime } from "./runtime.js";

describe("OutboxRuntime", () => {
  it("does not overlap concurrent startup passes", async () => {
    let release: (() => void) | undefined;
    let active = 0;
    let maximumActive = 0;
    const runOnce = vi.fn(async () => {
      active += 1;
      maximumActive = Math.max(maximumActive, active);
      await new Promise<void>((resolve) => {
        release = resolve;
      });
      active -= 1;
      return 0;
    });
    const consumer = {
      runOnce,
      shutdown: vi.fn(),
    } as unknown as OutboxConsumer;
    const runtime = new OutboxRuntime(consumer, { pollIntervalMs: 1_000 });

    const firstStart = runtime.start();
    const secondStart = runtime.start();
    await vi.waitFor(() => expect(runOnce).toHaveBeenCalled());

    expect(runOnce).toHaveBeenCalledTimes(1);
    expect(maximumActive).toBe(1);

    release?.();
    await Promise.all([firstStart, secondStart]);
    await runtime.stop();
  });
});
