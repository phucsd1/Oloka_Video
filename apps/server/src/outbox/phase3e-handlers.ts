import type { DurableJobDispatcher } from "../job/durable-job-dispatcher.js";
import { OutboxHandlerRegistry } from "./consumer.js";

export const PHASE3E_OUTBOX_TOPIC_SEMANTICS = {
  "job.dispatch.requested": "dispatcher wake",
  "job.state.changed": "job-state notification",
  "job.reconcile.requested": "admin reconciliation intent",
} as const;

export interface Phase3EOutboxHandlerDependencies {
  dispatcher: Pick<DurableJobDispatcher, "wake" | "reconcileOnce">;
}

export function createPhase3EOutboxHandlerRegistry(
  dependencies: Phase3EOutboxHandlerDependencies,
): OutboxHandlerRegistry {
  const registry = new OutboxHandlerRegistry();
  registry.register("job.dispatch.requested", () => {
    dependencies.dispatcher.wake();
    return Promise.resolve();
  });
  registry.register(
    "job.state.changed",
    acknowledgeDurableJobStateNotification,
  );
  registry.register("job.reconcile.requested", () => {
    dependencies.dispatcher.reconcileOnce();
    return Promise.resolve();
  });
  return registry;
}

function acknowledgeDurableJobStateNotification(): Promise<void> {
  // job_events and Job state are already durable; this is only a local notification.
  return Promise.resolve();
}
