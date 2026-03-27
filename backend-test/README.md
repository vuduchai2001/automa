# Automa WebSocket Server (Backend Test)

WebSocket server for testing Automa browser extension integration.

## Features

- ✅ WebSocket connection management
- ✅ Token-based authentication
- ✅ Workflow execution triggering
- ✅ Execution tracking and history
- ✅ RESTful API endpoints
- ✅ Automatic reconnection handling
- ✅ Health monitoring
- ✅ Heartbeat/ping mechanism

## Installation

```bash
cd backend-test
npm install
```

## Configuration

Copy `.env.example` to `.env` and configure:

```env
PORT=8000
AUTH_TOKEN=test-token-12345
INTERNAL_API_PORT=8000
INTERNAL_API_SECRET=
```

`AUTH_TOKEN` is appended to the worker-style WS URL. `INTERNAL_API_PORT` and `INTERNAL_API_SECRET` are injected into execution requests so the extension can call back `/action-log`, `/artifact-log`, `/workflow-log`, and `/finish-job`.

## Running the Server

### Development Mode (with auto-reload)

```bash
npm run dev
```

### Production Mode

```bash
npm start
```

The server will start on `http://localhost:8000`

For the no-login worker flow, open the bootstrap tab URL in the same browser profile where the extension is installed:

```text
http://localhost:8000/automa-init?profile_id=profile-backend-test&ws_url=ws://127.0.0.1:8000/ws?token=test-token-12345&internal_api_port=8000
```

The extension background reads the `automa-init` tab URL and bootstraps WS/internal API settings without going through the interactive login flow.

## API Endpoints

### Health Check

```bash
GET /health
```

### List Connected Extensions

```bash
GET /api/extensions
```

### Browser Session Management

```bash
GET /api/browser-sessions
POST /api/browser-sessions/launch
POST /api/browser-sessions/:profileId/close
```

`/api/browser-sessions/launch` starts a Playwright persistent Chromium session, loads the built extension from `../build`, opens `/automa-init`, and waits for the extension WebSocket connection.

### Execute Workflow on Specific Extension

```bash
POST /api/execute
Content-Type: application/json

{
  "extensionId": "chrome-extension-id",
  "workflow": {
    "drawflow": {
      "nodes": [...],
      "edges": [...]
    },
    "settings": {},
    "name": "Test Workflow"
  },
  "inputs": {
    "variable1": "value1"
  },
  "options": {}
}
```

If `connectionId` / `profileId` is omitted, the backend can auto-launch a browser session first when `autoLaunchBrowser: true`.

### Execute Smoke Workflow

```bash
POST /api/execute-smoke
Content-Type: application/json

{
  "profileId": "pw-ui-session",
  "autoLaunchBrowser": true,
  "relaunchBrowser": false
}
```

### Execute Workflow on All Extensions

```bash
POST /api/execute-all
Content-Type: application/json

{
  "workflow": {...},
  "inputs": {...}
}
```

### Stop Workflow Execution

```bash
POST /api/stop/:executionId
```

### Get Execution History

```bash
GET /api/executions
```

### Get Specific Execution

```bash
GET /api/executions/:executionId
```

### Get Extension Status

```bash
POST /api/status/:extensionId
```

### Ping Extension

```bash
POST /api/ping/:extensionId
```

## WebSocket Protocol

### Connection

Connect to: `ws://localhost:8000/ws?token=test-token-12345`

### Messages from Extension → Server

**1. Identify**

```json
{
  "type": "identify",
  "data": {
    "extensionId": "chrome-extension-id",
    "installationId": "unique-id",
    "version": "1.0.0"
  }
}
```

**2. Workflow Started**

```json
{
  "command": "workflow_started",
  "executionId": "uuid",
  "workflowId": "workflow-id",
  "timestamp": 1234567890
}
```

**3. Workflow Completed**

```json
{
  "type": "workflow_completed",
  "executionId": "uuid",
  "workflowId": "workflow-id",
  "status": "success",
  "duration": 5000,
  "timestamp": 1234567890
}
```

**4. Workflow Failed**

```json
{
  "type": "workflow_failed",
  "executionId": "uuid",
  "error": {
    "message": "Error message",
    "stack": "Stack trace"
  },
  "timestamp": 1234567890
}
```

### Messages from Server → Extension

**1. Execute Workflow**

```json
{
  "command": "executeAction",
  "request_id": "uuid",
  "params": {
    "action_id": "action-uuid",
    "action_index": 0,
    "workflow_id": "workflow-id",
    "workflow_name": "Workflow Name",
    "workflow_version": "1.0.0",
    "workflow_config": {...},
    "params": {...},
    "options": {...},
    "internal_api_port": 8000,
    "internal_api_secret": null
  }
}
```

**2. Stop Workflow**

```json
{
  "type": "stop_workflow",
  "data": {
    "executionId": "uuid"
  }
}
```

**3. Get Status**

```json
{
  "command": "get_status",
  "requestId": "uuid"
}
```

**4. Ping**

```json
{
  "command": "ping",
  "requestId": "uuid"
}
```

### Worker Internal API Endpoints

- `GET /healthz`
- `POST /action-log`
- `POST /workflow-log`
- `POST /artifact-log`
- `POST /finish-job`

## Testing with cURL

### Execute a simple workflow

```bash
curl -X POST http://localhost:8000/api/execute \
  -H "Content-Type: application/json" \
  -d '{
    "extensionId": "your-extension-id",
    "workflow": {
      "drawflow": {
        "nodes": [
          {
            "id": "trigger-1",
            "label": "trigger",
            "data": {}
          }
        ],
        "edges": []
      },
      "name": "Simple Test Workflow"
    },
    "inputs": {
      "testVar": "testValue"
    }
  }'
```

### Check connected extensions

```bash
curl http://localhost:8000/api/extensions
```

### Launch browser session

```bash
curl -X POST http://localhost:8000/api/browser-sessions/launch \
  -H "Content-Type: application/json" \
  -d '{
    "profileId": "pw-ui-session",
    "relaunch": true,
    "waitForConnection": true
  }'
```

### Run smoke workflow

```bash
curl -X POST http://localhost:8000/api/execute-smoke \
  -H "Content-Type: application/json" \
  -d '{
    "profileId": "pw-ui-session",
    "autoLaunchBrowser": true
  }'
```

### Get execution history

```bash
curl http://localhost:8000/api/executions
```

## Example Workflow Structure

```json
{
  "drawflow": {
    "nodes": [
      {
        "id": "trigger-1",
        "label": "trigger",
        "data": {}
      },
      {
        "id": "new-tab-1",
        "label": "new-tab",
        "data": {
          "url": "https://example.com",
          "active": true
        }
      },
      {
        "id": "delay-1",
        "label": "delay",
        "data": {
          "time": 2000
        }
      }
    ],
    "edges": [
      {
        "id": "edge-1",
        "source": "trigger-1",
        "target": "new-tab-1",
        "sourceHandle": "trigger-1-output-1",
        "targetHandle": "new-tab-1-input-1"
      },
      {
        "id": "edge-2",
        "source": "new-tab-1",
        "target": "delay-1",
        "sourceHandle": "new-tab-1-output-1",
        "targetHandle": "delay-1-input-1"
      }
    ]
  },
  "name": "Example Workflow",
  "settings": {
    "saveLog": true,
    "blockDelay": 0
  }
}
```

## Monitoring

The server logs all activities including:

- ✅ Connection/disconnection events
- 📨 Incoming messages
- 🚀 Workflow executions
- ❌ Errors and failures
- 💓 Heartbeat status

## Troubleshooting

### Extension not connecting

1. Check if server is running: `curl http://localhost:8000/health`
2. Verify AUTH_TOKEN matches in both server and extension
3. Check browser console for WebSocket errors

### Workflow not executing

1. Check if extension is in connected list: `GET /api/extensions`
2. Verify workflow structure is valid
3. Check server logs for errors

### Connection drops frequently

1. Check network stability
2. Monitor server logs for errors
3. Verify heartbeat mechanism is working

## Security Notes

⚠️ **This is a test server**. For production use:

- Use HTTPS/WSS (secure WebSocket)
- Implement proper authentication (OAuth, JWT)
- Add rate limiting
- Validate all inputs
- Use a real database
- Add logging and monitoring
- Implement access control

## License

MIT
