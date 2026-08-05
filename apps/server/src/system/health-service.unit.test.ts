import { describe, expect, it, vi } from "vitest";
import { HealthService } from "./health-service.js";

describe("HealthService", () => {
  it("reports process health with the current timestamp", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-05T01:00:00.000Z"));

    expect(new HealthService().getHealth()).toEqual({
      status: "ok",
      timestamp: "2026-08-05T01:00:00.000Z",
    });

    vi.useRealTimers();
  });
});
