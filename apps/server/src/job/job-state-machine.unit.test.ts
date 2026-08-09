import { describe, expect, it } from "vitest";
import {
  JOB_STATUSES,
  JOB_STEP_STATUSES,
  isAllowedJobTransition,
  isAllowedJobStepTransition,
} from "./job-state-machine.js";

const allowed = new Set([
  "queued:running",
  "queued:cancel_requested",
  "running:queued",
  "running:waiting_provider",
  "running:retry_scheduled",
  "running:cancel_requested",
  "running:completed",
  "running:failed",
  "waiting_provider:running",
  "waiting_provider:retry_scheduled",
  "waiting_provider:cancel_requested",
  "waiting_provider:failed",
  "retry_scheduled:queued",
  "retry_scheduled:cancel_requested",
  "cancel_requested:cancelled",
  "cancel_requested:failed",
]);

describe("Job state machine", () => {
  it("allows exactly the documented exhaustive transition matrix", () => {
    expect(JOB_STATUSES).toHaveLength(8);
    for (const from of JOB_STATUSES) {
      for (const to of JOB_STATUSES) {
        expect(isAllowedJobTransition(from, to)).toBe(
          allowed.has(`${from}:${to}`),
        );
      }
    }
  });
});

const allowedStep = new Set([
  "pending:running",
  "pending:skipped",
  "pending:cancelled",
  "running:pending",
  "running:waiting_provider",
  "running:retry_scheduled",
  "running:completed",
  "running:skipped",
  "running:cancelled",
  "running:failed",
  "waiting_provider:running",
  "waiting_provider:retry_scheduled",
  "waiting_provider:completed",
  "waiting_provider:cancelled",
  "waiting_provider:failed",
  "retry_scheduled:pending",
  "retry_scheduled:cancelled",
]);

describe("JobStep state machine", () => {
  it("allows exactly the documented exhaustive transition matrix", () => {
    expect(JOB_STEP_STATUSES).toHaveLength(8);
    for (const from of JOB_STEP_STATUSES) {
      for (const to of JOB_STEP_STATUSES) {
        expect(isAllowedJobStepTransition(from, to)).toBe(
          allowedStep.has(`${from}:${to}`),
        );
      }
    }
  });
});
