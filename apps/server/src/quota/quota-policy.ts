export interface EffectiveQuotaPolicy {
  version: string;
  maxAssetSizeBytes: number;
  maxProjectStorageBytes: number;
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
  maxAssetSizeBytes: 500 * 1024 * 1024,
  maxProjectStorageBytes: 5 * 1024 * 1024 * 1024,
};

export class BaselineQuotaPolicyResolver implements QuotaPolicyResolver {
  constructor(
    private readonly policy: EffectiveQuotaPolicy = DEFAULT_ASSET_QUOTA_POLICY,
  ) {}

  resolve(input: {
    userId: string;
    projectId: string;
    at: number;
  }): EffectiveQuotaPolicy {
    void input;
    return { ...this.policy };
  }
}
