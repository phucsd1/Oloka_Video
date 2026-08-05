import type { Clock } from "../kernel/clock.js";
import type { TransactionRunner } from "../database/database.js";
import {
  type ClaimedOutboxEvent,
  OutboxRepository,
} from "../database/repositories/outbox-repository.js";

export type OutboxHandler = (event: ClaimedOutboxEvent) => Promise<void>;

export interface OutboxConsumerOptions {
  leaseOwner: string;
  batchSize: number;
  concurrency: number;
  leaseDurationMs: number;
  maxAttempts: number;
  retryDelayMs: (attempt: number) => number;
}

export class OutboxHandlerRegistry {
  private readonly handlers = new Map<string, OutboxHandler>();

  register(topic: string, handler: OutboxHandler): void {
    if (this.handlers.has(topic))
      throw new Error("Outbox topic is already registered");
    this.handlers.set(topic, handler);
  }

  get(topic: string): OutboxHandler | undefined {
    return this.handlers.get(topic);
  }
}

export class OutboxConsumer {
  private stopping = false;

  constructor(
    private readonly transactions: TransactionRunner,
    private readonly repository: OutboxRepository,
    private readonly registry: OutboxHandlerRegistry,
    private readonly clock: Clock,
    private readonly options: OutboxConsumerOptions,
  ) {
    if (options.concurrency < 1 || options.batchSize < 1) {
      throw new Error("Outbox batch size and concurrency must be positive");
    }
  }

  async runOnce(): Promise<number> {
    if (this.stopping) return 0;
    const now = this.clock.now();
    const events = this.transactions.run("immediate", (context) => {
      this.repository.releaseExpiredLease(context, now);
      return this.repository.claimBatch(context, {
        leaseOwner: this.options.leaseOwner,
        now,
        leaseExpiresAt: now + this.options.leaseDurationMs,
        limit: this.options.batchSize,
      });
    });
    for (
      let offset = 0;
      offset < events.length;
      offset += this.options.concurrency
    ) {
      if (this.stopping) break;
      await Promise.all(
        events
          .slice(offset, offset + this.options.concurrency)
          .map((event) => this.deliver(event)),
      );
    }
    return events.length;
  }

  shutdown(): void {
    this.stopping = true;
  }

  private async deliver(event: ClaimedOutboxEvent): Promise<void> {
    const handler = this.registry.get(event.topic);
    if (handler === undefined) {
      this.transactions.run("immediate", (context) =>
        this.repository.markDead(
          context,
          event.id,
          this.options.leaseOwner,
          "OUTBOX_HANDLER_MISSING",
        ),
      );
      return;
    }
    try {
      await handler(event);
      this.transactions.run("immediate", (context) =>
        this.repository.markPublished(
          context,
          event.id,
          this.options.leaseOwner,
          this.clock.now(),
        ),
      );
    } catch {
      this.transactions.run("immediate", (context) => {
        if (event.attemptCount >= this.options.maxAttempts) {
          this.repository.markDead(
            context,
            event.id,
            this.options.leaseOwner,
            "OUTBOX_HANDLER_FAILED",
          );
        } else {
          this.repository.reschedule(context, {
            id: event.id,
            leaseOwner: this.options.leaseOwner,
            availableAt:
              this.clock.now() + this.options.retryDelayMs(event.attemptCount),
            errorCode: "OUTBOX_HANDLER_FAILED",
          });
        }
      });
    }
  }
}
