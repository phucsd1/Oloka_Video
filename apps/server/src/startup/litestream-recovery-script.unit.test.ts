import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

describe("Litestream recovery harness", () => {
  it("creates Boot 1 running state through the production JobRepository claim path", () => {
    const script = readFileSync(
      fileURLToPath(
        new URL(
          "../../../../scripts/run-docker-litestream-recovery.sh",
          import.meta.url,
        ),
      ),
      "utf8",
    );
    const boot1 = script.slice(
      script.indexOf("seed_asset_job_state()"),
      script.indexOf("recover_asset_job_boot2()"),
    );

    expect(boot1).toContain(
      'import { JobRepository } from "/app/apps/server/dist/job/job-repository.js";',
    );
    expect(boot1).toMatch(
      /repository\.claimNext\([\s\S]*leaseOwner: "worker-A"/,
    );
    expect(boot1).toContain('"queued"');
    expect(boot1).toContain('"pending"');
    expect(boot1).not.toMatch(/append\.run\([^\n]+"job\.started"/);
  });
});
