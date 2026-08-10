import type { OutboxConsumer } from "./consumer.js";

export interface OutboxRuntimeOptions {
  pollIntervalMs: number;
  onError?: (error: unknown) => void;
}

export class OutboxRuntime {
  private timer: NodeJS.Timeout | undefined;
  private inFlight: Promise<void> | undefined;
  private stopping = false;

  constructor(
    private readonly consumer: OutboxConsumer,
    private readonly options: OutboxRuntimeOptions,
  ) {
    if (options.pollIntervalMs < 1)
      throw new Error("Outbox poll interval must be positive");
  }

  async start(): Promise<void> {
    if (
      this.stopping ||
      this.timer !== undefined ||
      this.inFlight !== undefined
    )
      return;
    const inFlight = this.pump();
    this.inFlight = inFlight;
    await inFlight;
    if (this.inFlight === inFlight) this.inFlight = undefined;
    this.schedule();
  }

  async stop(): Promise<void> {
    this.stopping = true;
    if (this.timer !== undefined) clearTimeout(this.timer);
    this.timer = undefined;
    this.consumer.shutdown();
    await this.inFlight;
  }

  private schedule(): void {
    if (this.stopping) return;
    this.timer = setTimeout(() => {
      this.timer = undefined;
      this.inFlight = this.pump();
      void this.inFlight.finally(() => {
        this.inFlight = undefined;
        this.schedule();
      });
    }, this.options.pollIntervalMs);
    this.timer.unref();
  }

  private async pump(): Promise<void> {
    try {
      await this.consumer.runOnce();
    } catch (error) {
      this.options.onError?.(error);
    }
  }
}
