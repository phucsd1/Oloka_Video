# Data Inventory

## Nguyên tắc

Nguồn audit: AutoCode Video `codex/hf-prod-sync` tại `595ccdfaf45ff83473f2da8fd2c71d491828e5f5`. Tài liệu mô tả entity và vị trí dữ liệu, không sao chép schema.

## Ma trận vị trí dữ liệu

| Entity / nhóm dữ liệu     | Database                                                                          | File JSON / project directory                                                                   | `/data`                                                                  | Object storage                                              | Env                              | Frontend local state                                 | Bằng chứng                                                                                              |
| ------------------------- | --------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------ | ----------------------------------------------------------- | -------------------------------- | ---------------------------------------------------- | ------------------------------------------------------------------------------------------------------- |
| User                      | Bảng User                                                                         | Không                                                                                           | DB nằm trong `/data` khi hosted                                          | Không                                                       | Danh sách admin bootstrap        | User hiện tại trong runtime UI                       | `scripts/db.js`, `auth.js`, `public/app.js`                                                             |
| Session                   | Bảng Session, token và expiry                                                     | Không                                                                                           | DB hosted                                                                | Không                                                       | TTL/cache tuning                 | Cookie HttpOnly, không ở localStorage                | `scripts/db.js`, `auth.js`, `services/sessionLookupCache.js`                                            |
| Waitlist                  | User record ở trạng thái pending                                                  | Không                                                                                           | DB hosted                                                                | Không                                                       | Auth flags                       | Form tạm thời                                        | `auth.js`, `scripts/db.js`, `public/landing.js`                                                         |
| Project canonical record  | Bảng Project                                                                      | `meta.json`, thư mục project                                                                    | `/data/projects/<id>` hoặc `/data/workspace`                             | Có thể được nhìn qua HF Bucket mount; script legacy nhắm R2 | Storage root                     | Project list/filter/selection                        | `scripts/db.js`, `routes/projects.js`, `services/projectService.js`                                     |
| Workspace                 | Project đặc biệt `workspace` hoặc `workspace-<user>`                              | Cùng cấu trúc project                                                                           | `/data/workspace` cho legacy/admin; user workspace dưới `/data/projects` | HF Bucket path tương ứng nếu bật                            | `PERSISTENT_STORAGE_DIR`         | Active project                                       | `server.js`, `services/projectService.js`                                                               |
| Job                       | Bảng Job                                                                          | Các trường `job*` trong `meta.json`, `forge.log`, checkpoints                                   | Theo project                                                             | Không phải job durable riêng                                | Concurrency/provider flags       | Trạng thái live, poll/SSE, progress UI               | `scripts/db.js`, `services/jobStore.js`, `services/jobRuntimeService.js`                                |
| Composition               | Không có bảng riêng                                                               | `index.html`, raw HTML checkpoint, `compositions/**`, `hyperframes.json`                        | Theo project                                                             | Nằm cùng prefix project nếu mount được expose               | HyperFrames version/path         | Editor document, overrides, undo/redo                | `routes/composition.js`, `services/compositionDocumentService.js`, `services/rawHtmlCheckpoint.js`      |
| Asset dự án               | Không có bảng riêng                                                               | `assets/**` và sidecar JSON                                                                     | Theo project                                                             | Theo prefix project trong mô hình HF; migration cũ nhắm R2  | Media tools                      | Asset selection/lock                                 | `services/promptAssetService.js`, `routes/assets.js`, `services/storage/projectObjectKeys.js`           |
| Shared asset              | Không có bảng riêng                                                               | `public/assets/library/**`, `public/assets/bgm/**`, sidecar metadata                            | Không mặc định; root có thể override                                     | Không có implementation upload object store trong app       | `AUTOCODE_ASSET_LIBRARY_DIR`     | Catalog, filter, selected assets                     | `services/assetLibraryStore.js`, `services/assetCatalogService.js`, `routes/assets.js`, `routes/bgm.js` |
| Asset analysis            | Không có bảng riêng                                                               | Sidecar JSON cạnh asset; embedding/metadata trong JSON                                          | Theo vị trí asset                                                        | Không                                                       | Provider config                  | Search index/filter ở browser                        | `services/assetAnalysisService.js`, `services/assetSearch.js`, `services/mockAssetAnalysis.js`          |
| Prompt / LLM trace        | ChatHistory table tồn tại nhưng không phải nguồn chính quan sát được              | `01_prompt.json`, `02_llm_script.json`, `meta.json`, log/trace                                  | Theo project                                                             | Cùng project nếu mount                                      | Provider secrets/model           | AI trace modal, local cached profiles                | `scripts/db.js`, `services/forgePipelineService.js`, `public/app.js`                                    |
| TTS / transcript          | Không                                                                             | `assets/narration.mp3`, scene audio, `transcript.json`, `03_tts_alignment.json`, audio metadata | Theo project                                                             | Cùng project nếu mount                                      | Omnivoice config                 | TTS/progress display                                 | `services/omnivoiceSceneTts.js`, `services/ttsMediaService.js`, `services/forgePipelineService.js`      |
| Caption                   | Không                                                                             | Được inject vào composition; style/mode trong `meta.json`                                       | Theo project                                                             | Cùng project                                                | Không                            | Caption mode/style preview                           | `services/captionTemplates.js`, `services/captionSegmenter.js`, `public/app.js`                         |
| BGM                       | Không                                                                             | Shared audio + JSON; bản chọn được copy thành project asset                                     | Shared root và project                                                   | Không có uploader object store riêng                        | Recognition config               | BGM selection                                        | `routes/bgm.js`, `services/forgeLlmService.js`                                                          |
| Render output hiện tại    | Project/Job chỉ lưu cờ và URL/metadata                                            | `output.mp4`                                                                                    | Theo project                                                             | HF Bucket signed path giả định cùng mount                   | HF Bucket credentials            | Video source + cache version                         | `services/projectService.js`, `services/hfBucketDelivery.js`, `services/videoDelivery.js`               |
| Render history            | JSON trong Project `studioSnapshot` chỉ là projection; không có bảng render riêng | `meta.json.renders`, `renders/<render-id>/{output,index,log}`                                   | Theo project                                                             | Signed URL có thể trỏ render-id                             | Không                            | Render history rail                                  | `services/projectService.js`, `services/forgeStatusPayload.js`, `public/app.js`                         |
| Quality report            | Job/meta giữ summary                                                              | `quality-report.json`, Codex brief, quality frames/logs                                         | Theo project                                                             | Cùng project nếu mount                                      | QA feature flags/provider config | Report modal                                         | `routes/quality.js`, `services/videoQualityService.js`, `services/forgeQualityService.js`               |
| Setting / provider config | AppSetting JSON                                                                   | Không                                                                                           | DB hosted                                                                | Không                                                       | Một số provider/deploy secret    | localStorage chứa profile/config local; form runtime | `scripts/db.js`, `services/sharedConfig.js`, `public/app.js`                                            |
| Social configuration      | Nằm trong shared AppSetting JSON                                                  | Không                                                                                           | DB hosted                                                                | Không                                                       | Không phải đường chính           | Form settings/localStorage                           | `services/sharedConfig.js`, `routes/socialPublish.js`, `public/app.js`                                  |
| Activity event            | ActivityEvent trong DB SQLite riêng                                               | Không                                                                                           | `activity.db`, hoặc temp fallback                                        | Không                                                       | Fallback path                    | Admin dashboard cache                                | `services/activityEventDatabase.js`, `scripts/db.js`, `services/adminActivityAnalytics.js`              |
| Admin pricing             | AppSetting hoặc dữ liệu setting qua admin service                                 | Không                                                                                           | DB hosted                                                                | Modal pricing được đọc từ web                               | Không                            | Pricing editor                                       | `routes/admin.js`, `services/adminPricingService.js`, `services/modalPricingService.js`                 |

## Entity nghiệp vụ

### User

Mang identity, email/name/avatar, password hash hoặc OAuth provider identity, role `member/admin`, trạng thái `pending/active/disabled`, thời điểm tạo/duyệt/đăng nhập. Admin email được bảo vệ bởi policy riêng. Chưa thấy organization/team/tenant entity.

Bằng chứng: `scripts/db.js`, `auth.js`, `services/adminAccessPolicy.js`.

### Project

Mang tên, mô tả, owner, timestamps, favorite/posted/tags, model, aspect ratio, scene count, duration, flags composition/video, render settings và một Studio snapshot JSON. Cùng thông tin được lặp lại trong `meta.json`; file system vẫn được dùng để phát hiện `hasComposition` và `hasVideo`.

Bằng chứng: `scripts/db.js`, `services/projectService.js`, `routes/projects.js`.

### Asset

Không có entity DB chuẩn. Identity thực tế là filename + asset type + vị trí file. Metadata sidecar có thể gồm kích thước, hash, upload date, tag, description, collection, OCR/transcript/analysis, embedding và trạng thái AI. Điều này làm rename, ownership, versioning và referential integrity yếu.

Bằng chứng: `routes/assets.js`, `services/assetCatalogService.js`, `services/assetAnalysisService.js`, `services/mockAssetAnalysis.js`.

### Composition

Không có ID/version entity trong DB. Composition hiện hành là `index.html`; revision của editor được suy ra bởi composition document service. Registry blocks và component con nằm trong `compositions/**`; raw checkpoint hỗ trợ pipeline/editor recovery.

Bằng chứng: `services/compositionDocumentService.js`, `routes/composition.js`, `services/rawHtmlCheckpoint.js`, `services/templateRegistryService.js`.

### Job

Job dùng project ID làm ID trong DB; queue tạo một ID có timestamp nhưng persistence vẫn upsert theo project. State gồm status, step, progress, error, model/render config và timestamps. Runtime bổ sung logs, traces, stats, asset selection, video URL và abort/process handles trong RAM.

Bằng chứng: `scripts/db.js`, `services/jobRuntimeService.js`, `services/jobStore.js`, `routes/forge.js`.

### Render output

Không có bảng Render. Output hiện hành ghi đè `output.mp4`; lịch sử là thư mục snapshot và mảng JSON trong `meta.json`. URL delivery có hai mode: mounted static hoặc signed HF S3 redirect.

Bằng chứng: `services/projectService.js`, `services/hfBucketDelivery.js`, `routes/media.js`.

### Setting / Provider configuration

Hosted shared config là một JSON trong AppSetting, gồm OpenAI-compatible config, Omnivoice, recognition cho image/music/video và social config. Secret được che khi trả về hosted nhưng được lưu nguyên giá trị trong SQLite. Local UI còn lưu provider profiles/secrets trong localStorage.

Bằng chứng: `services/sharedConfig.js`, `routes/settings.js`, `public/app.js`, `scripts/db.js`.

## Project directory điển hình

| Artifact                | Ý nghĩa                                           | Được tạo/đọc bởi                                                           |
| ----------------------- | ------------------------------------------------- | -------------------------------------------------------------------------- |
| `meta.json`             | Project + job + render history + trace projection | `services/projectService.js`, `services/jobStore.js`, `routes/projects.js` |
| `hyperframes.json`      | Khai báo registry/path cho project                | `routes/projects.js`, `routes/forge.js`                                    |
| `index.html`            | Composition hiện hành                             | Forge, Studio, preview, render                                             |
| `assets/**`             | Media project, narration, BGM, transcript         | Asset copy/upload, TTS, compile                                            |
| `compositions/**`       | Registry blocks/components materialized           | `services/templateRegistryService.js`                                      |
| `01_prompt.json`        | Input checkpoint                                  | Forge                                                                      |
| `02_llm_script.json`    | Kịch bản/composition checkpoint                   | Forge/resume                                                               |
| `03_tts_alignment.json` | Word alignment checkpoint                         | TTS/compile/resume                                                         |
| `forge.log`             | Log phục hồi và chẩn đoán                         | Job/pipeline/UI                                                            |
| `quality-report.json`   | Hậu kiểm                                          | Quality service/UI                                                         |
| `output.mp4`            | Output hiện hành                                  | Render provider                                                            |
| `renders/<id>/**`       | Snapshot output/HTML/log                          | Render history                                                             |

Bằng chứng: `services/forgePipelineService.js`, `services/projectService.js`, `services/jobStore.js`, `routes/quality.js`.

## Vấn đề dữ liệu cần giải quyết ở Oloka

1. **Nhiều nguồn sự thật:** DB, `meta.json`, disk existence và RAM đều có quyền quyết định status. Bằng chứng: `routes/projects.js`, `services/projectService.js`, `services/jobStore.js`.
2. **Ghi DB bất đồng bộ không transaction với filesystem:** metadata có thể ghi thành công nhưng DB sync thất bại hoặc ngược lại. Bằng chứng: `services/projectService.js`, `routes/projects.js`.
3. **Job không durable:** queue/abort/process chỉ ở RAM; restart biến running/queued thành failed. Bằng chứng: `services/jobRuntimeService.js`, `services/jobStore.js`.
4. **Asset không có stable ID/owner:** filename là identity; shared library là global. Bằng chứng: `routes/assets.js`, `services/assetLibraryStore.js`.
5. **Render history là JSON không ràng buộc:** file có thể mất trong khi record còn tồn tại. Bằng chứng: `services/projectService.js`.
6. **Secret lưu plaintext:** masking chỉ áp dụng response, không phải encryption at rest. Bằng chứng: `services/sharedConfig.js`, `scripts/db.js`.
7. **Schema thay đổi lúc startup:** tạo bảng và thêm column ngay khi import DB, khó kiểm soát rollback/version. Bằng chứng: `scripts/db.js`.

## Đề xuất data boundary cho Oloka MVP

- DB là nguồn sự thật cho User, Project, Asset, CompositionVersion, Job, RenderOutput và ProviderCredential reference.
- Object storage là nguồn bytes; DB giữ immutable key, checksum, size, owner và lifecycle.
- Job event/step phải durable; log là evidence, không được dùng để suy luận state chính.
- Project workspace chỉ là working copy có thể tái tạo, không phải database thứ hai.
- Secret dùng secret store/envelope encryption; browser không giữ shared production key.
- Mọi transition có idempotency key và transaction/outbox khi cần phối hợp DB với object storage.
