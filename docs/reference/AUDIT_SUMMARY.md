# Phase 0 Audit Summary

## Executive summary

AutoCode Video là một **prompt-to-video production workspace**, không chỉ là generator. Nó kết hợp landing/auth, project/DAM, prompt planning, HyperFrames composition, Studio preview/edit, TTS/transcription/caption, local/Modal render, quality gates, output history, social publishing và admin trong một Node/Express application. Project artifact trên filesystem là trung tâm vận hành; SQLite, JSON metadata, log và RAM cùng giữ các projection khác nhau của trạng thái.

Nguồn audit: `phucsd1/AutoCode_Video`, branch `codex/hf-prod-sync`, commit `595ccdfaf45ff83473f2da8fd2c71d491828e5f5`. Đây là tài liệu clean-room: chỉ mô tả behavior/contracts, không chuyển code.

Bằng chứng tổng: `server.js`, `public/app.js`, `private/dashboard-shell.html`, `services/forgePipelineService.js`, `services/projectService.js`, `scripts/db.js`, `Dockerfile`.

## Audit limitations

- Audit này chủ yếu dựa trên source inspection tại snapshot nêu trên. Nó xác minh implementation và reachability nhìn thấy trong source, không chứng minh hành vi production.
- 66 test file trong AutoCode Video được kiểm kê nhưng không được chạy vì repository tham khảo bị giới hạn read-only và test có thể tạo artifact hoặc thay đổi trạng thái.
- Không thực hiện lời gọi có side effect hoặc phát sinh phí tới provider; không chạy OAuth thật, LLM generation, TTS/Omnivoice, Modal render hoặc social publishing.
- Không xác minh runtime Hugging Face Storage/delivery hoặc hosted Space trong Phase 0.
- Không xác minh Cloudflare runtime vì snapshot thiếu Worker source/config cần thiết để tái tạo deployment.
- Trong toàn bộ bộ tài liệu, `active` hoặc “hoạt động” mặc định chỉ có nghĩa source-level implementation/reachability (`SOURCE_VERIFIED` + `NOT_RUNTIME_VERIFIED`), trừ khi ghi rõ `RUNTIME_VERIFIED` hoặc `PARTIAL_RUNTIME_EVIDENCE`. Phase 0 không gán hai trạng thái runtime này cho feature/integration nào.
- Implementation status (`FULL`, `PARTIAL`, `MOCK`, `LEGACY`, `UNREACHABLE`, `UNCLEAR`) và verification status (`SOURCE_VERIFIED`, `RUNTIME_VERIFIED`, `NOT_RUNTIME_VERIFIED`, `PARTIAL_RUNTIME_EVIDENCE`) là hai trục độc lập.

## Các chức năng quan trọng nhất

1. **Prompt-to-video Forge pipeline:** LLM tạo composition, TTS, alignment/caption, HyperFrames validation/render và hậu kiểm. Bằng chứng: `routes/forge.js`, `services/forgePipelineService.js`, `services/forgeQualityService.js`.
2. **Project continuity:** list/search/open, artifact checkpoints, resume và render history. Bằng chứng: `routes/projects.js`, `services/jobStore.js`, `services/projectService.js`.
3. **Preview/edit loop:** live preview, Studio document editor, quick scene/AI edit. Bằng chứng: `src/studio-editor.jsx`, `routes/composition.js`, `public/app.js`.
4. **Media controls:** asset lock, caption, narration và BGM. Bằng chứng: `routes/assets.js`, `services/omnivoiceSceneTts.js`, `services/captionTemplates.js`, `routes/bgm.js`.
5. **Hosted rendering/delivery:** Modal render và HF `/data`/S3 delivery. Bằng chứng: `services/renderProviders.js`, `deploy/modal-renderer/app.py`, `services/hfBucketDelivery.js`, `Dockerfile`.
6. **Operational visibility:** logs, report, quality, admin jobs/cost/activity. Bằng chứng: `routes/quality.js`, `services/projectReportService.js`, `routes/admin.js`, `auth.js`.

## Những phần gây hỗn loạn lớn nhất

### 1. Không có một nguồn sự thật

Project/job state được giữ trong SQLite, `meta.json`, disk existence, `forge.log` và RAM. Ghi filesystem với DB không có transaction chung; startup còn sync disk ngược vào DB. Đây là nguồn của status drift, project ID inconsistency và recovery dựa vào phỏng đoán.

Bằng chứng: `services/projectService.js`, `services/jobStore.js`, `routes/projects.js`, `services/projectDiskSnapshot.js`, `scripts/db.js`.

### 2. Pipeline và frontend monolithic

Forge create/edit nằm trong một service rất lớn với nhiều repair/checkpoint branch; dashboard JS/HTML/CSS và generated editor bundle cũng cực lớn. Blast radius của một thay đổi cao và boundary khó kiểm thử end-to-end.

Bằng chứng: `services/forgePipelineService.js`, `public/app.js`, `private/dashboard-shell.html`, `public/style.css`, `public/studio-editor.js`.

### 3. Queue trông durable nhưng thực tế ở RAM

UI có SSE, polling, pause/cancel/resume và global render dock, nhưng queue/process/abort controller không survive restart. Startup biến running/queued thành failed.

Bằng chứng: `services/jobRuntimeService.js`, `services/jobStore.js`, `services/projectService.js`, `routes/forge.js`.

### 4. Storage và permission không thống nhất

Project có owner, nhưng shared asset library không có tenant entity; static assets được serve công khai; BGM mutations không dùng cùng admin guard asset. Một số project path operations không dùng resolver containment an toàn.

Bằng chứng: `server.js`, `routes/assets.js`, `routes/bgm.js`, `routes/projects.js`, `services/projectService.js`.

### 5. Ba topology deployment chồng nhau

HF all-in-one là đường chính theo source; Modal là render sidecar; Cloudflare frontend/backend/R2/D1 còn scripts nhưng thiếu Worker source/config và có API contract khác. Không nên duy trì song song trong Oloka MVP.

Bằng chứng: `.github/workflows/deploy-hf-space.yml`, `Dockerfile`, `deploy/modal-renderer/app.py`, `package.json`, `scripts/*cloudflare*`.

## Chức năng trùng lặp

| Trùng lặp                                           | Luồng hiện hành                | Phần nên bỏ/thu gọn                                                       | Bằng chứng                                                                   |
| --------------------------------------------------- | ------------------------------ | ------------------------------------------------------------------------- | ---------------------------------------------------------------------------- |
| Full Forge vs direct generate/TTS/compile/render    | Dashboard dùng `/api/forge/**` | `/api/generate`, `/api/tts/**`, `/api/compile`, GET `/api/render`         | `public/app.js`, các file `routes/*.js` tương ứng                            |
| Project create qua Forge vs POST project            | Forge tự tạo khi cần           | Một command project riêng có semantics rõ; generation chỉ nhận project ID | `routes/forge.js`, `routes/projects.js`                                      |
| Live status từ RAM/meta/log/DB                      | SSE + polling Forge            | Một durable job read model                                                | `services/jobStore.js`, `services/forgeStatusPayload.js`, `routes/status.js` |
| Static preview, preview child server, Studio iframe | Dashboard phối hợp nhiều đường | Một preview service/runtime contract                                      | `server.js`, `public/app.js`, `src/studio-editor.jsx`                        |
| Shared/local provider config                        | Hosted AppSetting override     | Một server-side credential reference                                      | `services/sharedConfig.js`, `public/app.js`                                  |
| Current output và render snapshots                  | `output.mp4` + copied history  | Immutable RenderOutput records                                            | `services/projectService.js`, `services/hfBucketDelivery.js`                 |

## Những phần nên bỏ

- UI DAM chưa có domain/backend thật: advanced collections/shared/trash, mock background removal và AI-labeled client heuristics. Bằng chứng: `private/dashboard-shell.html`, `public/app.js`.
- Direct legacy pipeline endpoints bị Forge thay thế. Bằng chứng: `public/app.js`, `routes/generate.js`, `routes/tts.js`, `routes/compile.js`, `routes/render.js`.
- Password auth hosted và GitHub OAuth nếu không có product requirement rõ. Bằng chứng: `auth.js`, `public/index.html`.
- Cloudflare alternate deployment trong MVP. Bằng chứng: `package.json`, `scripts/*cloudflare*`, thiếu `deploy/cloudflare-*` trong snapshot.
- Social publishing, web scraping/capture, semantic DAM và smart BGM trong MVP. Chúng có giá trị nhưng mở rộng compliance, secret, cost và durable-job scope. Bằng chứng: `routes/socialPublish.js`, `services/promptAssetService.js`, `services/assetAnalysisService.js`, `services/forgeLlmService.js`.

## Những phần tuyệt đối không mang sang Oloka

1. Code hoặc prompt nội bộ từ AutoCode Video.
2. Recursive delete dựa trên client-supplied project path/ID.
3. Queue/lock/progress chỉ ở RAM.
4. Project/job state lặp ở DB + JSON + log + RAM.
5. Asset identity bằng filename và shared global filesystem.
6. Secret production trong localStorage hoặc plaintext config JSON không có encryption boundary.
7. Generated HTML là data model nghiệp vụ duy nhất cho scene/edit.
8. Endpoint/route tồn tại nhưng không được mount hoặc không có consumer mà vẫn coi là supported.
9. Deployment scripts trỏ tới source/config không có trong repo.
10. UI báo thành công cho thao tác mô phỏng không tạo artifact.

Bằng chứng: `routes/projects.js`, `services/jobRuntimeService.js`, `services/projectService.js`, `routes/assets.js`, `services/sharedConfig.js`, `public/app.js`, `routes/fonts.js`, `server.js`, `package.json`.

## Rủi ro Critical và High

### Critical

- Project filesystem operations thiếu containment resolver thống nhất trên các đường select, detail, diagnostics, bulk delete, delete, clone, thumbnail và mutation favorite/posted. Đây là kết luận source-level, không phải xác nhận exploit. Bằng chứng: `routes/projects.js` so với `services/projectService.js`.
- Project deletion là DB delete và recursive filesystem delete tách rời; lỗi DB đôi khi bị bỏ qua, không có trash/restore/shared transaction, còn bulk delete có thể partial success. Không thực hiện destructive PoC. Bằng chứng: `routes/projects.js`.

### High

- Data/state drift giữa SQLite, JSON, log, disk và RAM.
- Job mất khi restart và progress không monotonic/canonical.
- Preview/render khác môi trường; registry/font/version có thể drift.
- TTS/LLM/Modal timeout làm chặn journey core.
- Output signed URL có thể đi trước object availability hoặc stale cache.
- Shared asset/BGM permission không thống nhất và static shared asset public.
- Provider/social secrets plaintext/browser/query URL.
- Social publish không durable.
- Cloudflare topology không tái tạo được.
- Schema mutation diễn ra lúc startup.

Chi tiết và evidence: `KNOWN_FAILURE_MODES.md`.

## Phạm vi MVP đề xuất

### Có trong MVP

1. Google OAuth + admin approval/disable.
2. Canonical Project CRUD với soft delete.
3. Private asset upload cơ bản vào object storage, technical metadata, asset selection và tìm kiếm theo original filename, media type, upload time, project, optional ingestion status.
4. Prompt composer tối giản: prompt, ratio, caption on/off/style cơ bản, voice.
5. Durable generation job state machine: plan → composition → TTS/alignment → compile/check → render → verify → completed.
6. Một OpenAI-compatible LLM adapter, một TTS adapter và HyperFrames version pin.
7. Preview read-only có parity với render.
8. Modal render qua versioned protocol và object-store bundle.
9. Technical quality gates bắt buộc.
10. Immutable RenderOutput với playback/download.
11. Error report + retry từ failed step.
12. Admin tối thiểu: users, provider health/credentials, jobs lỗi.

### Hậu MVP

- Full visual Studio/undo-redo, AI multi-turn edit, render history UI đầy đủ.
- Shared DAM, collections, semantic/embedding/similar search, AI enrichment, exact/semantic duplicate cleanup, OCR/transcript search và advanced taxonomy.
- URL scraping/capture, smart BGM, post-render vision self-heal.
- Social publishing.
- Cloudflare alternate topology.
- Cost analytics sâu và activity dashboard.

## Quyết định cần chủ sản phẩm xác nhận

1. MVP có closed beta/waitlist và admin approval hay login là đủ?
2. Google-only hay thêm GitHub/password?
3. Oloka có cần Workspace như một entity độc lập hay Phase 1 bắt đầu chỉ với project list? Kết luận hiện tại là `UNDECIDED`; không được dùng alias `workspace`/`workspace-<user>` hoặc special project để mô phỏng entity này.
4. MVP cần full visual editor, basic structured scene edit hay chỉ regenerate từ prompt?
5. Asset là private theo user, shared theo admin, hay cả hai?
6. URL-to-video/web scraping có nằm trong product promise không?
7. Omnivoice có là TTS bắt buộc hay cần provider portability ngay MVP?
8. Modal có là render provider duy nhất cho hosted MVP?
9. Technical QA pass có đủ hoàn thành job, hay bắt buộc vision/human approval?
10. Render history/version retention và soft-delete retention bao lâu?
11. Social publishing có thuộc Oloka hay dừng ở download?
12. HF-only topology trong MVP đã được chấp nhận chưa; Cloudflare có chính thức loại khỏi Phase 1 không?
13. BGM/caption scope tối thiểu là gì?
14. Mức quota/cost/concurrency theo user cần enforce ngay MVP?

## Các quyết định phạm vi đã làm rõ

- **Workspace:** `UNDECIDED`. Nếu được chọn trong Phase 1, Workspace phải là entity độc lập với ownership/authorization rõ; nếu chưa chọn, bắt đầu từ project list. Không kế thừa alias của AutoCode Video.
- **Favorite/posted:** `favorite` có thể giữ như một boolean tổ chức đơn giản. `posted` không thuộc MVP và không được dùng làm publish lifecycle; hậu MVP cần entity tương đương `Publication`/`PublishJob`.
- **Asset Search MVP:** chỉ original filename, media type, upload time, project và optional ingestion status. Semantic/embedding/similar search, AI enrichment, exact/semantic duplicate cleanup, OCR/transcript search và advanced taxonomy là hậu MVP.
- **API count:** 82 là inventory count, không phải bằng chứng completeness. Node `/health` và Modal `/health` là hai endpoint riêng; hai font route được đếm nhưng `UNREACHABLE` vì router không mount; endpoint nội bộ động của HyperFrames không được đếm.

## Số liệu audit

- Feature/subsystem: **56**.
- API endpoint: **82** (bao gồm Modal; 2 font routes unmounted).
- Integration: **16**.
- Test file quan sát được trong AutoCode Video: **66**; không chạy vì reference repository bị giới hạn read-only và test có thể ghi artifact.

## Đề xuất thứ tự sau Phase 0

Sau khi chủ sản phẩm xác nhận các quyết định trên, Phase 1 nên bắt đầu bằng domain contracts và state model, không bắt đầu bằng copy UI hay nối provider: `User/Project/Asset/Job/CompositionVersion/RenderOutput`, authorization matrix, storage/job interfaces và một vertical slice từ project rỗng đến accepted durable job. Phase 0 dừng tại tài liệu này; không tự động triển khai Phase 1.
