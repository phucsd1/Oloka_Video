export const JOB_STATUSES = [
  "queued",
  "running",
  "waiting_provider",
  "retry_scheduled",
  "cancel_requested",
  "cancelled",
  "completed",
  "failed",
] as const;

export type JobStatus = (typeof JOB_STATUSES)[number];

export const JOB_STEP_STATUSES = [
  "pending",
  "running",
  "waiting_provider",
  "retry_scheduled",
  "completed",
  "skipped",
  "cancelled",
  "failed",
] as const;

export type JobStepStatus = (typeof JOB_STEP_STATUSES)[number];

const JOB_TRANSITIONS: Readonly<Record<JobStatus, ReadonlySet<JobStatus>>> = {
  queued: new Set(["running", "cancel_requested"]),
  running: new Set([
    "queued",
    "waiting_provider",
    "retry_scheduled",
    "cancel_requested",
    "completed",
    "failed",
  ]),
  waiting_provider: new Set([
    "running",
    "retry_scheduled",
    "cancel_requested",
    "failed",
  ]),
  retry_scheduled: new Set(["queued", "cancel_requested"]),
  cancel_requested: new Set(["cancelled", "failed"]),
  cancelled: new Set(),
  completed: new Set(),
  failed: new Set(),
};

export function isAllowedJobTransition(
  from: JobStatus,
  to: JobStatus,
): boolean {
  return JOB_TRANSITIONS[from].has(to);
}

const JOB_STEP_TRANSITIONS: Readonly<
  Record<JobStepStatus, ReadonlySet<JobStepStatus>>
> = {
  pending: new Set(["running", "skipped", "cancelled"]),
  running: new Set([
    "pending",
    "waiting_provider",
    "retry_scheduled",
    "completed",
    "skipped",
    "cancelled",
    "failed",
  ]),
  waiting_provider: new Set([
    "running",
    "retry_scheduled",
    "completed",
    "cancelled",
    "failed",
  ]),
  retry_scheduled: new Set(["pending", "cancelled"]),
  completed: new Set(),
  skipped: new Set(),
  cancelled: new Set(),
  failed: new Set(),
};

export function isAllowedJobStepTransition(
  from: JobStepStatus,
  to: JobStepStatus,
): boolean {
  return JOB_STEP_TRANSITIONS[from].has(to);
}
