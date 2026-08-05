# Typed Error Model

## Envelope and safety

Every expected failure returns or records a stable `code`, `retryable`, localized safe message key/text, suggested action, correlation ID, and optional safe field details. Internal logs add stack/cause only in protected telemetry. Responses and durable safe details never expose secrets, raw provider payloads, tokens, filesystem paths, storage keys, or stack traces.

HTTP status applies to synchronous commands/queries. Asynchronous jobs store the same code and expose it through authorized status APIs.

## Error catalog

| Code                        | HTTP | Retryable                        | Safe message / suggested action                            | Log / admin                                |
| --------------------------- | ---: | -------------------------------- | ---------------------------------------------------------- | ------------------------------------------ |
| `VALIDATION_ERROR`          |  400 | No until input changes           | Dữ liệu không hợp lệ; sửa field được chỉ ra                | Info; no admin                             |
| `AUTHENTICATION_REQUIRED`   |  401 | Yes after login                  | Cần đăng nhập; đăng nhập lại bằng Google                   | Info; no admin                             |
| `AUTHORIZATION_DENIED`      |  403 | No                               | Không có quyền; quay lại tài nguyên của bạn                | Warn; investigate repeated probes          |
| `ACCOUNT_PENDING`           |  403 | Yes after approval               | Tài khoản đang chờ duyệt; chờ hoặc liên hệ admin           | Info; admin may review                     |
| `ACCOUNT_DISABLED`          |  403 | No                               | Tài khoản đã bị khóa; liên hệ admin                        | Warn; admin required                       |
| `ACCOUNT_REJECTED`          |  403 | No unless admin changes status   | Tài khoản không được phê duyệt; liên hệ admin nếu cần      | Info/Warn; admin status change required    |
| `QUOTA_EXCEEDED`            |  429 | Yes after capacity/action        | Đã vượt giới hạn; giảm dung lượng hoặc chờ job khác        | Info/metric; admin only for policy issue   |
| `PROJECT_NOT_FOUND`         |  404 | No                               | Không tìm thấy project; tải lại danh sách                  | Info; no admin                             |
| `PROJECT_DELETED`           |  409 | Yes after restore                | Project đang ở thùng rác; khôi phục trong thời hạn         | Info; no admin                             |
| `ASSET_NOT_FOUND`           |  404 | No                               | Không tìm thấy asset; chọn asset khác                      | Info; no admin                             |
| `ASSET_UNAVAILABLE`         |  409 | Yes                              | Asset chưa sẵn sàng; chờ xử lý hoặc thử lại                | Warn; admin if storage degraded            |
| `ASSET_INVALID`             |  422 | No until replacement             | Asset không hợp lệ; tải file được hỗ trợ                   | Info/Warn; no admin normally               |
| `STORAGE_UNAVAILABLE`       |  503 | Yes                              | Lưu trữ tạm thời không sẵn sàng; thử lại sau               | Error; admin intervention if sustained     |
| `PROVIDER_UNAVAILABLE`      |  503 | Yes                              | Dịch vụ xử lý tạm thời không sẵn sàng                      | Error/metric; admin if sustained           |
| `PROVIDER_RATE_LIMITED`     |  429 | Yes                              | Provider đang giới hạn; hệ thống sẽ thử lại                | Warn/metric; admin if quota/config         |
| `PROVIDER_TIMEOUT`          |  504 | Yes if policy allows             | Provider quá thời gian; thử lại từ checkpoint              | Warn/Error; admin if repeated              |
| `PROVIDER_REJECTED`         |  422 | Usually no                       | Provider từ chối yêu cầu; điều chỉnh nội dung/cấu hình     | Warn; admin for credential/policy cause    |
| `INVALID_PROVIDER_RESPONSE` |  502 | Yes if bounded                   | Provider trả dữ liệu không hợp lệ; hệ thống có thể thử lại | Error; admin if repeated                   |
| `COMPOSITION_INVALID`       |  422 | No until regenerated/edited      | Bố cục không hợp lệ; sửa hoặc tạo lại                      | Warn; no admin unless systemic             |
| `DEPENDENCY_MISSING`        |  422 | Yes after dependency repair      | Thiếu dependency render; tạo lại bundle                    | Error; admin if registry issue             |
| `RENDER_FAILED`             |  502 | Yes if eligible                  | Render thất bại; thử lại từ bước render                    | Error; admin if repeated/provider-wide     |
| `QUALITY_GATE_FAILED`       |  422 | No until new output/settings     | Video không đạt kiểm tra kỹ thuật; xem lỗi và render lại   | Warn; no admin unless systemic             |
| `CONFLICT`                  |  409 | Yes after refresh                | Dữ liệu đã thay đổi; tải lại rồi thử lại                   | Info; no admin                             |
| `IDEMPOTENCY_CONFLICT`      |  409 | No with same key                 | Khóa yêu cầu đã dùng cho nội dung khác; gửi khóa mới       | Warn; investigate client bug               |
| `JOB_NOT_CANCELLABLE`       |  409 | No                               | Job không thể hủy ở trạng thái hiện tại                    | Info; no admin                             |
| `CANCELLED`                 |  409 | No                               | Job đã bị hủy; tạo yêu cầu mới nếu cần                     | Info; no admin                             |
| `INTERNAL_ERROR`            |  500 | Maybe, never automatic unbounded | Có lỗi nội bộ; thử lại sau và cung cấp correlation ID      | Error/Critical; admin required if repeated |

## Mapping rules

1. Authentication is evaluated before resource existence when disclosure would leak another user's resource.
2. Provider-specific codes/messages are mapped to this catalog; raw provider text is log-only after redaction.
3. Retryability is contextual and bounded by job attempt policy; `retryable=true` never means infinite retry.
4. `QUALITY_GATE_FAILED` is distinct from `RENDER_FAILED`: rendered bytes may exist but cannot be published.
5. Cancellation is not represented as generic failure; job state becomes `cancelled` and may expose `CANCELLED` as the operation result.
6. A rejected User always maps to `ACCOUNT_REJECTED`, distinct from `ACCOUNT_DISABLED`; only an admin status change can make the same request eligible.
