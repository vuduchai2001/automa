# AGENTS.md

File này cung cấp hướng dẫn cho các AI Agent (Claude, Codex) khi làm việc với repository này.

## Tổng quan dự án

Automa là browser extension (Chrome & Firefox) tự động hóa tác vụ trình duyệt bằng visual block-based workflow builder. Người dùng kết nối các block để tạo automation: điền form, scraping, chụp ảnh, đặt lịch, v.v. Xây dựng với Vue 3, Webpack 5 và Manifest V3.

## Lệnh Build & Development

```bash
pnpm install          # Cài đặt dependencies
pnpm dev              # Chrome dev với hot reload
pnpm dev:firefox      # Firefox dev với hot reload
pnpm build            # Chrome production build
pnpm build:firefox    # Firefox production build
pnpm build:prod       # Build production cho cả Chrome & Firefox
pnpm build:zip        # Tạo ZIP từ thư mục build/
pnpm lint             # Chạy ESLint
pnpm prettier         # Format code
```

**Điều kiện tiên quyết:** Trước khi chạy dev/build, cần tạo file `src/utils/getPassKey.js`:
```js
export default function() {
  return 'anything-you-want';
}
```

**Node:** 20.11.1 (qua volta) | **Package manager:** pnpm

## Kiến trúc

Đây là **multi-context browser extension** với 8+ webpack entry bundle. Mỗi context chạy độc lập và giao tiếp qua message passing.

### Các Execution Context

| Context | Entry | Mục đích |
|---------|-------|----------|
| **Background** (Service Worker) | `src/background/index.js` | Xử lý event, điều phối workflow, WebSocket, không có DOM access |
| **Content Script** | `src/content/index.js` | Tương tác DOM, thực thi block trên trang web |
| **Newtab** (Dashboard) | `src/newtab/index.js` | UI chính - workflow editor (Vue Flow), quản lý, cài đặt |
| **Popup** | `src/popup/index.js` | Extension popup (350x500px) |
| **Sandbox** | `src/sandbox/index.js` | Thực thi JavaScript an toàn |
| **Offscreen** | `src/offscreen/index.js` | Offscreen document (MV3) |
| **Params** | `src/params/index.js` | Trang nhập tham số workflow |
| **Execute** | `src/execute/index.js` | Trang thực thi workflow |

Content script cũng tạo các bundle riêng: `elementSelector`, `recordWorkflow`, `webService`.

### Workflow Engine (`src/workflowEngine/`)

Phần cốt lõi của Automa. Luồng thực thi:

```
Trigger → WorkflowManager.execute() → WorkflowEngine.init() → WorkflowWorker.executeBlock()
  → Block Handler → block tiếp theo hoặc hoàn thành → WorkflowEngine.destroy()
```

- **WorkflowManager** - Singleton quản lý toàn bộ workflow đang chạy
- **WorkflowEngine** - Quản lý state, connections map, luồng thực thi block (tuần tự/song song/vòng lặp)
- **WorkflowWorker** - Thực thi từng block thông qua handler function
- **`blocksHandler/`** - 60+ file handler (`handlerDelay.js`, `handlerNewTab.js`, `handlerJavascriptCode.js`, v.v.)

Block handler signature:
```js
async function handler(blockData, { refData, prevBlock, ...execParam }) {
  return { data, nextBlockId, status: 'success' | 'error' };
}
```

### Message Passing (`src/utils/message.js`)

Giao tiếp giữa các context sử dụng class `MessageListener`:
```js
import { MessageListener, sendMessage } from '@/utils/message';
const message = new MessageListener('background');
message.on('workflow:execute', async (data, sender) => { ... });
await sendMessage('workflow:execute', data, 'background');
```
Quy tắc đặt tên event: `[module]:[action]` (ví dụ: `workflow:execute`, `browser-api:call`).

### Quản lý State

Pinia store trong `src/stores/` theo quy tắc `use[Name]Store` (ví dụ: `useWorkflowStore`).

### Database

Dexie (IndexedDB wrapper) trong `src/db/` — lưu trữ workflows, packages, schedules, logs.

### Tầng UI

- **Vue 3 Composition API** với `<script setup>`
- **Tailwind CSS** cho styling (custom colors: primary, secondary, accent)
- **Vue Flow** cho visual workflow builder
- **CodeMirror 6** cho code editor
- **TipTap** cho rich text editor
- UI component có prefix `Ui*` trong `src/components/ui/`, đăng ký global

### Đa ngôn ngữ

10 ngôn ngữ trong `src/locales/`. Sử dụng Vue I18n.

## Quy tắc chính

- **File component:** PascalCase (`UiButton.vue`, `WorkflowEditor.vue`)
- **Props:** camelCase; v-model dùng `modelValue` prop + `update:modelValue` emit
- **CSS:** Tailwind utilities; custom class có prefix `ui-`
- **Path alias:** `@/` → `src/`
- **ESLint:** Airbnb base + Vue 3 recommended + Prettier
- **Browser global:** `BROWSER_TYPE` có sẵn toàn cục
- **Manifests:** `manifest.chrome.json` (MV3) và `manifest.firefox.json` ở thư mục gốc

## Tích hợp WebSocket (Gần đây)

`BackgroundWebSocket.js` quản lý kết nối WebSocket lâu dài tới backend để nhận yêu cầu thực thi workflow từ xa. Hỗ trợ tự động kết nối lại với exponential backoff.
