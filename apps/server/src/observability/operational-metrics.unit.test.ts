import { describe, expect, it } from "vitest";
import { OperationalMetrics } from "./operational-metrics.js";

describe("OperationalMetrics", () => {
  it("reports bounded aggregate percentiles and SQLite busy counts", () => {
    const metrics = new OperationalMetrics();
    for (let duration = 1; duration <= 100; duration += 1) {
      metrics.observe("transaction", duration);
    }
    metrics.observe("migration", 12);
    metrics.recordSqliteBusy();

    expect(metrics.snapshot()).toEqual({
      schemaVersion: 1,
      timings: {
        migration: { count: 1, p99Ms: 12, maxMs: 12 },
        transaction: { count: 100, p99Ms: 99, maxMs: 100 },
      },
      sqliteBusyCount: 1,
    });
  });

  it("retains only a bounded number of duration samples", () => {
    const metrics = new OperationalMetrics(4);
    for (let duration = 1; duration <= 10; duration += 1) {
      metrics.observe("databaseOperation", duration);
    }

    expect(metrics.snapshot().timings.databaseOperation).toEqual({
      count: 10,
      p99Ms: 10,
      maxMs: 10,
    });
  });
});
