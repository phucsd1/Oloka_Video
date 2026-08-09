export interface EffectiveQuotaPolicy {
  version: string;
  maxVideoDurationSeconds: number;
  maxResolution: { longEdge: number; shortEdge: number };
  maxActiveGenerationPerUser: number;
  maxActiveRenderPerUser: number;
  maxQueuedJobsPerUser: number;
  maxActiveRenderSystemDev: number;
  maxAssetSizeBytes: number;
  maxProjectStorageBytes: number;
  maxRetainedOutputsPerProject: number;
}

export interface QuotaPolicyResolver {
  resolve(input: {
    userId: string;
    projectId: string;
    at: number;
  }): EffectiveQuotaPolicy;
}

const DEFAULT_ASSET_QUOTA_POLICY: EffectiveQuotaPolicy = {
  version: "mvp-v1",
  maxVideoDurationSeconds: 60,
  maxResolution: { longEdge: 1920, shortEdge: 1080 },
  maxActiveGenerationPerUser: 1,
  maxActiveRenderPerUser: 1,
  maxQueuedJobsPerUser: 3,
  maxActiveRenderSystemDev: 2,
  maxAssetSizeBytes: 500 * 1024 * 1024,
  maxProjectStorageBytes: 5 * 1024 * 1024 * 1024,
  maxRetainedOutputsPerProject: 10,
};

export class BaselineQuotaPolicyResolver implements QuotaPolicyResolver {
  private readonly policy: EffectiveQuotaPolicy;

  constructor(policy: Partial<EffectiveQuotaPolicy> = {}) {
    this.policy = {
      ...DEFAULT_ASSET_QUOTA_POLICY,
      ...policy,
      maxResolution:
        policy.maxResolution ?? DEFAULT_ASSET_QUOTA_POLICY.maxResolution,
    };
  }

  resolve(input: {
    userId: string;
    projectId: string;
    at: number;
  }): EffectiveQuotaPolicy {
    void input;
    return { ...this.policy, maxResolution: { ...this.policy.maxResolution } };
  }
}

export class DatabaseQuotaPolicyResolver implements QuotaPolicyResolver {
  constructor(
    private readonly transactions: TransactionRunner,
    private readonly baseline: QuotaPolicyResolver = new BaselineQuotaPolicyResolver(),
  ) {}

  resolve(input: {
    userId: string;
    projectId: string;
    at: number;
  }): EffectiveQuotaPolicy {
    const base = this.baseline.resolve(input);
    const policies = this.transactions.run(
      "read",
      ({ database }) =>
        database
          .prepare(
            `SELECT scope_type, policy_json FROM quota_policies
           WHERE ((scope_type = 'user' AND scope_id = ?)
              OR (scope_type = 'system' AND scope_id IS NULL))
             AND effective_from <= ?
             AND (effective_until IS NULL OR effective_until > ?)
           ORDER BY effective_from DESC, id DESC`,
          )
          .all(input.userId, input.at, input.at) as Array<{
          scope_type: "system" | "user";
          policy_json: string;
        }>,
    );
    const system = policies.find((policy) => policy.scope_type === "system");
    const user = policies.find((policy) => policy.scope_type === "user");
    const systemLimits =
      system === undefined
        ? {}
        : quotaPolicySchema.parse(JSON.parse(system.policy_json)).limits;
    const userLimits =
      user === undefined
        ? {}
        : quotaPolicySchema.parse(JSON.parse(user.policy_json)).limits;
    return {
      ...base,
      ...systemLimits,
      ...userLimits,
      maxResolution: {
        ...base.maxResolution,
        ...(systemLimits.maxResolution ?? {}),
        ...(userLimits.maxResolution ?? {}),
      },
    };
  }
}
import { quotaPolicySchema } from "@oloka/contracts";
import type { TransactionRunner } from "../database/database.js";
