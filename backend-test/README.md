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
```

⚠️ **Important**: The `AUTH_TOKEN` must match the token configured in your browser extension.

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

## API Endpoints

### Health Check
```bash
GET /health
```

### List Connected Extensions
```bash
GET /api/extensions
```

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
Connect to: `ws://localhost:8000?token=test-token-12345`

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
  "type": "workflow_started",
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
  "type": "execute_workflow",
  "data": {
    "executionId": "uuid",
    "workflow": {...},
    "inputs": {...},
    "options": {...}
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
  "type": "get_status",
  "requestId": "uuid"
}
```

**4. Ping**
```json
{
  "type": "ping",
  "requestId": "uuid"
}
```

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

