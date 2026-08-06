import { z } from "zod";
import type { TransactionRunner } from "../database/database.js";
import { SystemMetadataRepository } from "../database/repositories/system-metadata-repository.js";
import type { Clock } from "../kernel/clock.js";

const runtimeWitnessSchema = z
  .object({
    schemaVersion: z.literal(1),
    firstStartedAt: z.number().int().nonnegative(),
    lastStartedAt: z.number().int().nonnegative(),
    startupCount: z.number().int().positive(),
    lastBuildSha: z.string().min(1),
    runtimeMode: z.literal("sqlite-local-hf-s3-replication"),
  })
  .strict();

export type RuntimeWitness = z.infer<typeof runtimeWitnessSchema>;
export interface RuntimeWitnessUpdate {
  witness: RuntimeWitness;
  metadataVersion: number;
}

export class RuntimeWitnessService {
  private readonly repository = new SystemMetadataRepository();

  constructor(
    private readonly transactions: TransactionRunner,
    private readonly clock: Clock,
  ) {}

  record(buildSha: string): RuntimeWitnessUpdate {
    const now = this.clock.now();
    return this.transactions.run("immediate", (context) => {
      const existing = this.repository.get(context, "deployment.runtime");
      const previous =
        existing === undefined
          ? undefined
          : runtimeWitnessSchema.parse(existing.value);
      const witness: RuntimeWitness = {
        schemaVersion: 1,
        firstStartedAt: previous?.firstStartedAt ?? now,
        lastStartedAt: now,
        startupCount: (previous?.startupCount ?? 0) + 1,
        lastBuildSha: buildSha,
        runtimeMode: "sqlite-local-hf-s3-replication",
      };
      const stored = this.repository.put(context, {
        key: "deployment.runtime",
        value: witness,
        updatedAt: now,
        expectedVersion: existing?.version ?? null,
      });
      return { witness, metadataVersion: stored.version };
    });
  }
}
