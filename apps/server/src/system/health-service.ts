import type { HealthResponse } from "@oloka/contracts";

export class HealthService {
  getHealth(): HealthResponse {
    return {
      status: "ok",
      timestamp: new Date().toISOString(),
    };
  }
}
