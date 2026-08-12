import { ApplicationError } from "../http/application-error.js";

export const MAX_PREVIEW_EMBEDDED_ASSET_BYTES_V1 = 16 * 1024 * 1024;

export function assertPreviewEmbeddedAssetBudgetV1(totalBytes: number): void {
  if (totalBytes > MAX_PREVIEW_EMBEDDED_ASSET_BYTES_V1)
    throw new ApplicationError(
      "PAYLOAD_TOO_LARGE",
      "preview_embedded_media_limit",
    );
}
