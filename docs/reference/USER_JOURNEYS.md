# User Journeys

Nguồn audit: AutoCode Video `codex/hf-prod-sync` tại `595ccdfaf45ff83473f2da8fd2c71d491828e5f5`. Mỗi journey phân biệt UI với side effect thật. Đây là journey dựng từ source (`SOURCE_VERIFIED`, `NOT_RUNTIME_VERIFIED`), không phải kết quả chạy end-to-end; test file quan sát được cũng không nâng verification status.

## 1. Đăng nhập

| Trạng thái | Hành vi quan sát được                                                                                                                                         |
| ---------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Happy path | Người dùng mở `/`; nếu chưa có session, thấy landing/auth gate, chọn Google, hoàn thành OAuth và được redirect đến dashboard. User active mới qua API guard.  |
| Loading    | Landing có logo gate/animation; bootstrap gọi auth status với timeout; dashboard có branded loading surface.                                                  |
| Empty      | Chưa có account có thể gửi waitlist; account mới có thể ở `pending`.                                                                                          |
| Error      | OAuth state/token/profile lỗi redirect về landing với `auth_error`; pending/disabled hiển thị blocked state; request auth lỗi trả 401/403.                    |
| Retry      | Người dùng thử Google login lại hoặc retry bootstrap. Không thấy automatic retry token exchange.                                                              |
| Dễ nhầm    | Auth có thể tắt hoàn toàn bằng env; password/GitHub routes tồn tại nhưng landing chính chỉ nhấn mạnh Google; GitHub callback không theo cùng redirect Google. |

Bằng chứng: `public/index.html`, `public/landing.js`, `auth.js`, `services/hostedEntryPolicy.js`, `server.js`, `tests/hostedEntryIntegration.test.js`.

## 2. Tạo project

| Trạng thái | Hành vi quan sát được                                                                                                                                                                                                                                                    |
| ---------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Happy path | Từ Create canvas, người dùng nhập prompt/config và bấm tạo; `/api/forge/start` có thể tự sinh project ID/thư mục, ghi metadata và enqueue job. Có route POST project riêng nhưng dashboard hiện tại không dùng trực tiếp.                                                |
| Loading    | Nút composer chuyển busy; UI mở Studio và theo dõi queue/status. Project list có skeleton/pagination.                                                                                                                                                                    |
| Empty      | Create canvas là empty/start state; project list có danh sách rỗng và load-more ẩn.                                                                                                                                                                                      |
| Error      | Prompt/config thiếu, quá giới hạn queue, tạo folder/DB lỗi hoặc project access denied.                                                                                                                                                                                   |
| Retry      | Có resume/rerun từ Studio; nếu project chưa được tạo thành công, người dùng submit lại prompt.                                                                                                                                                                           |
| Dễ nhầm    | “Tạo project” và “tạo video” bị gộp; ID có alias `workspace`, user workspace và project; route project CRUD riêng có contract khác Forge auto-create. Với Oloka, Workspace là `UNDECIDED`; không được kế thừa alias, Phase 1 phải chọn entity độc lập hoặc project list. |

Bằng chứng: `private/dashboard-shell.html`, `public/app.js`, `routes/forge.js`, `routes/projects.js`, `services/jobRuntimeService.js`.

## 3. Tải asset

| Trạng thái | Hành vi quan sát được                                                                                                                                                                           |
| ---------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Happy path | Admin mở DAM, chọn/drop ảnh, video hoặc audio; browser upload raw bytes với headers filename/type/config; server lưu vào shared library, tạo metadata kỹ thuật/fallback và enqueue AI analysis. |
| Loading    | XHR upload progress dành phần cuối cho server processing; asset analysis hiển thị pending và library được poll/refresh.                                                                         |
| Empty      | DAM có empty state và nút upload.                                                                                                                                                               |
| Error      | Extension không hỗ trợ, > giới hạn, network error, permission non-admin, mount write lỗi hoặc provider analysis lỗi.                                                                            |
| Retry      | Upload lại file; re-analyze từng asset; startup cleanup/requeue một số analysis stuck.                                                                                                          |
| Dễ nhầm    | UI upload hiện diện rộng nhưng hosted route chỉ admin quản lý shared library; upload “thành công” có thể chỉ có mock/fallback metadata; regular member không có private asset library riêng.    |

Bằng chứng: `public/app.js`, `private/dashboard-shell.html`, `routes/assets.js`, `services/assetAnalysisService.js`, `services/mockAssetAnalysis.js`.

## 4. Tạo video

| Trạng thái | Hành vi quan sát được                                                                                                                                                                                   |
| ---------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Happy path | Prompt + aspect ratio + caption/BGM + asset lock được gửi đến Forge. Queue chạy LLM planning/composition, copy/scrape asset, TTS theo scene, transcript/caption compile, contract checks, render và QA. |
| Loading    | SSE là đường chính, polling là fallback; Studio hiển thị step LLM/TTS/compile/render, log, stats và global render dock.                                                                                 |
| Empty      | Chưa có composition/video thì Studio hiển thị “sẵn sàng tạo video”.                                                                                                                                     |
| Error      | Provider config thiếu, queue full, LLM invalid JSON, asset lock không thỏa, TTS/transcription lỗi, registry/lint/render/QA lỗi. Error/log được persist trong `meta.json`/`forge.log`.                   |
| Retry      | Resume từ checkpoint LLM/TTS/compile/render; rerender settings-only; cancel rồi tạo lại; một số provider call tự retry.                                                                                 |
| Dễ nhầm    | Progress có nhiều nguồn; “render xong” chưa chắc “quality pass”; direct `/generate`/`tts`/`compile`/`render` vẫn tồn tại nhưng không phải luồng UI chính.                                               |

Bằng chứng: `public/app.js`, `routes/forge.js`, `services/forgePipelineService.js`, `services/jobStore.js`, `services/forgeStatusPayload.js`.

## 5. Chỉnh sửa

| Trạng thái | Hành vi quan sát được                                                                                                                                                    |
| ---------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Happy path | Khi có composition, người dùng vào Edit: chỉnh trực quan trong Studio rồi save document, sửa scene nhanh, hoặc gửi yêu cầu AI edit; có undo/redo và quick save.          |
| Loading    | Editor tải document/revision; save state “đang lưu/đã lưu”; AI edit quay lại job progress.                                                                               |
| Empty      | Edit tab bị disabled nếu chưa có composition; scene tool báo chưa chọn scene.                                                                                            |
| Error      | Document 404, HTML không có composition root, revision conflict 409, save 500, scene không tồn tại hoặc AI edit fail.                                                    |
| Retry      | Reload sau conflict; save lại; AI edit resume/retry; render-only có thể tái dùng narration/checkpoint.                                                                   |
| Dễ nhầm    | Có ba kiểu edit với mức side effect khác nhau; undo/redo chỉ cho editor session, không phải rollback project; quick scene write và full document save có thể cạnh tranh. |

Bằng chứng: `src/studio-editor.jsx`, `src/studio-editor-model.js`, `routes/composition.js`, `services/compositionDocumentService.js`, `routes/forge.js`.

## 6. Preview

| Trạng thái | Hành vi quan sát được                                                                                                                                                                                      |
| ---------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Happy path | Sau khi có `index.html`, UI bật Live Preview/Play, iframe tải composition theo project; safe zone/fullscreen hỗ trợ kiểm tra bố cục. HyperFrames preview process cũng phục vụ config/tooling theo project. |
| Loading    | Project selection tải status, meta/log/library; preview chờ document/iframe và có branded project loading.                                                                                                 |
| Empty      | Chưa có composition thì live preview/edit tab ẩn hoặc disabled.                                                                                                                                            |
| Error      | `index.html` thiếu, preview child process không start, asset/font không tải, HTML runtime error.                                                                                                           |
| Retry      | Reload/select project lại; retry generation/edit; preview process được tạo lại sau khi process cũ đóng.                                                                                                    |
| Dễ nhầm    | Preview không cùng execution environment với Modal render; static URL, child preview server và Studio iframe là ba đường gần giống nhau.                                                                   |

Bằng chứng: `server.js`, `public/app.js`, `private/dashboard-shell.html`, `src/studio-editor.jsx`.

## 7. Render

| Trạng thái | Hành vi quan sát được                                                                                                                                                  |
| ---------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Happy path | Người dùng bấm Render/Quick render; Forge materialize registry, lint/repair, chọn local hoặc Modal provider, tạo `output.mp4`, chạy QA và snapshot history.            |
| Loading    | UI hiển thị render step, log, elapsed/stats; Modal gateway có health check; global render queue tiếp tục poll khi đổi view.                                            |
| Empty      | Không có composition thì render bị chặn.                                                                                                                               |
| Error      | Registry unresolved, bundle quá lớn, gateway/config/token lỗi, timeout, HyperFrames non-zero, MP4 thiếu/rỗng hoặc QA block completion.                                 |
| Retry      | Modal transport retry; resume từ render checkpoint; quick re-render/settings-only; đổi provider chỉ qua deployment config.                                             |
| Dễ nhầm    | Direct GET `/api/render` SSE và Forge render cùng tồn tại; timeout Node 15 phút khác Modal function 30 phút; render technical success có thể bị job đánh failed do QA. |

Bằng chứng: `routes/forge.js`, `routes/render.js`, `services/renderProviders.js`, `deploy/modal-renderer/app.py`, `services/forgeQualityService.js`.

## 8. Tải output

| Trạng thái | Hành vi quan sát được                                                                                                                                                                            |
| ---------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Happy path | Completed status cung cấp video URL qua `/api/media/video`; endpoint redirect signed HF S3 hoặc mounted static path. UI phát video và tạo download filename an toàn; có thể chọn render history. |
| Loading    | Video preload/cache helper, version query và completion refresh xử lý artifact vừa xuất hiện.                                                                                                    |
| Empty      | Chưa có output thì Publish tab disabled và output card empty.                                                                                                                                    |
| Error      | File/object 404, signed credential/path sai, stale cache, MP4 rỗng hoặc browser playback lỗi.                                                                                                    |
| Retry      | Refresh completed output, chọn lại render, URL signed được tạo mới sau cache window; fallback mounted khi credentials thiếu.                                                                     |
| Dễ nhầm    | Current `output.mp4` bị ghi đè; history có URL riêng; record có thể tồn tại trong `meta.json` khi file snapshot mất.                                                                             |

Bằng chứng: `public/app.js`, `services/forgeStatusPayload.js`, `routes/media.js`, `services/hfBucketDelivery.js`, `services/projectService.js`, `public/video-cache.js`.

## 9. Xử lý lỗi

| Trạng thái | Hành vi quan sát được                                                                                                                                                   |
| ---------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Happy path | UI mở report/log/AI trace, copy diagnostics/Codex brief, xem quality finding; job error giữ step/checkpoint để resume.                                                  |
| Loading    | Report section tải riêng; status refresh định kỳ; diagnostics có thể chạy linter/animation map/thumbnail.                                                               |
| Empty      | Chưa có report/quality file trả 404 rõ; console/report có empty text.                                                                                                   |
| Error      | `meta.json`/log parse lỗi, diagnostics subprocess lỗi, report section không hợp lệ hoặc activity DB fallback.                                                           |
| Retry      | Resume, resume-paused, rerender, re-analyze QA, reload report, tạo Codex brief rồi sửa thủ công.                                                                        |
| Dễ nhầm    | Job recovery suy luận từ câu chữ log; status “failed” bao gồm cancel, restart, provider failure và QA failure; user-facing recovery action không luôn theo error class. |

Bằng chứng: `public/app.js`, `routes/forge.js`, `routes/projects.js`, `routes/quality.js`, `services/jobStore.js`, `services/projectReportService.js`.

## 10. Quản trị

| Trạng thái | Hành vi quan sát được                                                                                                                                                          |
| ---------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Happy path | Admin mở console, xem overview/activity/jobs/cost, filter/export, chỉnh role/status/name/email, xóa user, cập nhật pricing và shared provider settings; quản lý shared assets. |
| Loading    | Dashboard tải users/stats/jobs song song, có “last updated” và refresh; job detail tải riêng.                                                                                  |
| Empty      | Chưa có jobs/activity/pricing hiển thị empty/“chưa đặt đơn giá”.                                                                                                               |
| Error      | 403 nếu không admin; DB/activity fallback; pricing fetch/save lỗi; protected/last admin mutation bị chặn.                                                                      |
| Retry      | Refresh dashboard, tải lại job, save lại pricing/settings, test provider connection.                                                                                           |
| Dễ nhầm    | Admin metrics kết hợp DB, activity DB và disk-derived history; freshness khác nhau; asset/BGM permission không thống nhất; export là client-side snapshot.                     |

Bằng chứng: `private/dashboard-shell.html`, `public/app.js`, `auth.js`, `routes/admin.js`, `routes/settings.js`, `routes/assets.js`, `services/admin*.js`.

## Journey MVP đề xuất cho Oloka

MVP nên chỉ cam kết một đường rõ ràng:

`Google login → project list → create project → upload private asset → submit generation job → theo dõi durable progress → preview → chỉnh prompt/scene cơ bản → render → tải immutable output → retry từ step lỗi`.

Admin MVP chỉ cần duyệt/khóa user, xem job lỗi và quản lý provider credentials. DAM nâng cao, social publishing, Cloudflare alternate, visual editor toàn phần và AI asset enrichment để hậu MVP.

Asset Search trong journey MVP chỉ cam kết original filename, media type, upload time, project và optional ingestion status. Semantic/embedding/similar search, exact/semantic duplicate cleanup, OCR/transcript search và advanced taxonomy là hậu MVP. `favorite` có thể giữ như một tín hiệu đơn giản; `posted` không thuộc MVP, và publish lifecycle tương lai cần `Publication`/`PublishJob` tương đương.
