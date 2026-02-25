# Plan: Chuyển Workflow Storage sang Backend API

## Bối cảnh

Hiện tại Automa lưu trữ workflow trong `browser.storage.local` (local-first). Mục tiêu là chuyển sang **backend là nguồn dữ liệu chính**, local chỉ làm cache. Cần thêm:
1. Cấu hình `.env` cho backend URL và WebSocket URL (tách biệt)
2. Form login trong newtab, popup check auth và redirect
3. Workflow API service để CRUD workflow qua backend
4. Migrate workflow store sang gọi API

**Nguyên tắc**:
- Backend là chính, local là cache. Mất mạng = không tạo/sửa workflow.
- **QUAN TRỌNG**: Giữ lại toàn bộ file/code cũ sử dụng localStorage để tham chiếu. Không xóa file cũ nếu không sử dụng nữa — chỉ thêm mới hoặc sửa, không xóa.

---

## Tiến trình

- [x] **Phase 1**: Environment & Config
- [x] **Phase 2**: Auth Service & Login UI
- [x] **Phase 3**: Workflow API Service
- [x] **Phase 4**: Migrate Workflow Store
- [x] **Phase 5**: Cập nhật UI Components

---

## Phase 1: Environment & Config

### 1.1 Cài đặt `dotenv`
- [ ] Chạy `pnpm add -D dotenv`

### 1.2 Tạo file `.env` (project root)
- [ ] Tạo file mới
```
BACKEND_API_URL=http://localhost:8000
WS_URL=ws://localhost:8000
```

### 1.3 Tạo file `.env.example` (project root)
- [ ] Tạo file mới
```
BACKEND_API_URL=
WS_URL=
```

### 1.4 Thêm `.env` vào `.gitignore`
- [ ] File: `.gitignore` — thêm dòng `.env` (hiện chỉ có `.env.local`, `.env.*.local`)

### 1.5 Cập nhật `webpack.config.js`
- [ ] Thêm `require('dotenv').config()` ở đầu file (sau các require hiện tại)
- [ ] Thêm env vars vào `DefinePlugin` đã có (dòng 147-149):
```js
new webpack.DefinePlugin({
  BROWSER_TYPE: JSON.stringify(env.BROWSER),
  'process.env.BACKEND_API_URL': JSON.stringify(process.env.BACKEND_API_URL || ''),
  'process.env.WS_URL': JSON.stringify(process.env.WS_URL || ''),
}),
```

### 1.6 Cập nhật `secrets.blank.js`
- [ ] Sửa thành:
```js
export default {
  baseApiUrl: process.env.BACKEND_API_URL || '',
};
```
> **Giải thích**: `webpack.config.js` alias `secrets` → `secrets.blank.js`. `fetchApi` trong `src/utils/api.js` dùng `secrets.baseApiUrl` làm base URL. Thay đổi này giữ nguyên cơ chế, chỉ lấy giá trị từ env.

### 1.7 Cập nhật `src/background/WebSocketConfig.js`
- [ ] Đơn giản hóa: dùng `process.env.WS_URL` thay cho hardcode URL
- [ ] Xóa các placeholder config: `PRODUCTION_WEBSOCKET_CONFIG`, `WEBSOCKET_URLS`, `AUTH_TOKENS`

---

## Phase 2: Auth Service & Login UI

### 2.1 Tạo Auth Service — `src/utils/auth.js` (file mới)
- [ ] Module quản lý authentication

Tái sử dụng pattern lưu session trong `browser.storage.local` key `session` (giống hệ thống hiện tại trong `src/utils/api.js:12-31`). Session format giữ nguyên: `{ access_token, refresh_token, expires_at }`.

```js
// Các function cần tạo:
login(email, password)     // POST /auth/login → lưu session vào browser.storage.local
logout()                   // Xóa session + user khỏi storage, clear sessionStorage
isAuthenticated()          // Check session tồn tại + token chưa hết hạn
getAccessToken()           // Lấy token (tự refresh nếu gần hết hạn)
```

### 2.2 Tạo trang Login — `src/newtab/pages/Login.vue` (file mới)
- [ ] Form đơn giản: email + password + submit button
- [ ] Sử dụng UI components có sẵn (`ui-input`, `ui-button`, `ui-card`)
- [ ] Sau login thành công → redirect `/workflows`
- [ ] Hiển thị error message nếu login thất bại

### 2.3 Thêm route Login và auth guard — `src/newtab/router.js`
- [ ] Thêm route `{ name: 'login', path: '/login', component: Login }`
- [ ] Thêm `router.beforeEach()`:
  - Nếu đi `/login` mà đã auth → redirect `/workflows`
  - Nếu đi route khác mà chưa auth → redirect `/login`
  - Ngoại trừ route `welcome` và `recording`

### 2.4 Cập nhật Popup — `src/popup/App.vue`
- [ ] Trong `onMounted()` (dòng 30), thêm check auth trước khi load data:
```js
const authed = await isAuthenticated();
if (!authed) {
  sendMessage('open:dashboard', '/login', 'background');
  window.close();
  return;
}
```

### 2.5 Cập nhật User Store — `src/stores/user.js`
- [ ] Thêm action `logout()`: gọi `authLogout()`, reset state (user, backupIds, hostedWorkflows)

### 2.6 Cập nhật auth dialog — `src/newtab/App.vue` (dòng 9-24)
- [ ] Thay link external `https://extension.automa.site/auth` bằng `@click="$router.push('/login')"`

### 2.7 Thêm nút Logout vào Sidebar — `src/components/newtab/app/AppSidebar.vue`
- [ ] Trong phần user popover (dòng 60-89), thêm nút "Đăng xuất"
- [ ] Gọi `userStore.logout()` rồi `router.push('/login')`

---

## Phase 3: Workflow API Service

### 3.1 Tạo `src/utils/workflowApi.js` (file mới)
- [ ] Thin wrapper trên `fetchApi` (từ `src/utils/api.js`) cho workflow CRUD:

```js
import { fetchApi } from './api';

fetchWorkflows()              // GET /workflows → Array<Workflow>
fetchWorkflowById(id)         // GET /workflows/:id → Workflow
createWorkflow(data)          // POST /workflows → Workflow (với ID từ server)
updateWorkflow(id, data)      // PUT /workflows/:id → Workflow
deleteWorkflow(id)            // DELETE /workflows/:id
```

Tất cả dùng `{ auth: true }` → `fetchApi` tự thêm `Authorization: Bearer` header.

### API Contract (backend cần hỗ trợ)

| Method | Endpoint | Request | Response |
|--------|----------|---------|----------|
| GET | `/workflows` | — | `[{id, name, drawflow, settings, ...}]` |
| GET | `/workflows/:id` | — | `{id, name, drawflow, settings, ...}` |
| POST | `/workflows` | `{name, drawflow, settings, ...}` | `{id, name, ...}` |
| PUT | `/workflows/:id` | `{name?, drawflow?, ...}` | `{id, name, ...}` |
| DELETE | `/workflows/:id` | — | `{success: true}` |
| POST | `/auth/login` | `{email, password}` | `{access_token, refresh_token, expires_at, user}` |

---

## Phase 4: Migrate Workflow Store

### 4.1 Thêm imports — `src/stores/workflow.js`
- [ ] Import `workflowApi` và `isAuthenticated`

### 4.2 Sửa `loadData()` (dòng 115-137)
- [ ] Luồng mới:
  1. Load từ local cache trước (hiển thị ngay cho user)
  2. Set `retrieved = true`
  3. Nếu đã auth → fetch từ API, cập nhật state + local cache
  4. Nếu API lỗi → giữ nguyên cache, log error

### 4.3 Sửa `insert()` (dòng 141-167)
- [ ] Luồng mới:
  1. Tạo workflow object qua `defaultWorkflow()`
  2. Gọi `createWorkflow()` API → lấy response (có ID từ server)
  3. Lưu vào state với server ID
  4. Cập nhật local cache qua `saveToStorage('workflows')`
  5. Nếu API lỗi → throw error (backend là chính)

### 4.4 Sửa `update()` (dòng 168-213)
- [ ] Luồng mới:
  1. Update local state ngay (optimistic update cho UI responsive)
  2. Gọi `apiUpdateWorkflow(id, data)`
  3. Cập nhật local cache
  4. Nếu API lỗi → log error (local đã update, reconcile ở lần loadData tiếp)
  5. Giữ nguyên logic trigger enable/disable (dòng 188-199)

### 4.5 Sửa `delete()` (dòng 247-299)
- [ ] Luồng mới:
  1. Gọi `apiDeleteWorkflow(id)`
  2. Xóa khỏi local state
  3. Giữ nguyên cleanup logic: triggers, drafts, states, pinnedWorkflows (dòng 280-296)
  4. **Xóa** đoạn gọi old API `/me/workflows?id=` cho hosted/backup (dòng 258-278)

### 4.6 Sửa `insertOrUpdate()` (dòng 215-246)
- [ ] Giữ nguyên merge logic, thêm API call (create/update) cho mỗi item

---

## Phase 5: Cập nhật UI Components

### 5.1 `src/newtab/App.vue` (dòng 324-397)
- [ ] Startup flow giữ nguyên (vẫn gọi `workflowStore.loadData()`)
- [ ] Thêm toast khi API không kết nối

### 5.2 `src/newtab/pages/workflows/index.vue`
- [ ] Hàm `addWorkflow()` thêm `.catch()` hiển thị toast error

### 5.3 `src/components/newtab/workflow/editor/EditorLocalActions.vue`
- [ ] Không cần thay đổi structure — store handle API call nội bộ

### 5.4 Xử lý 401 global — `src/utils/api.js`
- [ ] Sau khi `fetchApi` nhận 401 và refresh thất bại → xóa session
- [ ] Router guard sẽ redirect về `/login` ở lần navigate tiếp

### 5.5 Thêm locale keys — `src/locales/en/newtab.json`
- [ ] Thêm: `auth.email`, `auth.password`, `auth.logout`, `auth.loginFailed`

---

## Tổng hợp Files

### Files tạo mới
| File | Mục đích |
|------|----------|
| `.env` | Config BACKEND_API_URL và WS_URL |
| `.env.example` | Template cho dev khác |
| `src/utils/auth.js` | Auth service (login, logout, isAuthenticated, getAccessToken) |
| `src/utils/workflowApi.js` | Workflow CRUD API calls |
| `src/newtab/pages/Login.vue` | Trang login |

### Files sửa
| File | Thay đổi |
|------|----------|
| `webpack.config.js` | Thêm dotenv, DefinePlugin env vars |
| `.gitignore` | Thêm `.env` |
| `secrets.blank.js` | Dùng `process.env.BACKEND_API_URL` |
| `src/background/WebSocketConfig.js` | Dùng `process.env.WS_URL` |
| `src/stores/workflow.js` | Sửa toàn bộ CRUD actions gọi API |
| `src/stores/user.js` | Thêm action logout |
| `src/newtab/router.js` | Thêm route login + auth guard |
| `src/newtab/App.vue` | Sửa auth dialog redirect |
| `src/popup/App.vue` | Thêm auth check + redirect |
| `src/components/newtab/app/AppSidebar.vue` | Thêm nút logout |
| `src/utils/api.js` | Xử lý 401 global |
| `src/locales/en/newtab.json` | Thêm locale keys |

---

## Thứ tự thực hiện

```
Phase 1 (Config)          ← Không phụ thuộc, làm đầu tiên
    ↓
Phase 2 (Auth)            ← Phụ thuộc Phase 1 (dùng env vars cho API URL)
    ↓
Phase 3 (Workflow API)    ← Phụ thuộc Phase 1 + 2 (dùng env vars + auth tokens)
    ↓
Phase 4 (Migrate Store)   ← Phụ thuộc Phase 3 (dùng workflowApi.js)
    ↓
Phase 5 (UI Updates)      ← Phụ thuộc Phase 2 + 4
```

---

## Kiểm tra (Verification)

1. **Config**: Chạy `pnpm dev`, verify `process.env.BACKEND_API_URL` có giá trị đúng
2. **Auth**: Mở dashboard → redirect về `/login` → nhập credentials → redirect về `/workflows`
3. **Popup**: Mở popup khi chưa login → tự mở dashboard ở trang login
4. **Workflow Create**: Tạo workflow mới → verify API POST (check Network tab) → workflow xuất hiện
5. **Workflow Update**: Sửa workflow trong editor → Save → verify API PUT
6. **Workflow Delete**: Xóa workflow → verify API DELETE → workflow biến mất
7. **Logout**: Click logout → redirect về login → popup cũng redirect
8. **Cache**: Reload dashboard → workflows hiển thị ngay từ cache, rồi sync với API
