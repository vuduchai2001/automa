# Automa Extension Development Guide (Worker + Runtime Contract)

Status: Source-of-truth implementation guide for extension team  
Audience: Team building/maintaining the Automa browser extension used by Spysocia Worker  
Last updated: 2026-02-27

---

## 1) Purpose and scope

This guide defines the real integration contract between:

- `spysocia_worker` (job execution, browser lifecycle, internal WS/HTTP for extension), and
- `spysocia_runtime` (worker auth/session and extension download API).

Goal: extension implementation must be deterministic and compatible with current production code paths.

Important: this document is based on current implementation and tests, not old design docs.

---

## 2) Source of truth (read these first)

Worker-side:

- `services/spysocia_worker/spysocia_worker/drivers/automa/ws_server.py`
- `services/spysocia_worker/spysocia_worker/drivers/automa/driver.py`
- `services/spysocia_worker/spysocia_worker/jobs/browser_callbacks.py`
- `services/spysocia_worker/spysocia_worker/browser/storage/extension_storage.py`
- `services/spysocia_worker/spysocia_worker/internal_api/server.py`
- `services/spysocia_worker/spysocia_worker/internal_api/handlers.py`
- `services/spysocia_worker/spysocia_worker/jobs/orchestrator.py`
- `services/spysocia_worker/spysocia_worker/app.py`
- `services/spysocia_worker/spysocia_worker/config.py`

Runtime-side (auth + download behavior):

- `services/spysocia_runtime/spysocia_runtime/modules/extensions/router.py`
- `services/spysocia_runtime/spysocia_runtime/modules/extensions/service.py`
- `services/spysocia_runtime/spysocia_runtime/modules/workers/websocket_router.py`
- `libs/middleware/middleware/middleware/authentication.py`

Behavior tests (protocol evidence):

- `services/spysocia_worker/tests/unit/drivers/test_automa_ws_server.py`
- `services/spysocia_worker/tests/unit/drivers/test_automa_driver.py`

---

## 3) End-to-end architecture

At runtime, one Worker instance does all of the following:

1. Connects to Runtime WebSocket using JWT in query string (`/api/v1/runtime/ws?...&token=...`).
2. Receives `job.assign`.
3. Ensures extension package is installed locally (`automa` by default for automa driver jobs).
4. Starts/uses internal Automa WS server (default port `18765`, configurable).
5. Launches Orbita with:
   - extension load args,
   - init tab URL `http://127.0.0.1:{ws_port}/automa-init?...`,
   - grid/other browser flags.
6. Extension connects back to worker WS endpoint:
   - `ws://127.0.0.1:{ws_port}/ws?profile_id={profile_id}`
7. Worker executes actions by WS command/response with `request_id` correlation.
8. Extension can send callback logs to worker internal HTTP API (`127.0.0.1:{internal_api_port}`).

---

## 4) Bootstrap contract (extension startup)

Extension must obtain two values early:

- `profile_id` (string)
- `ws_port` (int)

Worker provides them by two independent channels.

### 4.1 Channel A: Pre-injected `chrome.storage.local`

Before browser launch, worker writes into extension storage LevelDB:

```json
{
  "profile_id": "<profile-id>",
  "ws_port": 18765
}
```

Implementation path:

- write logic: `jobs/browser_callbacks.py` -> `inject_profile_to_extensions(...)`
- storage implementation: `browser/storage/extension_storage.py`

Notes:

- Worker computes extension ID from extension path; do not assume static ID in worker logic.
- This channel supports cold start and reconnect flows.

### 4.2 Channel B: init tab query params

Worker opens init page URL:

`http://127.0.0.1:{ws_port}/automa-init?profile_id=...&ws_port=...&tenant_id=...`

`/automa-init` HTML is served by worker and intended for extension background to parse tab URL and persist values.

Implementation path:

- URL build: `jobs/browser_callbacks.py` (`build_chrome_extra_args`)
- page endpoint: `drivers/automa/ws_server.py` (`_handle_init_page_async`)

### 4.3 Extension requirement

Extension startup should:

1. Try read `chrome.storage.local` for `profile_id`, `ws_port`.
2. If missing/invalid, parse from latest `automa-init` tab URL.
3. Persist normalized values back to storage.
4. Start WS connection loop.

---

## 5) WebSocket protocol: worker <-> extension

Endpoint (extension -> worker):

- `GET /ws?profile_id={profile_id}`
- host is local worker process (`127.0.0.1` from extension perspective)

Router behavior:

- one active WS per `profile_id`
- new connection for same `profile_id` replaces old one
- commands are routed by `profile_id`

Implementation path:

- `drivers/automa/ws_server.py`

### 5.1 Command envelope (worker -> extension)

```json
{
  "request_id": "uuid",
  "command": "executeAction",
  "params": {"...": "..."}
}
```

`request_id` is mandatory correlation key.

### 5.2 Response envelope (extension -> worker)

Success:

```json
{
  "request_id": "same-uuid",
  "status": "ok",
  "data": {"...": "..."}
}
```

Failure:

```json
{
  "request_id": "same-uuid",
  "status": "error",
  "error": "human-readable",
  "error_code": "ERR_ACTION_FAILED"
}
```

Rules:

- extension must echo exact `request_id`
- extension should always return either `status=ok` or `status=error`
- unsolicited messages are tolerated but ignored for command completion

### 5.3 Supported commands in current worker

#### A) `executeAction`

Input (`params`) currently sent by worker:

```json
{
  "action_id": "string",
  "action_type": "string",
  "workflow_id": "string",
  "workflow_name": "string",
  "workflow_version": "string",
  "workflow_config": {},
  "params": {},
  "timeout_seconds": 300,
  "retry_policy": {},
  "priority": 5,
  "delay": 1000
}
```

`delay` is optional and only included when found in incoming action params (`delay`, `delay_ms`, or `delayMs`).

Success expectation:

- return `status=ok`
- return action output in `data` (opaque map; worker forwards it)

Failure expectation:

- return `status=error`
- include `error_code` when possible

#### B) `captureScreenshot`

Expected success payload:

```json
{
  "request_id": "...",
  "status": "ok",
  "data": {
    "screenshot": "<base64 PNG bytes>"
  }
}
```

#### C) `captureHTML`

Expected success payload:

```json
{
  "request_id": "...",
  "status": "ok",
  "data": {
    "html": "<full page html>"
  }
}
```

---

## 6) Driver-side behavior your extension must tolerate

From `drivers/automa/driver.py`:

- init waits connection by `profile_id`, timeout default `60s`, up to `init_max_attempts` (default `3`).
- if launch callback fails, init fails immediately.
- if disconnected mid-job, worker waits passive reconnect (`extension_reconnect_wait_sec`, default `10s`).
- if still disconnected, worker may relaunch browser and wait again.

Extension implications:

- reconnection must be automatic and fast.
- connection loop must survive MV3 service worker restarts.
- stale socket must be replaced cleanly.

---

## 7) Internal callback HTTP API (extension -> worker)

Base URL from worker config:

- `http://127.0.0.1:{WORKER_INTERNAL_API_PORT}`
- default port is `9091`

Routes:

- `POST /action-log`
- `POST /artifact-log`
- `POST /workflow-log`
- `POST /finish-job`
- `GET /healthz`

Implementation path:

- server: `internal_api/server.py`
- handlers: `internal_api/handlers.py`

### 7.1 Auth behavior

- If `WORKER_INTERNAL_API_SECRET` is empty: no auth required.
- If set: extension must send `Authorization: Bearer <secret>`.
- `/healthz` bypasses auth.

### 7.2 Payload contracts

#### `POST /action-log`

```json
{
  "job_id": "...",
  "action_index": 0,
  "log_level": "info",
  "log_type": "general",
  "message": "...",
  "log_data": {}
}
```

Worker validates active `job_id`, then forwards to runtime WS as `action_log`.

#### `POST /workflow-log`

Same shape as action-log. Worker forwards as `action_log` with `log_type="workflow"`.

#### `POST /artifact-log`

```json
{
  "job_id": "...",
  "action_index": 0,
  "artifact_type": "screenshot",
  "artifact_name": "step-1.png",
  "data_base64": "...",
  "mime_type": "image/png",
  "captured_at": "2026-02-28T12:00:00Z",
  "metadata": {"workflow_step_id": "step-1"}
}
```

Worker validates payload and queues artifact for asynchronous upload to Ingestor.

Important separation:

- `action-log`: workflow/action log data only.
- `artifact-log`: artifact binaries only.

#### `POST /finish-job`

```json
{
  "job_id": "..."
}
```

Current behavior: worker sets `cancel_event` for that job context.

Important semantic note:

- This is not a direct `job.completed` write.
- It signals executor control flow via cancellation event.

### 7.3 HTTP response rules

- invalid JSON -> `400`
- missing/unknown `job_id` -> `404`
- success:
  - `/action-log`, `/workflow-log`, `/finish-job` -> `200 {"status":"ok"}`
  - `/artifact-log` -> `202 {"status":"queued", ...}`
- payload errors:
  - `/artifact-log` invalid base64 -> `400`
  - `/artifact-log` too large -> `413`
  - `/action-log`/`/artifact-log` invalid `action_index` -> `422`

---

## 8) Runtime auth and tenant constraints relevant to extension

### 8.1 Worker <-> Runtime WS auth

Worker connects to runtime WS with JWT query token. Runtime middleware validates JWT and injects tenant context.

If tenant in query mismatches JWT claim, runtime rejects connection.

Key paths:

- worker URL builder: `connection/ws_client.py`
- runtime WS checks: `modules/workers/websocket_router.py`
- middleware auth: `libs/middleware/middleware/middleware/authentication.py`

### 8.2 Extension package download auth

Worker downloads extension metadata through runtime endpoint:

- `GET /api/v1/runtime/extensions/download/{name}`

This request uses worker JWT bearer header from `RuntimeHTTPClient`.

Tenant scoping is done by runtime using authenticated current user context (`CurrentUserDeps`).

Key paths:

- worker client: `clients/runtime_http.py`
- runtime endpoint: `modules/extensions/router.py` (`download_latest`)
- tenant fallback logic: `modules/extensions/service.py` (`get_latest_for_worker_async`)

---

## 9) Reliability and failure model

### 9.1 Worker-visible failures

- no extension connection on init timeout -> `ConnectionError` -> job fails.
- command timeout -> mapped to `ERR_ACTION_TIMEOUT`.
- extension disconnected and recovery failed -> mapped to `ERR_EXTENSION_DISCONNECTED`.
- extension-level error response -> mapped to response `error_code` or fallback `ERR_ACTION_FAILED`.

### 9.2 Extension implementation requirements

- maintain WS reconnect loop with bounded backoff.
- on reconnect, always use latest `profile_id` and `ws_port` from storage.
- command handler must be idempotent per request handling path where possible.
- enforce response deadline shorter than worker command timeout budget.

---

## 10) Reference extension architecture (recommended)

MV3 modules:

1. `background/service_worker`
   - owns connection state and command dispatch
   - parses init tab updates and storage changes
2. `ws_client`
   - connect/reconnect, heartbeat (optional), send/receive JSON
3. `command_router`
   - switch by `command`: `executeAction`, `captureScreenshot`, `captureHTML`
4. `workflow_executor`
   - executes workflow/action and returns normalized result envelope
5. `callback_client`
   - POST `action-log` / `workflow-log` / `finish-job` to worker internal API
6. `state_store`
   - persistent profile/ws config in `chrome.storage.local`

Design constraints:

- never block service worker event loop for long-running work without async control.
- always correlate response by `request_id`.
- sanitize sensitive log fields before callback.

---

## 11) Test matrix for extension team

### 11.1 Protocol unit tests (extension repo)

- parse and validate incoming command envelope
- echo `request_id` on all paths
- `executeAction` success and error response shapes
- screenshot/html command response formats
- reconnect on socket close and worker restart

### 11.2 Integration with worker (local)

Run worker and validate:

1. Extension connects within init timeout.
2. Action command round-trip succeeds for real job.
3. Callback endpoints accept and forward logs.
4. Reconnect path works after forced socket disconnect.

Suggested in-repo evidence tests already covering worker side:

- `tests/unit/drivers/test_automa_ws_server.py`
- `tests/unit/drivers/test_automa_driver.py`

### 11.3 Failure injection tests

- delay response beyond timeout -> worker reports timeout code.
- disconnect during in-flight request -> worker handles pending future failure.
- wrong/missing `request_id` -> request does not complete (expected mismatch behavior).
- internal API with wrong bearer when secret enabled -> 401/403.

---

## 12) Observability and logging recommendations

Extension logs (local):

- WS state transitions: connect, disconnect, reconnect attempt/success
- command receive/finish with `request_id`, command name, duration, status
- callback POST status and latency

Do not log:

- JWT/internal secret values
- sensitive workflow payload fields containing credentials/cookies

Worker-side evidence logs already available:

- `Automa extension connected (profile_id=...)`
- `Automa extension disconnected (profile_id=...)`
- `Automa driver initialized`

---

## 13) Doc drift (old docs vs real implementation)

These mismatches were verified and must not be used as integration truth:

1. `docs/flows/DRIVER_ABSTRACTION.md`
   - says AutomaDriver WS is placeholder/not implemented.
   - actual code has implemented WS command/response flow.

2. `docs/flows/EXTENSION_MANAGEMENT.md`
   - says extension modules not wired into `WorkerApp`.
   - actual `WorkerApp` wires and uses `ExtensionManager` in orchestrator path.

3. `docs/flows/JOB_EXECUTION.md` and related docs
   - mention internal API port `18080`.
   - actual default is `9091` (`WORKER_INTERNAL_API_PORT`).

4. `docs/api/EXTENSION_MANAGEMENT.md`
   - describes legacy endpoints (`/api/v1/extensions/...`, download by extension_id).
   - actual worker calls `/api/v1/runtime/extensions/download/{name}`.

5. `docs/api/DRIVER_ABSTRACTION.md`
   - describes old `method: executeWorkflow` protocol.
   - actual protocol is `request_id + command + params`.

---

## 14) Acceptance checklist (definition of done for extension)

- [ ] On browser launch, extension resolves `profile_id` and `ws_port` from storage/init-tab and connects WS.
- [ ] Extension responds to `executeAction`, `captureScreenshot`, `captureHTML` with correct envelope and `request_id` correlation.
- [ ] Extension survives disconnections and reconnects automatically without manual reload.
- [ ] Callback APIs (`/action-log`, `/artifact-log`, `/workflow-log`, `/finish-job`) work with and without internal secret mode.
- [ ] End-to-end worker job run completes successfully in real path with Automa connected logs.
- [ ] Negative tests prove expected behavior for timeout/disconnect/request mismatch.

---

## 15) Change management note

When changing protocol or payload shape:

1. update worker + extension together,
2. update tests first or in same PR,
3. update this guide and mark compatibility impact,
4. avoid silent contract drift.
