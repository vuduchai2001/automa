# Plan: Hỗ trợ Worker Mode (production) - không cần user login

## Context

Trong production, worker mở browser, load extension Automa và thực thi lệnh qua WS. Không có user login → không có `session` trong storage → `BackgroundWebSocket.init()` skip kết nối → worker không gửi được lệnh.

**Quyết định:**
- Worker inject `workerMode: true` vào `chrome.storage.local` (cùng lúc với `profile_id`, `ws_port`)
- WS local không cần auth token — chỉ route bằng `profile_id`
- Internal API dùng `internalApiSecret` đã có
- Extension không cần gọi IAM/Control plane — worker gửi toàn bộ `workflow_config` qua WS

---

## Phân tích: Các chỗ bị block bởi session check

| File | Chỗ check | Hậu quả khi không có session |
|------|-----------|------------------------------|
| `BackgroundWebSocket.js:60-64` | `init()` check `session.access_token` | **Return early → WS không kết nối** |
| `BackgroundWebSocket.js:152-156` | `connect()` gọi `getAccessToken()` | **Return early → WS không kết nối** |
| `BackgroundWebSocket.js:196` | `onOpen()` gọi `getAccessToken()` | Token = null → identify message thiếu token |
| `BackgroundWebSocket.js:719-723` | `scheduleReconnect()` check session | **Skip reconnect** |
| `background/index.js:30-40` | Storage listener chỉ watch `session` | Không trigger WS init khi worker inject config |
| Stores (workflow, folder, package) | `isAuthenticated()` check | Skip fetch → dùng local cache (OK, không cần) |
| Router guards | `isAuthenticated()` check | Redirect to login (OK, không có UI trong worker mode) |

**Chỉ cần sửa 2 file:** `BackgroundWebSocket.js` và `background/index.js`

---

## Bước 1: BackgroundWebSocket.init() — bypass session check khi workerMode

**File:** `src/background/BackgroundWebSocket.js`
**Method:** `init()` (~dòng 58-126)

Đọc `workerMode` từ storage. Nếu `true`, skip session check:

```javascript
// Đọc workerMode
const { workerMode } = await browser.storage.local.get('workerMode');
this.workerMode = !!workerMode;

// Check auth — skip nếu workerMode
if (!this.workerMode) {
  const { session } = await browser.storage.local.get('session');
  if (!session?.access_token) {
    console.info('[WebSocket] Not authenticated, skipping connection');
    return;
  }
}
```

---

## Bước 2: BackgroundWebSocket.connect() — skip token check khi workerMode

**File:** `src/background/BackgroundWebSocket.js`
**Method:** `connect()` (~dòng 149-183)

```javascript
async connect(url) {
  try {
    // Skip token check in worker mode — local WS doesn't need IAM auth
    if (!this.workerMode) {
      const token = await getAccessToken();
      if (!token) {
        console.info('[WebSocket] No access token, skipping connection');
        return;
      }
    }
    // ...rest of connect logic unchanged
  }
}
```

---

## Bước 3: BackgroundWebSocket.onOpen() — identify không cần token khi workerMode

**File:** `src/background/BackgroundWebSocket.js`
**Method:** `onOpen()` (~dòng 188-224)

```javascript
async onOpen() {
  this.isConnected = true;

  // Get token only if not in worker mode
  const token = this.workerMode ? null : await getAccessToken();

  this.send({
    type: 'identify',
    data: {
      extensionId: browser.runtime.id,
      installationId: this.installationId,
      profileId: this.profileId,
      version: browser.runtime.getManifest().version,
      token,                    // null in worker mode
      workerMode: this.workerMode,  // signal to server
    },
  });
  // ...rest unchanged
}
```

---

## Bước 4: BackgroundWebSocket.scheduleReconnect() — skip session check khi workerMode

**File:** `src/background/BackgroundWebSocket.js`
**Method:** `scheduleReconnect()` (~dòng 706-732)

```javascript
// Skip auth check before reconnecting in worker mode
if (!this.workerMode) {
  const { session } = await browser.storage.local.get('session');
  if (!session?.access_token) {
    console.info('[WebSocket] Not authenticated, stopping reconnect');
    return;
  }
}
```

---

## Bước 5: background/index.js — listen workerMode storage change

**File:** `src/background/index.js`
**Storage listener** (~dòng 24-40)

Hiện tại chỉ listen `changes.session`. Cần thêm listen `workerMode`:

```javascript
browser.storage.local.onChanged.addListener((changes) => {
  // Existing session handling
  if (changes.session) {
    const hadToken = !!changes.session.oldValue?.access_token;
    const hasToken = !!changes.session.newValue?.access_token;
    if (!hadToken && hasToken) {
      BackgroundWebSocket.instance.init();
    } else if (hadToken && !hasToken) {
      BackgroundWebSocket.instance.disconnect();
    }
  }

  // NEW: Worker mode activation
  if (changes.workerMode) {
    const wasWorkerMode = !!changes.workerMode.oldValue;
    const isWorkerMode = !!changes.workerMode.newValue;
    if (!wasWorkerMode && isWorkerMode) {
      BackgroundWebSocket.instance.init();
    }
  }
});
```

Giải quyết race condition: nếu worker inject `workerMode` SAU khi extension đã load (init() đã return early vì không có session), storage change listener sẽ trigger `init()` lại.

---

## Tóm tắt files cần sửa

| File | Thay đổi |
|------|----------|
| `src/background/BackgroundWebSocket.js` | 4 methods: `init()`, `connect()`, `onOpen()`, `scheduleReconnect()` — bypass auth checks khi `workerMode` |
| `src/background/index.js` | Storage listener thêm watch `workerMode` changes |

---

## Worker cần inject vào chrome.storage.local

```json
{
  "workerMode": true,
  "profile_id": "<profile-id>",
  "ws_port": 18765,
  "internalApiPort": 9091,
  "internalApiSecret": "<optional-secret>"
}
```

---

## Không cần sửa

- **Stores** (workflow, folder, package, user): Đã có `isAuthenticated()` check → skip fetch → OK
- **Router guards**: Redirect to login → OK (worker mode không mở newtab)
- **auth.js / api.js**: Không thay đổi — chỉ worker mode bypass ở tầng WebSocket
- **WorkerApiClient**: Đã dùng `internalApiSecret` — không phụ thuộc session
- **handlerTakeScreenshotAndLog**: `sendScreenshotToBackend()` return early nếu không có `runtimeApiUrl` — OK

---

## Verification

1. **Worker mode**: Inject `workerMode: true` + `profile_id` + wsConfig vào storage → WS kết nối thành công không cần login
2. **User mode**: Không inject `workerMode` → hoạt động bình thường, vẫn yêu cầu login
3. **Race condition**: Inject `workerMode` sau khi extension load → storage listener trigger init()
4. **Reconnect**: Disconnect WS → reconnect tự động không bị block bởi session check
5. **Identify message**: Worker mode gửi identify với `token: null`, `workerMode: true`
