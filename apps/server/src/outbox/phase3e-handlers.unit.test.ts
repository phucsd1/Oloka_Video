import { describe, expect, it, vi } from "vitest";
import type { ClaimedOutboxEvent } from "../database/repositories/outbox-repository.js";
import {
  PHASE3E_OUTBOX_TOPIC_SEMANTICS,
  createPhase3EOutboxHandlerRegistry,
} from "./phase3e-handlers.js";

const event: ClaimedOutboxEvent = {
  id: "00000000-0000-4000-8000-000000000001",
  topic: "job.dispatch.requested",
  aggregateType: "job",
  aggregateId: "00000000-0000-4000-8000-000000000002",
  payload: { schemaVersion: 1 },
  attemptCount: 1,
};

describe("Phase 3E outbox handlers", () => {
  it("enumerates only the production-emittable Phase 3E topics", () => {
    expect(PHASE3E_OUTBOX_TOPIC_SEMANTICS).toEqual({
      "job.dispatch.requested": "dispatcher wake",
      "job.state.changed": "job-state notification",
      "job.reconcile.requested": "admin reconciliation intent",
    });
  });

  it("maps dispatcher requests to the canonical dispatcher wake signal", async () => {
    const dispatcher = {
      wake: vi.fn(),
      reconcileOnce: vi.fn(),
    };
    const registry = createPhase3EOutboxHandlerRegistry({ dispatcher });

    await expect(
      registry.get("job.dispatch.requested")?.(event),
    ).resolves.toBeUndefined();
    expect(dispatcher.wake).toHaveBeenCalledTimes(1);
    expect(dispatcher.reconcileOnce).not.toHaveBeenCalled();
  });

  it("maps admin reconciliation intent to the canonical reconciler", async () => {
    const dispatcher = {
      wake: vi.fn(),
      reconcileOnce: vi.fn(),
    };
    const registry = createPhase3EOutboxHandlerRegistry({ dispatcher });

    await expect(
      registry.get("job.reconcile.requested")?.({
        ...event,
        topic: "job.reconcile.requested",
      }),
    ).resolves.toBeUndefined();
    expect(dispatcher.reconcileOnce).toHaveBeenCalledTimes(1);
    expect(dispatcher.wake).not.toHaveBeenCalled();
  });
});
