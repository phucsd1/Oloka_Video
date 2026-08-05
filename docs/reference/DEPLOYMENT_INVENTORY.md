# Deployment Inventory

## Kết luận ngắn

Topology production có bằng chứng source đầy đủ nhất là: GitHub branch `codex/hf-prod-sync` → GitHub Actions → Docker Hugging Face Space `phucsd/autocode-video` → `/data` persistent storage → Modal render gateway. Cloudflare là một topology alternate/legacy không thể tái tạo từ snapshot audit vì source/config Worker được package scripts tham chiếu nhưng không có trong Git.

Nguồn audit: commit `595ccdfaf45ff83473f2da8fd2c71d491828e5f5`.

Mọi kết luận topology ở đây là `SOURCE_VERIFIED` và `NOT_RUNTIME_VERIFIED`. Phase 0 không chạy deploy, không probe Hugging Face/Modal/Cloudflare runtime, không gọi provider và không xác minh storage delivery thực. “Primary/active” chỉ có nghĩa đường được source/config chỉ ra, không có nghĩa runtime đã được chứng minh.

## Local development

| Thành phần    | Hành vi                                                                                 | Bằng chứng                                                                    | Vấn đề                                                                 |
| ------------- | --------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------- | ---------------------------------------------------------------------- |
| Node/Express  | `npm start` chạy server; `npm run dev` chạy watcher                                     | `package.json`, `server.js`, `scripts/watcher.js`                             | Frontend/backend/pipeline cùng process; restart ảnh hưởng queue        |
| Storage       | Nếu không có `PERSISTENT_STORAGE_DIR` và `/data`, workspace/projects/DB nằm ở repo root | `server.js`, `scripts/db.js`                                                  | Dễ tạo dirty artifacts và trộn source với dữ liệu runtime              |
| Media/browser | Setup scripts cài dependency; HyperFrames quản lý browser; ffmpeg/ffprobe từ package    | `scripts/setup-local.ps1`, `scripts/setup-local.sh`, `services/mediaTools.js` | Windows/Linux behavior có thể khác; dependency nặng                    |
| Render        | Mặc định local nếu không đặt provider                                                   | `services/renderProviders.js`                                                 | Không có timeout local rõ ràng; dùng CPU/RAM của app process host      |
| Preview       | Spawn một HyperFrames preview process/port theo project                                 | `server.js`                                                                   | Registry process chỉ ở RAM; cleanup phụ thuộc signal/process lifecycle |
| DB            | SQLite main + activity DB, schema được tạo/ALTER lúc startup                            | `scripts/db.js`, `services/activityEventDatabase.js`                          | Không có migration version/rollback chuẩn                              |

## Hugging Face Space

### Build và runtime

- Base image Node 22 Debian slim; cài Chromium và font system.
- `npm ci --omit=dev --ignore-scripts`, sau đó rebuild ffmpeg dependencies.
- Runtime port `7860`, storage root `/data`, render provider mặc định `modal`.
- Tạo `/data/workspace`, `/data/projects`, `/data/tmp` trong image, nhưng persistence thực tế phụ thuộc mount của Space.

Bằng chứng: `Dockerfile`, `README.md`.

### Storage và delivery

- Project và DB dùng `/data` qua `PERSISTENT_STORAGE_DIR`.
- `output.mp4` được phục vụ bằng static mount nếu thiếu HF S3 credentials.
- Nếu đủ credentials, `/api/media/video` ký URL read-only trên `s3.hf.co` cho object path tương ứng; ứng dụng không có bước upload S3 riêng, nên thiết kế giả định `/data` và bucket gateway nhìn cùng dữ liệu.

Bằng chứng: `server.js`, `scripts/db.js`, `services/hfBucketDelivery.js`, `routes/media.js`, `README.md`.

### Failure/workaround quan sát được

- Activity DB có integrity check, rename file corrupt và fallback sang temp nếu mount không dùng được.
- Copy file trên mounted storage có retry/stream fallback.
- Asset catalog được warm bất đồng bộ trước/ở startup để giảm cold request.
- Job `running/queued` bị đánh failed sau restart thay vì resume tự động.

Bằng chứng: `services/activityEventDatabase.js`, `services/storage/mountedFileOps.js`, `server.js`, `services/jobStore.js`, `services/projectService.js`.

## Modal renderer

### Gateway

`deploy/modal-renderer/app.py` khai báo FastAPI gateway trên Modal, một image có Node/HyperFrames/Chromium/ffmpeg, nhiều resource preset, Modal Volume cho render output và bearer token tùy cấu hình.

### Giao thức

1. Node app gom `index.html`, asset và composition cần render vào JSON base64 có giới hạn dung lượng.
2. POST tạo render call; poll call ID; tải MP4 từ gateway về project.
3. Gateway tạo temporary workspace, chạy HyperFrames CLI, kiểm tra MP4 tối thiểu và copy vào Modal Volume.

Bằng chứng: `services/renderProviders.js`, `services/storage/renderBundleManifest.js`, `deploy/modal-renderer/app.py`.

### Overlap/rủi ro

- HyperFrames version được pin ở cả npm app và default Python deployment; hai release có thể drift.
- Client timeout mặc định 15 phút trong khi Modal function timeout 30 phút.
- Bundle base64 làm tăng memory/network và có hai giới hạn dung lượng khác nhau.
- Output tồn tại tạm ở Modal Volume rồi lại được tải về HF `/data`; không có durable render record độc lập.

## CI/CD hiện tại

Workflow `.github/workflows/deploy-hf-space.yml`:

1. Trigger khi push `codex/hf-prod-sync` hoặc manual dispatch nhưng bắt buộc đúng source ref.
2. Checkout full history + LFS.
3. `npm ci` và `npm test`.
4. Tạo snapshot Git mới, loại node_modules/DB, commit snapshot rồi force-with-lease lên HF Space `main`.
5. Kiểm tra Space có paused thì restart.

Điểm tốt: source branch được khóa, deploy concurrency chỉ một, test là gate, push dùng lease thay vì force mù.

Khoảng trống: workflow không chờ Space đạt RUNNING/READY, không xác nhận runtime SHA tương ứng source SHA, không smoke custom domain/served bundle/API, và snapshot commit SHA trên HF khác GitHub source SHA.

Bằng chứng: `.github/workflows/deploy-hf-space.yml`, `tests/hfDeploySnapshot.test.js`.

## Cloudflare frontend

Package scripts dự định:

- Copy `public/**` sang `.tmp/cloudflare-frontend-public`, bỏ shared asset library/BGM.
- Deploy bằng Wrangler config `deploy/cloudflare-frontend/wrangler.jsonc`.

Nhưng snapshot không có `deploy/cloudflare-frontend/**`. Do đó build copy có thể chạy, còn preflight/deploy không tái tạo được. Cũng chưa có bằng chứng trong source rằng bundle runtime tự chọn đúng backend origin hoặc xử lý cookie/CORS giữa hai domain.

Bằng chứng: `package.json`, `scripts/build-cloudflare-frontend.mjs`; sự vắng mặt được xác nhận bằng tracked file inventory tại commit audit.

Trạng thái: **legacy/incomplete**.

## Cloudflare backend, D1 và R2

Scripts đề cập một Worker backend origin, bearer internal token, D1 và R2. Smoke script mong các contract khác Express hiện tại, gồm job advance và project purge. Migration script đọc project filesystem, tạo SQL cho `projects`/`project_files` và upload bytes lên R2.

Snapshot không có `deploy/cloudflare-backend/**` hay Wrangler config/schema tương ứng. Vì vậy không thể xác nhận backend đang active, schema hiện hành, auth model, durability hoặc compatibility với dashboard.

Bằng chứng: `package.json`, `scripts/preflight-cloudflare-backend.mjs`, `scripts/smoke-cloudflare-backend.mjs`, `scripts/e2e-cloudflare-backend.mjs`, `scripts/migrate-projects-to-cloudflare.mjs`.

Trạng thái: **legacy/alternate, không nên mang sang MVP**.

## Environment variables và secrets

### Runtime nền tảng

| Nhóm              | Biến quan sát được                                                                                                             | Vai trò                       | Bằng chứng                                                                  |
| ----------------- | ------------------------------------------------------------------------------------------------------------------------------ | ----------------------------- | --------------------------------------------------------------------------- |
| Server/storage    | `PORT`, `NODE_ENV`, `PERSISTENT_STORAGE_DIR`, `DATABASE_URL`, `ACTIVITY_DATABASE_FALLBACK_PATH`                                | HTTP, data root, SQLite paths | `server.js`, `scripts/db.js`, `services/activityEventDatabase.js`           |
| Auth              | `AUTOCODE_AUTH_ENABLED`, Basic Auth user/password, admin emails, local password/test-login flags/tokens, session cache/timeout | Access/session policy         | `auth.js`, `server.js`                                                      |
| OAuth             | Google/GitHub client ID/secret, callback URL                                                                                   | Login                         | `auth.js`                                                                   |
| Render            | `RENDER_PROVIDER`, Modal base URL/token/timeouts/retry/bundle/preset, Chromium path, workers/FPS                               | Local/Modal execution         | `services/renderProviders.js`, `Dockerfile`, `deploy/modal-renderer/app.py` |
| HF delivery       | HF bucket namespace/name/S3 access credentials                                                                                 | Signed output delivery        | `services/hfBucketDelivery.js`, `README.md`                                 |
| TTS               | Omnivoice token/base config                                                                                                    | Voice generation              | `services/omnivoiceAuth.js`, shared settings                                |
| Cloudflare legacy | Backend origin/config, internal API token, D1 name, R2 bucket, migration owner                                                 | Alternate topology            | `scripts/*cloudflare*`, `scripts/migrate-projects-to-cloudflare.mjs`        |

OpenAI/recognition/social provider values trong hosted mode chủ yếu nằm ở `AppSetting`, không chỉ env. Bằng chứng: `services/sharedConfig.js`, `routes/settings.js`.

## Deployment overlap

| Concern  | HF all-in-one                | Cloudflare alternate        | Modal            | Nhận xét                                       |
| -------- | ---------------------------- | --------------------------- | ---------------- | ---------------------------------------------- |
| Frontend | Express static               | Static Worker/Pages dự kiến | Không            | Hai frontend build path có thể drift           |
| Backend  | Express                      | Worker contract khác        | Render API riêng | Ba API surface không dùng chung schema rõ ràng |
| Database | SQLite `/data`               | D1 dự kiến                  | Không            | Migration one-off, không dual-write an toàn    |
| Bytes    | HF `/data` + S3 gateway      | R2 dự kiến                  | Modal Volume tạm | Một output đi qua nhiều store                  |
| Job      | RAM + SQLite/meta projection | Worker job model dự kiến    | Function call    | Không có end-to-end durable job ID chung       |

## Đề xuất topology Oloka MVP

- Chọn một topology duy nhất: HF Docker Space cho web/API + một durable database adapter + object storage adapter + Modal render worker.
- GitHub source SHA phải được truyền thành runtime metadata và kiểm chứng sau deploy.
- CI phải chạy format/lint/typecheck/test/build, sau đó smoke `/health`, auth entry và một artifact delivery không cần tạo video tốn phí.
- Tách render protocol có version; pin HyperFrames version ở một manifest chung.
- Không khởi động Cloudflare topology cho đến khi có ADR riêng, source/config/schema đầy đủ và compatibility tests.
