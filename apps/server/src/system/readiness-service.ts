import type { ReadyResponse } from "@oloka/contracts";
import type { SystemDatabase } from "../database/database.js";
import type { ObjectStorage } from "../storage/object-storage.js";

export class ReadinessService {
  constructor(
    private readonly database: SystemDatabase,
    private readonly storage: ObjectStorage,
  ) {}

  async getReadiness(): Promise<ReadyResponse> {
    const [database, storage] = await Promise.all([
      this.database.checkReadiness(),
      this.storage.checkReadiness(),
    ]);
    const configuration = { status: "ready" as const };
    const status =
      database.status === "ready" && storage.status === "ready"
        ? "ready"
        : "not_ready";

    return { status, checks: { database, storage, configuration } };
  }
}
