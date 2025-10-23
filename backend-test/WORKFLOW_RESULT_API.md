# Workflow Result API Documentation

## Overview

Sau khi workflow execution hoàn thành, extension sẽ tự động gửi kết quả chi tiết về backend qua WebSocket.

## Message Type: `workflow_result`

### Message Structure

```json
{
  "type": "workflow_result",
  "executionId": "exec-abc123",
  "workflowId": "wf-xyz789",
  "status": "success" | "error" | "stopped",
  "message": "Workflow completed successfully",
  "duration": 5432,
  "timestamp": 1234567890000,
  "data": {
    "table": [...],
    "variables": {...},
    "extractedData": {...}
  },
  "logs": [...]
}
```

### Field Descriptions

#### Top Level Fields

| Field | Type | Description |
|-------|------|-------------|
| `type` | string | Message type, always `"workflow_result"` |
| `executionId` | string | Unique execution ID từ backend request |
| `workflowId` | string | Workflow ID trong extension |
| `status` | string | Execution status: `"success"`, `"error"`, hoặc `"stopped"` |
| `message` | string | Human-readable status message |
| `duration` | number | Execution duration in milliseconds |
| `timestamp` | number | Completion timestamp (Unix epoch milliseconds) |

#### Data Object

##### `data.table`
- **Type**: `Array<Object>`
- **Description**: Extracted table data từ workflow
- **Example**:
  ```json
  [
    { "name": "John", "email": "john@example.com" },
    { "name": "Jane", "email": "jane@example.com" }
  ]
  ```

##### `data.variables`
- **Type**: `Object`
- **Description**: Workflow variables và values
- **Example**:
  ```json
  {
    "userName": "John Doe",
    "userId": "12345",
    "totalItems": 42
  }
  ```

##### `data.extractedData`
- **Type**: `Object`
- **Description**: Extracted summary data (generated nếu table rỗng)
- **Structure**:
  ```json
  {
    "blocksExecuted": 12,
    "blockTypes": {
      "new-tab": 1,
      "element-click": 3,
      "forms": 2
    },
    "executionTime": 5432,
    "errors": []
  }
  ```

#### Logs Array

- **Type**: `Array<Object>`
- **Description**: Chi tiết execution history của từng block
- **Example**:
  ```json
  [
    {
      "blockId": "block-1",
      "name": "new-tab",
      "type": "success",
      "message": "Tab opened successfully",
      "timestamp": 1234567890000,
      "duration": 123
    },
    {
      "blockId": "block-2",
      "name": "element-click",
      "type": "success",
      "message": "Element clicked",
      "timestamp": 1234567890100,
      "duration": 45
    }
  ]
  ```

## Backend Server Handling

### 1. WebSocket Message Handler

```javascript
case 'workflow_result':
  handleWorkflowResult(message);
  break;
```

### 2. Store in Execution History

```javascript
function handleWorkflowResult(message) {
  const execution = executionHistory.get(message.executionId) || {};
  executionHistory.set(message.executionId, {
    ...execution,
    status: message.status,
    message: message.message,
    completedAt: message.timestamp,
    duration: message.duration,
    data: message.data,        // ✅ Full data object
    logs: message.logs,        // ✅ Full logs array
  });
  
  logExecutionResults(message.executionId, message);
}
```

### 3. API Endpoints

#### Get All Executions
```
GET /api/executions
```

**Response**:
```json
{
  "count": 5,
  "executions": [
    {
      "executionId": "exec-abc123",
      "workflowId": "wf-xyz789",
      "status": "success",
      "message": "Workflow completed successfully",
      "duration": 5432,
      "data": { ... },
      "logs": [ ... ]
    }
  ]
}
```

#### Get Specific Execution
```
GET /api/executions/:executionId
```

**Response**:
```json
{
  "executionId": "exec-abc123",
  "workflowId": "wf-xyz789",
  "status": "success",
  "message": "Workflow completed successfully",
  "duration": 5432,
  "completedAt": 1234567890000,
  "completedAtFormatted": "2024-01-15T10:30:00.000Z",
  "data": {
    "table": [...],
    "variables": {...},
    "extractedData": {...}
  },
  "logs": [...]
}
```

## Extension Implementation

### 1. Monitor Workflow Completion

```javascript
async monitorWorkflowExecution(executionId, workflowId) {
  // Poll workflow state every 1 second
  const checkStatus = async () => {
    const { workflowStates } = await browser.storage.local.get('workflowStates');
    const state = workflowStates.find(s => s.workflowId === workflowId);
    
    if (!state) {
      // Workflow completed, fetch results
      const results = await this.getWorkflowResults(workflowId);
      
      this.send({
        type: 'workflow_result',
        executionId,
        workflowId,
        status: results.status,
        message: results.message,
        duration: Date.now() - execution.startedAt,
        timestamp: Date.now(),
        data: results.data,
        logs: results.logs,
      });
    }
  };
}
```

### 2. Fetch Results from Logs Database

```javascript
async getWorkflowResults(workflowId) {
  const dbLogs = (await import('@/db/logs')).default;
  
  // Find most recent log
  const logItems = await dbLogs.items
    .where('workflowId')
    .equals(workflowId)
    .reverse()
    .limit(1)
    .toArray();
    
  const logItem = logItems[0];
  
  // Fetch associated data
  const [logsData, histories] = await Promise.all([
    dbLogs.logsData.where('logId').equals(logItem.id).first(),
    dbLogs.histories.where('logId').equals(logItem.id).first(),
  ]);
  
  return {
    status: logItem.status,
    message: logItem.message,
    data: {
      table: logsData?.data?.table || [],
      variables: logsData?.data?.variables || {},
    },
    logs: histories?.data || [],
  };
}
```

## Usage Examples

### Example 1: Simple Workflow Result

**Request** (POST `/api/execute`):
```json
{
  "extensionId": "ext-123",
  "workflow": {
    "name": "Login Test",
    "drawflow": { ... }
  },
  "inputs": {
    "username": "test@example.com",
    "password": "secret123"
  }
}
```

**Result Message** (WebSocket):
```json
{
  "type": "workflow_result",
  "executionId": "exec-abc123",
  "status": "success",
  "message": "Workflow completed successfully",
  "duration": 3245,
  "data": {
    "table": [],
    "variables": {
      "loginStatus": "success",
      "userId": "12345"
    },
    "extractedData": {
      "blocksExecuted": 5,
      "blockTypes": {
        "new-tab": 1,
        "forms": 1,
        "element-click": 2,
        "save-variables": 1
      },
      "executionTime": 3245,
      "errors": []
    }
  },
  "logs": [
    {
      "blockId": "1",
      "name": "new-tab",
      "type": "success",
      "message": "New tab opened",
      "duration": 123
    },
    {
      "blockId": "2",
      "name": "forms",
      "type": "success",
      "message": "Form filled",
      "duration": 456
    }
  ]
}
```

### Example 2: Data Extraction Workflow

**Result with Table Data**:
```json
{
  "type": "workflow_result",
  "executionId": "exec-xyz789",
  "status": "success",
  "message": "Data extracted successfully",
  "duration": 8934,
  "data": {
    "table": [
      {
        "title": "Product 1",
        "price": "$29.99",
        "rating": "4.5"
      },
      {
        "title": "Product 2",
        "price": "$39.99",
        "rating": "4.8"
      }
    ],
    "variables": {
      "totalProducts": 2,
      "averagePrice": "$34.99"
    }
  },
  "logs": [...]
}
```

### Example 3: Error Handling

**Result with Error**:
```json
{
  "type": "workflow_result",
  "executionId": "exec-err123",
  "status": "error",
  "message": "Element not found: #submit-button",
  "duration": 5234,
  "data": {
    "table": [],
    "variables": {},
    "extractedData": {
      "blocksExecuted": 3,
      "blockTypes": {
        "new-tab": 1,
        "element-click": 1
      },
      "executionTime": 5234,
      "errors": [
        {
          "blockId": "3",
          "blockName": "element-click",
          "message": "Element not found: #submit-button",
          "timestamp": 1234567890000
        }
      ]
    }
  },
  "logs": [...]
}
```

## Console Output

Backend server sẽ log results với format đẹp:

```
╔═══════════════════════════════════════════════════╗
║ 📦 WORKFLOW RESULT: exec-abc123            ║
╠═══════════════════════════════════════════════════╣
║ Status:   SUCCESS                                  ║
║ Message:  Workflow completed successfully          ║
║ Duration: 5432ms                                   ║
╠═══════════════════════════════════════════════════╣
║ 📊 DATA:                                          ║
║   - Table rows: 2                                  ║
║   - Variables: 3                                   ║
║     • userName: "John Doe"                         ║
║     • userId: "12345"                              ║
║     • totalItems: 42                               ║
║   - Extracted Data:                                ║
║     • Blocks: 12                                   ║
║     • Time: 5432ms                                 ║
╠═══════════════════════════════════════════════════╣
║ 📝 LOGS: 12                                        ║
║   1. new-tab: success                              ║
║   2. element-click: success                        ║
║   3. forms: success                                ║
║   4. save-variables: success                       ║
║   5. element-click: success                        ║
║   ... and 7 more logs                              ║
╚═══════════════════════════════════════════════════╝
```

## Testing

### 1. Start Backend Server
```bash
cd backend-test
node server.js
```

### 2. Enable Extension WebSocket
Open `backend-test/enable-websocket.html` trong browser với extension đã cài

### 3. Send Test Workflow
```bash
node backend-test/test-client.js execute test-workflow.json
```

### 4. View Results

**In Backend Console**:
- Xem formatted output box với data chi tiết

**Via API**:
```bash
curl http://localhost:8000/api/executions
```

**Via Dashboard**:
Open `http://localhost:8000` để xem execution history với full data

## Notes

- ✅ Workflow results được fetch từ extension's IndexedDB logs
- ✅ Automatically sent khi workflow completes
- ✅ Includes full table data, variables, và execution logs
- ✅ Timeout protection (5 minutes max)
- ✅ Error handling cho missing logs
- ✅ Sample data extraction nếu table rỗng
- ✅ Full API access to all execution data

## Next Steps

1. **Process Data**: Backend có thể process `data.table` cho business logic
2. **Store Results**: Save vào database nếu cần persistent storage
3. **Notifications**: Trigger notifications dựa trên `status` và `data`
4. **Analytics**: Analyze `logs` và `extractedData` cho monitoring
5. **Webhooks**: Forward results đến external services

