import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { SqliteSystemDatabase } from "../database/sqlite-system-database.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe("Durable Job query plans", () => {
  it("uses scheduler, owner, event, outbox, and quota indexes", async () => {
    const directory = await mkdtemp(join(tmpdir(), "oloka-job-plan-"));
    temporaryDirectories.push(directory);
    const database = await SqliteSystemDatabase.connect(
      pathToFileURL(join(directory, "database.sqlite")).href,
    );
    await database.migrate();

    try {
      const plans = database.transactions.run(
        "read",
        ({ database: connection }) => ({
          claim: explain(
            connection,
            `WITH candidate AS MATERIALIZED (
             SELECT id FROM jobs INDEXED BY jobs_claim_idx
             WHERE type = 'asset_ingestion' AND status = 'queued' AND available_at <= 1
             ORDER BY priority, available_at, created_at, id LIMIT 1
           )
           SELECT j.id FROM candidate j JOIN job_steps s ON s.job_id = j.id
           WHERE s.parent_step_id IS NULL AND s.status = 'pending' AND s.available_at <= 1 LIMIT 1`,
          ),
          lease: explain(
            connection,
            "SELECT id FROM jobs WHERE status = 'running' AND lease_expires_at <= 1",
          ),
          owner: explain(
            connection,
            "SELECT id FROM jobs WHERE owner_user_id = 'u' ORDER BY created_at DESC, id DESC LIMIT 25",
          ),
          project: explain(
            connection,
            "SELECT id FROM jobs WHERE project_id = 'p' ORDER BY created_at DESC, id DESC LIMIT 25",
          ),
          steps: explain(
            connection,
            "SELECT id FROM job_steps WHERE job_id = 'j' AND status = 'pending'",
          ),
          events: explain(
            connection,
            "SELECT id FROM job_events WHERE job_id = 'j' AND sequence > 1 ORDER BY sequence LIMIT 100",
          ),
          outbox: explain(
            connection,
            "SELECT id FROM outbox_events WHERE topic = 'job.dispatch.requested' AND status = 'pending' AND available_at <= 1 ORDER BY available_at, created_at, id LIMIT 1",
          ),
          reservations: explain(
            connection,
            "SELECT SUM(amount) FROM quota_reservations WHERE user_id = 'u' AND status = 'reserved' AND expires_at > 1",
          ),
          policies: explain(
            connection,
            "SELECT id FROM quota_policies WHERE scope_type = 'user' AND scope_id = 'u' AND effective_from <= 1 ORDER BY effective_from DESC, id DESC LIMIT 1",
          ),
        }),
      );

      expect(plans.claim).toContain("jobs_claim_idx");
      expect(plans.lease).toContain("jobs_lease_idx");
      expect(plans.owner).toContain("jobs_owner_list_idx");
      expect(plans.project).toContain("jobs_project_list_idx");
      expect(plans.steps).toContain("job_steps_job_status_idx");
      expect(plans.events).toMatch(
        /job_events.*autoindex|job_events_history_idx/i,
      );
      expect(plans.outbox).toMatch(/outbox_(job_wake|claim)_idx/);
      expect(plans.reservations).toContain(
        "quota_reservations_user_status_expiry_idx",
      );
      expect(plans.policies).toContain("quota_policies_resolution_idx");
    } finally {
      await database.close();
    }
  });
});

function explain(
  database: { prepare(sql: string): { all(): unknown[] } },
  sql: string,
): string {
  return database
    .prepare(`EXPLAIN QUERY PLAN ${sql}`)
    .all()
    .map((row) => (row as { detail: string }).detail)
    .join("\n");
}
