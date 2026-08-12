import type { TransactionRunner } from "../database/database.js";
import { AuditEventRepository } from "../database/repositories/audit-event-repository.js";
import type { IdGenerator } from "../kernel/id-generator.js";
import type { ObjectStorage } from "../storage/object-storage.js";

interface PreviewPurgeClaim {
  id: string;
  storage_key: string;
}

export class PreviewArtifactMaintenanceService {
  private readonly audit: AuditEventRepository;

  constructor(
    private readonly options: {
      transactions: TransactionRunner;
      storage: ObjectStorage;
      idGenerator: IdGenerator;
    },
  ) {
    this.audit = new AuditEventRepository(options.idGenerator);
  }

  async run(
    now: number,
    limit = 100,
  ): Promise<{ scheduled: number; purged: number; failed: number }> {
    const claims = this.options.transactions.run(
      "immediate",
      ({ database }) => {
        const candidates = database
          .prepare(
            `SELECT id, storage_key FROM preview_artifacts
             WHERE (status = 'ready' AND purge_after IS NOT NULL AND purge_after <= ?)
                OR status = 'purge_scheduled'
             ORDER BY COALESCE(purge_after, created_at), id LIMIT ?`,
          )
          .all(now, limit) as unknown as PreviewPurgeClaim[];
        const schedule = database.prepare(
          "UPDATE preview_artifacts SET status = 'purge_scheduled' WHERE id = ? AND status = 'ready'",
        );
        let scheduled = 0;
        for (const candidate of candidates)
          scheduled += Number(schedule.run(candidate.id).changes);
        return { candidates, scheduled };
      },
    );
    let purged = 0;
    let failed = 0;
    for (const claim of claims.candidates) {
      try {
        await this.options.storage.delete("durable", claim.storage_key);
      } catch {
        failed += 1;
        continue;
      }
      purged += this.options.transactions.run("immediate", (context) => {
        const changed = Number(
          context.database
            .prepare(
              "UPDATE preview_artifacts SET status = 'purged', purge_after = NULL WHERE id = ? AND status = 'purge_scheduled'",
            )
            .run(claim.id).changes,
        );
        if (changed === 1)
          this.audit.append(context, {
            actorType: "system",
            action: "preview.purged",
            resourceType: "preview",
            resourceId: claim.id,
            outcome: "success",
            metadata: { policyVersion: 1 },
            createdAt: now,
          });
        return changed;
      });
    }
    return { scheduled: claims.scheduled, purged, failed };
  }
}
