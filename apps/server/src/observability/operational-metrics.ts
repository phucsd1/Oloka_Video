export type TimingMetric =
  | "startup"
  | "restore"
  | "migration"
  | "databaseOperation"
  | "transaction"
  | "eventLoopDelay";

interface TimingAccumulator {
  count: number;
  maxMs: number;
  samples: number[];
  nextSample: number;
}

export interface OperationalMetricsSnapshot {
  schemaVersion: 1;
  timings: Partial<
    Record<TimingMetric, { count: number; p99Ms: number; maxMs: number }>
  >;
  sqliteBusyCount: number;
}

const metricOrder: TimingMetric[] = [
  "startup",
  "restore",
  "migration",
  "databaseOperation",
  "transaction",
  "eventLoopDelay",
];

export class OperationalMetrics {
  private readonly accumulators = new Map<TimingMetric, TimingAccumulator>();
  private sqliteBusyCount = 0;

  constructor(private readonly sampleLimit = 512) {
    if (!Number.isInteger(sampleLimit) || sampleLimit < 1) {
      throw new Error("Metric sample limit must be a positive integer");
    }
  }

  observe(metric: TimingMetric, durationMs: number): void {
    if (!Number.isFinite(durationMs) || durationMs < 0) return;
    const rounded = Math.round(durationMs * 1000) / 1000;
    const accumulator = this.accumulators.get(metric) ?? {
      count: 0,
      maxMs: 0,
      samples: [],
      nextSample: 0,
    };
    accumulator.count += 1;
    accumulator.maxMs = Math.max(accumulator.maxMs, rounded);
    if (accumulator.samples.length < this.sampleLimit) {
      accumulator.samples.push(rounded);
    } else {
      accumulator.samples[accumulator.nextSample] = rounded;
      accumulator.nextSample = (accumulator.nextSample + 1) % this.sampleLimit;
    }
    this.accumulators.set(metric, accumulator);
  }

  recordSqliteBusy(): void {
    this.sqliteBusyCount += 1;
  }

  snapshot(): OperationalMetricsSnapshot {
    const timings: OperationalMetricsSnapshot["timings"] = {};
    for (const metric of metricOrder) {
      const accumulator = this.accumulators.get(metric);
      if (accumulator === undefined) continue;
      const samples = [...accumulator.samples].sort(
        (left, right) => left - right,
      );
      const percentileIndex = Math.max(0, Math.ceil(samples.length * 0.99) - 1);
      timings[metric] = {
        count: accumulator.count,
        p99Ms: samples[percentileIndex] ?? 0,
        maxMs: accumulator.maxMs,
      };
    }
    return { schemaVersion: 1, timings, sqliteBusyCount: this.sqliteBusyCount };
  }
}
