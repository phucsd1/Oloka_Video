import type { VersionResponse } from "@oloka/contracts";
import type { AppEnvironment } from "../config/environment.js";

export class VersionService {
  constructor(private readonly environment: AppEnvironment) {}

  getVersion(): VersionResponse {
    return {
      name: "Oloka Video",
      version: this.environment.appVersion,
      environment: this.environment.nodeEnv,
      gitCommitSha: this.environment.gitCommitSha,
      buildTimestamp: this.environment.buildTimestamp,
    };
  }
}
