const WebSocket = require('ws');
const express = require('express');
const http = require('http');
const cors = require('cors');
const fs = require('fs');
const path = require('path');
const { v4: uuidv4 } = require('uuid');
require('dotenv').config();

const app = express();

// Increase payload limit for large screenshots
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ limit: '50mb', extended: true }));
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

// Middleware
app.use(cors());
app.use(express.json());
app.use(express.static('public'));

// Configuration
const PORT = process.env.PORT || 8000;
const AUTH_TOKEN = process.env.AUTH_TOKEN || 'test-token-12345';

// Data store (in production, use a real database)
const connectedExtensions = new Map();
const executionHistory = new Map();

// Ensure logs directory exists
const logsDir = path.join(__dirname, 'logs');
if (!fs.existsSync(logsDir)) {
  fs.mkdirSync(logsDir, { recursive: true });
}

// Ensure images directory exists
const imagesDir = path.join(__dirname, 'images');
if (!fs.existsSync(imagesDir)) {
  fs.mkdirSync(imagesDir, { recursive: true });
}

// ═══════════════════════════════════════════════════════════
// WEBSOCKET CONNECTION HANDLER
// ═══════════════════════════════════════════════════════════
// Extension (BackgroundWebSocket.js) connects with:
//   ws://host?profile_id=... (NOT ?token=...)
// Then sends identify message with JWT token in message body.
// All messages TO extension use "command" field (not "type").
// Extension reads message.command for routing.

wss.on('connection', (ws, req) => {
  const urlParams = new URL(req.url, `http://${req.headers.host}`);
  const profileId = urlParams.searchParams.get('profile_id');

  // Accept all connections — auth is validated via JWT in identify message
  console.log('✅ New WebSocket connection established', profileId ? `(profile: ${profileId})` : '');

  let extensionId = null;
  let extensionInfo = null;
  let isAuthenticated = false;

  // ─────────────────────────────────────────────────────────
  // Handle incoming messages from extension
  // ─────────────────────────────────────────────────────────
  ws.on('message', (data) => {
    try {
      const message = JSON.parse(data.toString());
      console.log('📨 Received from extension:', message.type);

      switch (message.type) {
        case 'identify':
          handleIdentify(ws, message);
          break;

        case 'workflow_started':
          handleWorkflowStarted(message);
          break;

        case 'workflow_completed':
          handleWorkflowCompleted(message);
          break;

        case 'workflow_result':
          handleWorkflowResult(message);
          break;

        case 'workflow_failed':
          handleWorkflowFailed(message);
          break;

        case 'workflow_stopped':
          handleWorkflowStopped(message);
          break;

        case 'pong':
          console.log('💓 Pong received');
          break;

        case 'status_response':
          console.log('📊 Status response:', message.data);
          break;

        default:
          console.warn('⚠️  Unknown message type:', message.type);
      }
    } catch (error) {
      console.error('❌ Error handling message:', error);
      ws.send(JSON.stringify({
        type: 'error',
        error: {
          message: error.message,
          stack: error.stack,
        },
      }));
    }
  });

  // ─────────────────────────────────────────────────────────
  // Handle connection close
  // ─────────────────────────────────────────────────────────
  ws.on('close', (code, reason) => {
    console.log(`🔌 Connection closed: ${code} - ${reason}`);
    if (extensionId) {
      connectedExtensions.delete(extensionId);
      console.log(`📤 Extension ${extensionId} removed from connected list`);
    }
  });

  // ─────────────────────────────────────────────────────────
  // Handle errors
  // ─────────────────────────────────────────────────────────
  ws.on('error', (error) => {
    console.error('❌ WebSocket error:', error);
  });

  // ─────────────────────────────────────────────────────────
  // Message handlers
  // ─────────────────────────────────────────────────────────

  function handleIdentify(ws, message) {
    // Extension sends: { type: 'identify', data: { extensionId, installationId, profileId, version, token } }
    // Validate JWT token from identify message (mock: accept any mock-jwt-* or non-empty token)
    const jwtToken = message.data.token;
    if (jwtToken) {
      // In mock server: validate against mockSessions
      const session = mockSessions.get(jwtToken);
      if (session) {
        isAuthenticated = true;
        console.log(`🔐 Extension authenticated via JWT (user: ${session.user.email})`);
      } else {
        // Accept anyway in dev mode, just log warning
        isAuthenticated = true;
        console.warn(`⚠️  Extension JWT not in mockSessions, accepting in dev mode`);
      }
    } else {
      isAuthenticated = true;
      console.warn('⚠️  Extension connected without JWT token, accepting in dev mode');
    }

    extensionId = message.data.extensionId;
    extensionInfo = {
      extensionId: message.data.extensionId,
      installationId: message.data.installationId,
      profileId: message.data.profileId || profileId,
      version: message.data.version,
      connectedAt: new Date().toISOString(),
      ws: ws,
    };

    connectedExtensions.set(extensionId, extensionInfo);
    console.log('🔗 Extension identified:', {
      extensionId: extensionInfo.extensionId,
      profileId: extensionInfo.profileId,
      version: extensionInfo.version,
    });

    // Send welcome message — extension reads message.command
    ws.send(JSON.stringify({
      command: 'welcome',
      message: 'Successfully connected to Automa WebSocket Server',
      serverVersion: '1.0.0',
      timestamp: Date.now(),
    }));
  }

  function handleWorkflowStarted(message) {
    console.log('🚀 Workflow started:', {
      executionId: message.executionId,
      workflowId: message.workflowId,
    });
    
    const execution = executionHistory.get(message.executionId) || {};
    executionHistory.set(message.executionId, {
      ...execution,
      executionId: message.executionId,
      workflowId: message.workflowId,
      status: 'running',
      startedAt: message.timestamp,
      startedAtFormatted: new Date(message.timestamp).toISOString(),
    });
  }

  function handleWorkflowCompleted(message) {
    console.log('✅ Workflow completed:', {
      executionId: message.executionId,
      status: message.status,
      duration: message.duration ? `${message.duration}ms` : 'N/A',
    });
    
    const execution = executionHistory.get(message.executionId) || {};
    executionHistory.set(message.executionId, {
      ...execution,
      status: 'completed',
      completedAt: message.timestamp,
      completedAtFormatted: new Date(message.timestamp).toISOString(),
      duration: message.duration,
      result: message.data,
    });
    
    // Log completion
    logExecution(message.executionId);
  }

  function handleWorkflowResult(message) {
    console.log('📦 Workflow result received:', {
      executionId: message.executionId,
      status: message.status,
      duration: message.duration ? `${message.duration}ms` : 'N/A',
    });
    
    // Log detailed response data
    console.log('📊 [Backend] Full workflow response:', {
      executionId: message.executionId,
      workflowId: message.workflowId,
      status: message.status,
      message: message.message,
      duration: message.duration,
      timestamp: message.timestamp,
      dataKeys: message.data ? Object.keys(message.data) : [],
      logsCount: message.logs ? message.logs.length : 0,
      hasTableData: message.data?.table ? message.data.table.length : 0,
      hasVariables: message.data?.variables ? Object.keys(message.data.variables).length : 0,
      hasExtractedData: !!message.data?.extractedData,
      sampleData: {
        table: message.data?.table?.slice(0, 2) || [],
        variables: message.data?.variables ? Object.keys(message.data.variables).slice(0, 5) : [],
        logs: message.logs?.slice(0, 3) || []
      }
    });
    
    const execution = executionHistory.get(message.executionId) || {};
    executionHistory.set(message.executionId, {
      ...execution,
      status: message.status,
      message: message.message,
      completedAt: message.timestamp,
      completedAtFormatted: new Date(message.timestamp).toISOString(),
      duration: message.duration,
      data: message.data,
      logs: message.logs,
    });
    
    // Log detailed results
    logExecutionResults(message.executionId, message);
  }

  function handleWorkflowFailed(message) {
    console.log('❌ Workflow failed:', {
      executionId: message.executionId,
      error: message.error?.message,
    });
    
    const execution = executionHistory.get(message.executionId) || {};
    executionHistory.set(message.executionId, {
      ...execution,
      status: 'failed',
      completedAt: message.timestamp,
      completedAtFormatted: new Date(message.timestamp).toISOString(),
      error: message.error,
    });
    
    // Log failure
    logExecution(message.executionId);
  }

  function handleWorkflowStopped(message) {
    console.log('⏸️  Workflow stopped:', {
      executionId: message.executionId,
      workflowId: message.workflowId,
    });
    
    const execution = executionHistory.get(message.executionId) || {};
    executionHistory.set(message.executionId, {
      ...execution,
      status: 'stopped',
      stoppedAt: message.timestamp,
      stoppedAtFormatted: new Date(message.timestamp).toISOString(),
    });
  }

  function logExecution(executionId) {
    const execution = executionHistory.get(executionId);
    if (execution) {
      console.log('📋 Execution Summary:');
      console.log('   Execution ID:', execution.executionId);
      console.log('   Workflow ID:', execution.workflowId);
      console.log('   Status:', execution.status);
      console.log('   Started:', execution.startedAtFormatted);
      console.log('   Completed:', execution.completedAtFormatted);
      if (execution.duration) {
        console.log('   Duration:', `${execution.duration}ms`);
      }
      if (execution.error) {
        console.log('   Error:', execution.error.message);
      }
      console.log('─────────────────────────────────────────────────');
    }
  }

  function logExecutionResults(executionId, message) {
    console.log('');
    console.log('╔═══════════════════════════════════════════════════╗');
    console.log(`║ 📦 WORKFLOW RESULT: ${executionId.substring(0, 20).padEnd(27)} ║`);
    console.log('╠═══════════════════════════════════════════════════╣');
    console.log(`║ Status:   ${message.status.toUpperCase().padEnd(40)} ║`);
    console.log(`║ Message:  ${(message.message || '').substring(0, 40).padEnd(40)} ║`);
    console.log(`║ Duration: ${(message.duration + 'ms').padEnd(40)} ║`);
    console.log('╠═══════════════════════════════════════════════════╣');
    
    if (message.data) {
      console.log('║ 📊 DATA:                                          ║');
      
      if (message.data.table && message.data.table.length > 0) {
        console.log(`║   - Table rows: ${String(message.data.table.length).padEnd(33)} ║`);
        console.log(`║   - Sample: ${JSON.stringify(message.data.table[0]).substring(0, 35).padEnd(37)} ║`);
      }
      
      if (message.data.variables && Object.keys(message.data.variables).length > 0) {
        const varCount = Object.keys(message.data.variables).length;
        console.log(`║   - Variables: ${String(varCount).padEnd(32)} ║`);
        Object.entries(message.data.variables).slice(0, 3).forEach(([key, value]) => {
          const varLine = `${key}: ${JSON.stringify(value)}`.substring(0, 37);
          console.log(`║     • ${varLine.padEnd(41)} ║`);
        });
      }
      
      if (message.data.extractedData) {
        console.log('║   - Extracted Data:                               ║');
        console.log(`║     • Blocks: ${String(message.data.extractedData.blocksExecuted).padEnd(33)} ║`);
        console.log(`║     • Time: ${String(message.data.extractedData.executionTime + 'ms').padEnd(35)} ║`);
        if (message.data.extractedData.errors && message.data.extractedData.errors.length > 0) {
          console.log(`║     • Errors: ${String(message.data.extractedData.errors.length).padEnd(33)} ║`);
        }
      }
    }
    
    if (message.logs && message.logs.length > 0) {
      console.log('╠═══════════════════════════════════════════════════╣');
      console.log(`║ 📝 LOGS: ${String(message.logs.length).padEnd(40)} ║`);
      message.logs.slice(0, 5).forEach((log, i) => {
        const logLine = `${log.name || 'Block'}: ${log.type || 'info'}`.substring(0, 40);
        console.log(`║   ${String(i + 1)}. ${logLine.padEnd(44)} ║`);
      });
      if (message.logs.length > 5) {
        console.log(`║   ... and ${String(message.logs.length - 5)} more logs${' '.repeat(28)} ║`);
      }
    }
    
    console.log('╚═══════════════════════════════════════════════════╝');
    console.log('');
  }
});

// ═══════════════════════════════════════════════════════════
// REST API ENDPOINTS
// ═══════════════════════════════════════════════════════════

// Health check
app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    timestamp: new Date().toISOString(),
    connectedExtensions: connectedExtensions.size,
    uptime: process.uptime(),
  });
});

// Get connected extensions
app.get('/api/extensions', (req, res) => {
  const extensions = Array.from(connectedExtensions.values()).map(ext => ({
    extensionId: ext.extensionId,
    installationId: ext.installationId,
    version: ext.version,
    connectedAt: ext.connectedAt,
  }));
  
  res.json({
    count: extensions.length,
    extensions,
  });
});

// Execute workflow on specific extension
app.post('/api/execute', (req, res) => {
  const { extensionId, workflow, inputs, options } = req.body;
  
  // Validate request
  if (!extensionId) {
    return res.status(400).json({ error: 'extensionId is required' });
  }
  
  if (!workflow) {
    return res.status(400).json({ error: 'workflow is required' });
  }
  
  // Check if extension is connected
  const extension = connectedExtensions.get(extensionId);
  if (!extension || extension.ws.readyState !== WebSocket.OPEN) {
    return res.status(400).json({ 
      error: 'Extension not connected',
      extensionId,
    });
  }
  
  // Generate execution ID
  const executionId = uuidv4();
  
  // Store execution info
  executionHistory.set(executionId, {
    executionId,
    extensionId,
    status: 'pending',
    requestedAt: Date.now(),
    workflow: {
      name: workflow.name,
      id: workflow.id,
    },
  });
  
  // Send execution request to extension
  // Extension (BackgroundWebSocket.js) reads: message.command === 'executeAction'
  // Then: message.request_id for executionId
  //       message.params.workflow_config for workflow data
  //       message.params.options for execution options
  //       message.params.params for input variables
  const message = {
    command: 'executeAction',
    request_id: executionId,
    params: {
      workflow_config: workflow,
      options: options || {},
      params: inputs || {},
    },
  };

  try {
    extension.ws.send(JSON.stringify(message));
    console.log('📤 Workflow execution request sent:', {
      executionId,
      extensionId,
      workflowName: workflow.name,
    });
    
    res.json({
      success: true,
      executionId,
      status: 'pending',
      message: 'Workflow execution request sent to extension',
    });
  } catch (error) {
    console.error('❌ Error sending message:', error);
    res.status(500).json({
      error: 'Failed to send message to extension',
      message: error.message,
    });
  }
});

// Execute workflow (broadcast to all extensions)
app.post('/api/execute-all', (req, res) => {
  const { workflow, inputs, options } = req.body;
  
  if (!workflow) {
    return res.status(400).json({ error: 'workflow is required' });
  }
  
  if (connectedExtensions.size === 0) {
    return res.status(400).json({ error: 'No extensions connected' });
  }
  
  const results = [];
  
  connectedExtensions.forEach((extension, extensionId) => {
    if (extension.ws.readyState === WebSocket.OPEN) {
      const executionId = uuidv4();
      
      const message = {
        command: 'executeAction',
        request_id: executionId,
        params: {
          workflow_config: workflow,
          options: options || {},
          params: inputs || {},
        },
      };
      
      try {
        extension.ws.send(JSON.stringify(message));
        results.push({
          extensionId,
          executionId,
          status: 'sent',
        });
      } catch (error) {
        results.push({
          extensionId,
          status: 'failed',
          error: error.message,
        });
      }
    }
  });
  
  res.json({
    success: true,
    message: `Sent to ${results.length} extensions`,
    results,
  });
});

// Stop workflow execution
app.post('/api/stop/:executionId', (req, res) => {
  const { executionId } = req.params;
  
  const execution = executionHistory.get(executionId);
  if (!execution) {
    return res.status(404).json({ error: 'Execution not found' });
  }
  
  const extension = connectedExtensions.get(execution.extensionId);
  if (!extension || extension.ws.readyState !== WebSocket.OPEN) {
    return res.status(400).json({ error: 'Extension not connected' });
  }
  
  const message = {
    command: 'stop_workflow',
    data: { executionId },
  };
  
  try {
    extension.ws.send(JSON.stringify(message));
    res.json({
      success: true,
      message: 'Stop request sent to extension',
    });
  } catch (error) {
    res.status(500).json({
      error: 'Failed to send stop request',
      message: error.message,
    });
  }
});

// Get execution history
app.get('/api/executions', (req, res) => {
  const executions = Array.from(executionHistory.values())
    .sort((a, b) => (b.requestedAt || 0) - (a.requestedAt || 0))
    .slice(0, 100); // Last 100 executions
  
  res.json({
    count: executions.length,
    executions,
  });
});

// Get specific execution
app.get('/api/executions/:executionId', (req, res) => {
  const { executionId } = req.params;
  const execution = executionHistory.get(executionId);
  
  if (!execution) {
    return res.status(404).json({ error: 'Execution not found' });
  }
  
  res.json(execution);
});

// Get extension status
app.post('/api/status/:extensionId', (req, res) => {
  const { extensionId } = req.params;
  
  const extension = connectedExtensions.get(extensionId);
  if (!extension || extension.ws.readyState !== WebSocket.OPEN) {
    return res.status(400).json({ error: 'Extension not connected' });
  }
  
  const requestId = uuidv4();
  
  const message = {
    command: 'get_status',
    requestId,
  };
  
  try {
    extension.ws.send(JSON.stringify(message));
    res.json({
      success: true,
      message: 'Status request sent',
      requestId,
    });
  } catch (error) {
    res.status(500).json({
      error: 'Failed to send status request',
      message: error.message,
    });
  }
});

// Send ping to extension
app.post('/api/ping/:extensionId', (req, res) => {
  const { extensionId } = req.params;
  
  const extension = connectedExtensions.get(extensionId);
  if (!extension || extension.ws.readyState !== WebSocket.OPEN) {
    return res.status(400).json({ error: 'Extension not connected' });
  }
  
  const requestId = uuidv4();
  const startTime = Date.now();
  
  const message = {
    command: 'ping',
    requestId,
  };
  
  try {
    extension.ws.send(JSON.stringify(message));
    res.json({
      success: true,
      message: 'Ping sent',
      requestId,
      sentAt: startTime,
    });
  } catch (error) {
    res.status(500).json({
      error: 'Failed to send ping',
      message: error.message,
    });
  }
});

// Receive workflow log data from extension
app.post('/api/workflow-log', (req, res) => {
  const { workflowId, status, timestamp, workflowRefData, variables, globalData, tableData } = req.body;
  
  if (!workflowId) {
    return res.status(400).json({ error: 'workflowId is required' });
  }
  
  try {
    // Create log data object
    const logData = {
      workflowId,
      status,
      timestamp,
      receivedAt: new Date().toISOString(),
      workflowRefData,
      tableData: tableData || [],
      variables,
      globalData,
    };
    
    // Generate filename with timestamp - handle invalid dates gracefully
    let date;
    let dateStr, timeStr;
    
    try {
      date = timestamp ? new Date(timestamp) : new Date();
      
      // Check if date is valid
      if (isNaN(date.getTime())) {
        console.warn('⚠️  [Backend] Invalid timestamp, using current date:', timestamp);
        date = new Date();
      }
      
      dateStr = date.toISOString().split('T')[0]; // YYYY-MM-DD
      timeStr = date.toTimeString().split(' ')[0].replace(/:/g, '-'); // HH-MM-SS
    } catch (dateError) {
      console.warn('⚠️  [Backend] Error parsing timestamp:', dateError);
      date = new Date();
      dateStr = date.toISOString().split('T')[0];
      timeStr = date.toTimeString().split(' ')[0].replace(/:/g, '-');
    }
    
    const filename = `workflow-${workflowId}-${dateStr}-${timeStr}.json`;
    const filepath = path.join(logsDir, filename);
    
    // Write to file
    fs.writeFileSync(filepath, JSON.stringify(logData, null, 2));
    
    console.log('📝 [Backend] Workflow log saved:', {
      workflowId,
      status,
      filename,
      filepath,
      dataSize: JSON.stringify(logData).length
    });
    
    res.json({
      success: true,
      message: 'Workflow log saved successfully',
      filename,
      workflowId,
      status,
    });
  } catch (error) {
    console.error('❌ [Backend] Error saving workflow log:', error);
    res.status(500).json({
      error: 'Failed to save workflow log',
      message: error.message,
    });
  }
});

// Receive screenshot from extension
app.post('/api/screenshot', (req, res) => {
  const { 
    workflowId, 
    blockId, 
    blockLabel, 
    errorMessage, 
    errorStack, 
    status,
    timestamp, 
    screenshotDataUrl, 
    activeTabUrl 
  } = req.body;
  
  if (!workflowId || !screenshotDataUrl) {
    return res.status(400).json({ error: 'workflowId and screenshotDataUrl are required' });
  }
  
  try {
    // Extract base64 data from data URL
    const base64Data = screenshotDataUrl.replace(/^data:image\/[a-z]+;base64,/, '');
    
    // Generate filename with timestamp and status
    const date = new Date(timestamp);
    const dateStr = date.toISOString().split('T')[0]; // YYYY-MM-DD
    const timeStr = date.toTimeString().split(' ')[0].replace(/:/g, '-'); // HH-MM-SS
    const statusPrefix = status === 'success' ? 'success' : status === 'manual' ? 'manual' : 'error';
    const filename = `screenshot-${statusPrefix}-${workflowId}-${blockId}-${dateStr}-${timeStr}.jpg`;
    const filepath = path.join(imagesDir, filename);
    
    // Write image file
    fs.writeFileSync(filepath, base64Data, 'base64');
    
    // Create metadata file
    const metadata = {
      workflowId,
      blockId,
      blockLabel,
      status: status || 'error',
      errorMessage,
      errorStack,
      timestamp,
      activeTabUrl,
      filename,
      filepath,
      receivedAt: new Date().toISOString(),
    };
    
    const metadataFilename = `screenshot-${statusPrefix}-${workflowId}-${blockId}-${dateStr}-${timeStr}.json`;
    const metadataFilepath = path.join(imagesDir, metadataFilename);
    fs.writeFileSync(metadataFilepath, JSON.stringify(metadata, null, 2));
    
    console.log('📸 [Backend] Screenshot saved:', {
      workflowId,
      blockId,
      blockLabel,
      status: status || 'error',
      filename,
      filepath,
      errorMessage: errorMessage?.substring(0, 50) + '...'
    });
    
    res.json({
      success: true,
      message: 'Screenshot saved successfully',
      filename,
      metadataFilename,
      workflowId,
      blockId,
    });
  } catch (error) {
    console.error('❌ [Backend] Error saving screenshot:', error);
    res.status(500).json({
      error: 'Failed to save screenshot',
      message: error.message,
    });
  }
});

// Receive screenshot-step from extension
app.post('/api/screenshot-step', (req, res) => {
  const { 
    screenshot, 
    blockId, 
    blockLabel, 
    tabUrl, 
    tabTitle, 
    timestamp, 
    workflowId, 
    description, 
    screenshotType,
    elementHTML,
    pageHTML,
    htmlContent
  } = req.body;
  
  if (!workflowId) {
    return res.status(400).json({ error: 'workflowId is required' });
  }
  
  try {
    const date = new Date(timestamp);
    const dateStr = date.toISOString().split('T')[0];
    const timeStr = date.toTimeString().split(' ')[0].replace(/:/g, '-');
    
    let filename = '';
    let filepath = '';
    
    // Handle screenshot if provided
    if (screenshot && screenshotType !== 'html') {
      // Extract base64 data from data URL
      const base64Data = screenshot.replace(/^data:image\/[a-z]+;base64,/, '');
      
      // Generate filename with timestamp
      filename = `step-${workflowId}-${blockId}-${dateStr}-${timeStr}.jpg`;
      filepath = path.join(imagesDir, filename);
      
      // Write image file
      fs.writeFileSync(filepath, base64Data, 'base64');
    }
    
    // Handle HTML content if provided
    if (htmlContent || elementHTML || pageHTML) {
      const htmlFilename = `step-${workflowId}-${blockId}-${dateStr}-${timeStr}.txt`;
      const htmlFilepath = path.join(imagesDir, htmlFilename);
      
      // Use htmlContent if available, otherwise fallback to elementHTML or pageHTML
      const contentToSave = htmlContent || elementHTML || pageHTML || '';
      fs.writeFileSync(htmlFilepath, contentToSave, 'utf8');
      
      // Update filename to include HTML file
      if (filename) {
        filename += `, ${htmlFilename}`;
      } else {
        filename = htmlFilename;
      }
    }
    
    // Create metadata file
    const metadata = {
      workflowId,
      blockId,
      blockLabel,
      tabUrl,
      tabTitle,
      timestamp,
      description,
      screenshotType,
      prevStep: req.body.prevStep || null,
      filename,
      filepath,
      hasScreenshot: !!(screenshot && screenshotType !== 'html'),
      hasHTML: !!(htmlContent || elementHTML || pageHTML),
      receivedAt: new Date().toISOString(),
    };
    
    const metadataFilename = `step-${workflowId}-${blockId}-${dateStr}-${timeStr}.json`;
    const metadataFilepath = path.join(imagesDir, metadataFilename);
    fs.writeFileSync(metadataFilepath, JSON.stringify(metadata, null, 2));
    
    console.log('📸 [Backend] Step data saved:', {
      workflowId,
      blockId,
      blockLabel,
      filename,
      hasScreenshot: !!(screenshot && screenshotType !== 'html'),
      hasHTML: !!(htmlContent || elementHTML || pageHTML),
      tabTitle: tabTitle?.substring(0, 30) + '...'
    });
    
    res.json({
      success: true,
      message: 'Step data saved successfully',
      filename,
      metadataFilename,
      workflowId,
      blockId,
      hasScreenshot: !!(screenshot && screenshotType !== 'html'),
      hasHTML: !!(htmlContent || elementHTML || pageHTML)
    });
  } catch (error) {
    console.error('❌ [Backend] Error saving step data:', error);
    res.status(500).json({
      error: 'Failed to save step data',
      message: error.message,
    });
  }
});

// ═══════════════════════════════════════════════════════════
// MOCK AUTH & RESOURCE CRUD ENDPOINTS
// Routes match the actual backend API paths used by the extension
// ═══════════════════════════════════════════════════════════

// In-memory data stores
const mockUsers = new Map();
const mockWorkflows = new Map();  // id -> ActionWorkflowResponse format
const mockVersions = new Map();   // workflowId -> [version, ...]
const mockFolders = new Map();
const mockPackages = new Map();
const mockSessions = new Map();

// Seed a default test user
const TEST_USER = {
  id: 'user-1',
  email: 'test@automa.dev',
  username: 'testuser',
  tenant_id: 'tenant-1',
};
mockUsers.set(TEST_USER.email, { ...TEST_USER, password: '123456' });

// Helper: generate a mock JWT-like token
function generateMockToken() {
  return 'mock-jwt-' + uuidv4();
}

// Helper: current ISO timestamp
function nowISO() {
  return new Date().toISOString();
}

// Helper: build ActionWorkflowResponse from internal data
function toWorkflowResponse(wf) {
  return {
    id: wf.id,
    name: wf.name,
    code: wf.code || `wf_${wf.id}`,
    platform_code: wf.platform_code || 'default',
    description: wf.description || '',
    status: wf.status || 'draft',
    version: wf.version || 1,
    workflow_config: wf.workflow_config || {},
    created_at: wf.created_at,
    updated_at: wf.updated_at,
  };
}

// Helper: auth middleware (validates Bearer token)
function authMiddleware(req, res, next) {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({ message: 'Unauthorized - No token provided' });
  }

  const token = authHeader.split(' ')[1];
  const session = mockSessions.get(token);
  if (!session) {
    return res.status(401).json({ message: 'Unauthorized - Invalid token' });
  }

  req.user = session.user;
  next();
}

// Helper: find session by refresh token
function findSessionByRefreshToken(refreshToken) {
  for (const [accessToken, session] of mockSessions) {
    if (session.refresh_token === refreshToken) {
      return { accessToken, session };
    }
  }
  return null;
}

// Helper: create new session tokens
function createNewSession(user, oldAccessToken) {
  if (oldAccessToken) mockSessions.delete(oldAccessToken);

  const accessToken = generateMockToken();
  const refreshToken = 'refresh-' + uuidv4();
  const expiresIn = 3600;
  const expiresAt = Math.floor(Date.now() / 1000) + expiresIn;

  const session = {
    access_token: accessToken,
    refresh_token: refreshToken,
    expires_at: expiresAt,
    expires_in: expiresIn,
    session_id: 'session-' + uuidv4().substring(0, 8),
    user,
  };

  mockSessions.set(accessToken, session);
  return session;
}

// Seed workflows in ActionWorkflowResponse format
const defaultWorkflowConfig = {
  drawflow: {
    edges: [],
    zoom: 1.3,
    nodes: [
      {
        position: { x: 100, y: 300 },
        id: 'node-trigger-1',
        label: 'trigger',
        data: { type: 'manual' },
        type: 'BlockTrigger',
      },
    ],
  },
  settings: {
    publicId: '',
    blockDelay: 0,
    saveLog: true,
    debugMode: false,
    restartTimes: 3,
    notification: true,
    execContext: 'popup',
    reuseLastState: false,
    inputAutocomplete: true,
    onError: 'stop-workflow',
    executedBlockOnWeb: false,
    insertDefaultColumn: false,
    defaultColumnName: 'column',
  },
  globalData: '{\n\t"key": "value"\n}',
  table: [],
  dataColumns: [],
  icon: 'riGlobalLine',
  trigger: null,
  isDisabled: false,
  folderId: null,
};

const seedWorkflows = [
  {
    id: 'wf-mock-1',
    name: 'Mock Workflow 1 - Google Search',
    code: 'wf_google_search',
    platform_code: 'default',
    description: 'A mock workflow that searches Google',
    status: 'draft',
    version: 1,
    workflow_config: {
      ...defaultWorkflowConfig,
      icon: 'riGlobalLine',
    },
    created_at: new Date(Date.now() - 86400000 * 3).toISOString(),
    updated_at: new Date(Date.now() - 86400000).toISOString(),
  },
  {
    id: 'wf-mock-2',
    name: 'Mock Workflow 2 - Form Fill',
    code: 'wf_form_fill',
    platform_code: 'default',
    description: 'A mock workflow that fills forms',
    status: 'approved',
    version: 3,
    workflow_config: {
      ...defaultWorkflowConfig,
      icon: 'riFileEditLine',
    },
    created_at: new Date(Date.now() - 86400000 * 2).toISOString(),
    updated_at: new Date(Date.now() - 3600000).toISOString(),
  },
];
seedWorkflows.forEach((wf) => {
  mockWorkflows.set(wf.id, wf);
  // Seed version history
  mockVersions.set(wf.id, [
    {
      id: `ver-${wf.id}-1`,
      workflow_id: wf.id,
      version: 1,
      changelog: 'Initial version',
      update_type: 'manual',
      created_at: wf.created_at,
    },
  ]);
});

// Seed default folders
const seedFolders = [
  { id: 'folder-1', name: 'My Automations' },
  { id: 'folder-2', name: 'Scraping' },
];
seedFolders.forEach((f) => mockFolders.set(f.id, f));

// Seed default packages
const seedPackages = [
  {
    id: 'pkg-1',
    name: 'Login Flow',
    icon: 'mdiPackageVariantClosed',
    isExternal: false,
    content: null,
    inputs: [],
    outputs: [],
    variable: [],
    settings: { asBlock: false },
    data: { edges: [], nodes: [] },
    createdAt: Date.now() - 86400000,
  },
];
seedPackages.forEach((p) => mockPackages.set(p.id, p));

// ── IAM Auth Endpoints (/api/v1/iam/auth/*) ─────────────────
// Matches: src/utils/auth.js login(), refreshToken()
// Matches: src/utils/api.js fetchApi() token rotate

// POST /api/v1/iam/auth/login/password
app.post('/api/v1/iam/auth/login/password', (req, res) => {
  const { email, password } = req.body;

  if (!email || !password) {
    return res.status(400).json({ message: 'Email and password are required' });
  }

  const user = mockUsers.get(email);
  if (!user || user.password !== password) {
    return res.status(401).json({ message: 'Invalid email or password' });
  }

  const session = createNewSession({
    id: user.id,
    email: user.email,
    tenant_id: user.tenant_id,
  });

  // auth.js does: const data = result.data || result
  // Return wrapped in { data } to match real backend
  console.log(`🔐 [Auth] Login successful: ${email}`);
  res.json({
    data: {
      access_token: session.access_token,
      refresh_token: session.refresh_token,
      expires_in: session.expires_in,
      expires_at: session.expires_at,
      session_id: session.session_id,
      user_id: user.id,
      email: user.email,
      tenant_id: user.tenant_id,
    },
  });
});

// POST /api/v1/iam/auth/rotate
// Called by: api.js fetchApi() for token refresh, auth.js refreshToken()
// Response format: direct (NOT wrapped in { data }), because api.js reads result.access_token directly
app.post('/api/v1/iam/auth/rotate', (req, res) => {
  const { refresh_token } = req.body;
  if (!refresh_token) {
    return res.status(400).json({ message: 'refresh_token is required' });
  }

  const found = findSessionByRefreshToken(refresh_token);
  if (!found) {
    return res.status(401).json({ message: 'Invalid refresh token' });
  }

  const session = createNewSession(found.session.user, found.accessToken);

  console.log(`🔄 [Auth] Token rotated for: ${found.session.user.email}`);
  res.json({
    access_token: session.access_token,
    refresh_token: session.refresh_token,
    expires_at: session.expires_at,
    expires_in: session.expires_in,
    session_id: session.session_id,
  });
});

// POST /api/v1/iam/auth/logout
app.post('/api/v1/iam/auth/logout', authMiddleware, (req, res) => {
  const token = req.headers.authorization.split(' ')[1];
  mockSessions.delete(token);
  console.log(`🚪 [Auth] Logout: ${req.user.email}`);
  res.json({ success: true });
});

// ── Workflow CRUD Endpoints (/api/v1/control/workflows/*) ────
// Matches: src/utils/workflowApi.js

// POST /api/v1/control/workflows/list — List workflows (paginated)
app.post('/api/v1/control/workflows/list', authMiddleware, (req, res) => {
  const { skip = 0, limit = 1000 } = req.body || {};
  const allWorkflows = Array.from(mockWorkflows.values());
  const paginated = allWorkflows.slice(skip, skip + limit);

  console.log(`📋 [Workflows] LIST - returning ${paginated.length}/${allWorkflows.length}`);
  res.json({
    data: paginated.map(toWorkflowResponse),
    pagination: {
      total: allWorkflows.length,
      skip,
      limit,
    },
  });
});

// GET /api/v1/control/workflows/:id — Get single workflow
app.get('/api/v1/control/workflows/:id', authMiddleware, (req, res) => {
  const wf = mockWorkflows.get(req.params.id);
  if (!wf) {
    return res.status(404).json({ message: 'Workflow not found' });
  }
  console.log(`📋 [Workflows] GET ${req.params.id} - ${wf.name}`);
  res.json({ data: toWorkflowResponse(wf) });
});

// POST /api/v1/control/workflows — Create workflow
app.post('/api/v1/control/workflows', authMiddleware, (req, res) => {
  const data = req.body;
  const id = 'wf-' + uuidv4().substring(0, 8);
  const now = nowISO();

  const wf = {
    id,
    name: data.name || 'Untitled',
    code: data.code || `wf_${Date.now()}`,
    platform_code: data.platform_code || 'default',
    description: data.description || '',
    status: 'draft',
    version: 1,
    workflow_config: data.workflow_config || {},
    created_at: now,
    updated_at: now,
  };

  mockWorkflows.set(id, wf);
  mockVersions.set(id, [
    {
      id: `ver-${id}-1`,
      workflow_id: id,
      version: 1,
      changelog: 'Initial version',
      update_type: 'manual',
      created_at: now,
    },
  ]);

  console.log(`✅ [Workflows] CREATE "${wf.name}" (${id})`);
  res.status(201).json({ data: toWorkflowResponse(wf) });
});

// PATCH /api/v1/control/workflows/:id — Update workflow config
app.patch('/api/v1/control/workflows/:id', authMiddleware, (req, res) => {
  const existing = mockWorkflows.get(req.params.id);
  if (!existing) {
    return res.status(404).json({ message: 'Workflow not found' });
  }

  const { workflow_config, changelog, update_type } = req.body;
  const now = nowISO();

  if (workflow_config) {
    existing.workflow_config = { ...existing.workflow_config, ...workflow_config };
    // Sync top-level fields from config if provided
    if (workflow_config.name) existing.name = workflow_config.name;
    if (workflow_config.description !== undefined) existing.description = workflow_config.description;
  }
  existing.updated_at = now;
  existing.version = (existing.version || 1) + 1;

  // Record version
  const versions = mockVersions.get(req.params.id) || [];
  versions.push({
    id: `ver-${req.params.id}-${existing.version}`,
    workflow_id: req.params.id,
    version: existing.version,
    changelog: changelog || 'Updated',
    update_type: update_type || 'auto',
    created_at: now,
  });
  mockVersions.set(req.params.id, versions);

  mockWorkflows.set(req.params.id, existing);
  console.log(`✏️  [Workflows] PATCH ${req.params.id} v${existing.version} - "${existing.name}"`);
  res.json({ data: toWorkflowResponse(existing) });
});

// DELETE /api/v1/control/workflows/:id — Delete workflow
app.delete('/api/v1/control/workflows/:id', authMiddleware, (req, res) => {
  const existing = mockWorkflows.get(req.params.id);
  if (!existing) {
    return res.status(404).json({ message: 'Workflow not found' });
  }

  mockWorkflows.delete(req.params.id);
  mockVersions.delete(req.params.id);
  console.log(`🗑️  [Workflows] DELETE ${req.params.id} - "${existing.name}"`);
  res.json({ data: { success: true } });
});

// POST /api/v1/control/workflows/:id/approve — Approve workflow
app.post('/api/v1/control/workflows/:id/approve', authMiddleware, (req, res) => {
  const wf = mockWorkflows.get(req.params.id);
  if (!wf) {
    return res.status(404).json({ message: 'Workflow not found' });
  }
  if (wf.status !== 'draft') {
    return res.status(400).json({ message: `Cannot approve workflow in "${wf.status}" status` });
  }

  wf.status = 'approved';
  wf.updated_at = nowISO();
  mockWorkflows.set(req.params.id, wf);

  console.log(`✅ [Workflows] APPROVE ${req.params.id} - "${wf.name}"`);
  res.json({ data: toWorkflowResponse(wf) });
});

// POST /api/v1/control/workflows/:id/deprecate — Deprecate workflow
app.post('/api/v1/control/workflows/:id/deprecate', authMiddleware, (req, res) => {
  const wf = mockWorkflows.get(req.params.id);
  if (!wf) {
    return res.status(404).json({ message: 'Workflow not found' });
  }

  wf.status = 'deprecated';
  wf.updated_at = nowISO();
  mockWorkflows.set(req.params.id, wf);

  console.log(`⚠️  [Workflows] DEPRECATE ${req.params.id} - "${wf.name}"`);
  res.json({ data: toWorkflowResponse(wf) });
});

// GET /api/v1/control/workflows/:id/versions — Get version history
app.get('/api/v1/control/workflows/:id/versions', authMiddleware, (req, res) => {
  const wf = mockWorkflows.get(req.params.id);
  if (!wf) {
    return res.status(404).json({ message: 'Workflow not found' });
  }

  const versions = mockVersions.get(req.params.id) || [];
  console.log(`📜 [Workflows] VERSIONS ${req.params.id} - ${versions.length} versions`);
  res.json({ data: versions });
});

// POST /api/v1/control/workflows/:id/rollback — Rollback to version
app.post('/api/v1/control/workflows/:id/rollback', authMiddleware, (req, res) => {
  const wf = mockWorkflows.get(req.params.id);
  if (!wf) {
    return res.status(404).json({ message: 'Workflow not found' });
  }

  const { target_version_id, reason } = req.body;
  const versions = mockVersions.get(req.params.id) || [];
  const targetVersion = versions.find((v) => v.id === target_version_id);

  if (!targetVersion) {
    return res.status(404).json({ message: 'Target version not found' });
  }

  const now = nowISO();
  wf.version = (wf.version || 1) + 1;
  wf.updated_at = now;

  // Record rollback as a new version
  versions.push({
    id: `ver-${req.params.id}-${wf.version}`,
    workflow_id: req.params.id,
    version: wf.version,
    changelog: `Rollback to v${targetVersion.version}: ${reason || ''}`,
    update_type: 'rollback',
    created_at: now,
  });
  mockVersions.set(req.params.id, versions);
  mockWorkflows.set(req.params.id, wf);

  console.log(`⏪ [Workflows] ROLLBACK ${req.params.id} to ${target_version_id} - "${wf.name}"`);
  res.json({
    data: {
      workflow: toWorkflowResponse(wf),
      rolled_back_to_version: targetVersion.version,
      new_version: wf.version,
    },
  });
});

// ── Folder CRUD Endpoints (/folders) ─────────────────────────
// Matches: src/utils/folderApi.js

app.get('/folders', authMiddleware, (req, res) => {
  const folders = Array.from(mockFolders.values());
  console.log(`📁 [Folders] LIST - ${folders.length} folders`);
  res.json(folders);
});

app.post('/folders', authMiddleware, (req, res) => {
  const data = req.body;
  const id = data.id || 'folder-' + uuidv4().substring(0, 8);
  const folder = { ...data, id };

  mockFolders.set(id, folder);
  console.log(`✅ [Folders] CREATE "${folder.name}" (${id})`);
  res.status(201).json(folder);
});

app.put('/folders/:id', authMiddleware, (req, res) => {
  const existing = mockFolders.get(req.params.id);
  if (!existing) {
    return res.status(404).json({ message: 'Folder not found' });
  }

  const updated = { ...existing, ...req.body, id: req.params.id };
  mockFolders.set(req.params.id, updated);
  console.log(`✏️  [Folders] UPDATE ${req.params.id} - "${updated.name}"`);
  res.json(updated);
});

app.delete('/folders/:id', authMiddleware, (req, res) => {
  const existing = mockFolders.get(req.params.id);
  if (!existing) {
    return res.status(404).json({ message: 'Folder not found' });
  }

  mockFolders.delete(req.params.id);
  console.log(`🗑️  [Folders] DELETE ${req.params.id} - "${existing.name}"`);
  res.json({ success: true });
});

// ── Package CRUD Endpoints (/packages) ───────────────────────
// Matches: src/utils/packageApi.js

app.get('/packages', authMiddleware, (req, res) => {
  const packages = Array.from(mockPackages.values());
  console.log(`📦 [Packages] LIST - ${packages.length} packages`);
  res.json(packages);
});

app.post('/packages', authMiddleware, (req, res) => {
  const data = req.body;
  const id = data.id || 'pkg-' + uuidv4().substring(0, 8);
  const pkg = { ...data, id, createdAt: data.createdAt || Date.now() };

  mockPackages.set(id, pkg);
  console.log(`✅ [Packages] CREATE "${pkg.name}" (${id})`);
  res.status(201).json(pkg);
});

app.put('/packages/:id', authMiddleware, (req, res) => {
  const existing = mockPackages.get(req.params.id);
  if (!existing) {
    return res.status(404).json({ message: 'Package not found' });
  }

  const updated = { ...existing, ...req.body, id: req.params.id };
  mockPackages.set(req.params.id, updated);
  console.log(`✏️  [Packages] UPDATE ${req.params.id} - "${updated.name}"`);
  res.json(updated);
});

app.delete('/packages/:id', authMiddleware, (req, res) => {
  const existing = mockPackages.get(req.params.id);
  if (!existing) {
    return res.status(404).json({ message: 'Package not found' });
  }

  mockPackages.delete(req.params.id);
  console.log(`🗑️  [Packages] DELETE ${req.params.id} - "${existing.name}"`);
  res.json({ success: true });
});

// ═══════════════════════════════════════════════════════════
// PERIODIC TASKS
// ═══════════════════════════════════════════════════════════

// Heartbeat - send ping to all connected extensions every 30 seconds
setInterval(() => {
  connectedExtensions.forEach((extension, extensionId) => {
    if (extension.ws.readyState === WebSocket.OPEN) {
      extension.ws.send(JSON.stringify({
        command: 'ping',
        requestId: uuidv4(),
      }));
    } else {
      connectedExtensions.delete(extensionId);
      console.log(`🗑️  Removed dead connection: ${extensionId}`);
    }
  });
}, 30000);

// Clean up old execution history (keep last 1000)
setInterval(() => {
  if (executionHistory.size > 1000) {
    const entries = Array.from(executionHistory.entries())
      .sort((a, b) => (b[1].requestedAt || 0) - (a[1].requestedAt || 0));

    const toKeep = entries.slice(0, 1000);
    executionHistory.clear();
    toKeep.forEach(([key, value]) => executionHistory.set(key, value));

    console.log('🧹 Cleaned up old execution history');
  }
}, 60000);

// ═══════════════════════════════════════════════════════════
// START SERVER
// ═══════════════════════════════════════════════════════════

server.listen(PORT, () => {
  console.log('╔════════════════════════════════════════════════════════════╗');
  console.log('║   Automa Backend Test Server                              ║');
  console.log('╚════════════════════════════════════════════════════════════╝');
  console.log('');
  console.log(`🚀 HTTP Server:     http://localhost:${PORT}`);
  console.log(`🔌 WebSocket:       ws://localhost:${PORT}`);
  console.log(`🔑 WS Auth:         JWT via identify message (accepts ?profile_id= param)`);
  console.log('');
  console.log('🔐 IAM Auth (/api/v1/iam):');
  console.log(`   POST /api/v1/iam/auth/login/password   - Login (test@automa.dev / 123456)`);
  console.log(`   POST /api/v1/iam/auth/rotate           - Rotate token (body: { refresh_token })`);
  console.log(`   POST /api/v1/iam/auth/logout           - Logout`);
  console.log('');
  console.log('📋 Workflows (/api/v1/control/workflows):');
  console.log(`   POST   .../workflows/list              - List (body: { skip, limit })`);
  console.log(`   GET    .../workflows/:id               - Get by ID`);
  console.log(`   POST   .../workflows                   - Create`);
  console.log(`   PATCH  .../workflows/:id               - Update config`);
  console.log(`   DELETE .../workflows/:id               - Delete`);
  console.log(`   POST   .../workflows/:id/approve       - Approve (draft -> approved)`);
  console.log(`   POST   .../workflows/:id/deprecate     - Deprecate`);
  console.log(`   GET    .../workflows/:id/versions      - Version history`);
  console.log(`   POST   .../workflows/:id/rollback      - Rollback to version`);
  console.log('');
  console.log('📁 Folders:');
  console.log(`   GET /folders  |  POST /folders  |  PUT /folders/:id  |  DELETE /folders/:id`);
  console.log('');
  console.log('📦 Packages:');
  console.log(`   GET /packages |  POST /packages |  PUT /packages/:id |  DELETE /packages/:id`);
  console.log('');
  console.log('📡 Worker Engine (backendApi via WS base URL):');
  console.log(`   GET  /health                           - Health / test connection`);
  console.log(`   POST /api/workflow-log                 - Workflow execution log`);
  console.log(`   POST /api/screenshot                   - Screenshot upload`);
  console.log(`   POST /api/screenshot-step              - Step screenshot upload`);
  console.log('');
  console.log('📡 WebSocket Control:');
  console.log(`   GET  /api/extensions                   - Connected extensions`);
  console.log(`   POST /api/execute                      - Execute workflow on extension`);
  console.log(`   POST /api/execute-all                  - Execute on all extensions`);
  console.log(`   POST /api/stop/:executionId            - Stop workflow execution`);
  console.log(`   GET  /api/executions                   - Execution history`);
  console.log(`   GET  /api/executions/:id               - Specific execution`);
  console.log('');
  console.log('📝 Waiting for connections...');
  console.log('════════════════════════════════════════════════════════════');
});

// Graceful shutdown
process.on('SIGTERM', () => {
  console.log('🛑 SIGTERM signal received: closing server');
  server.close(() => {
    console.log('✅ Server closed');
    process.exit(0);
  });
});

process.on('SIGINT', () => {
  console.log('\n🛑 SIGINT signal received: closing server');
  server.close(() => {
    console.log('✅ Server closed');
    process.exit(0);
  });
});

