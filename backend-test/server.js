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

wss.on('connection', (ws, req) => {
  const urlParams = new URL(req.url, `http://${req.headers.host}`);
  const token = urlParams.searchParams.get('token');
  
  // Validate authentication token
  if (token !== AUTH_TOKEN) {
    console.log('❌ Unauthorized connection attempt');
    ws.close(4001, 'Unauthorized');
    return;
  }

  let extensionId = null;
  let extensionInfo = null;

  console.log('✅ New WebSocket connection established');

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
    extensionId = message.data.extensionId;
    extensionInfo = {
      extensionId: message.data.extensionId,
      installationId: message.data.installationId,
      version: message.data.version,
      connectedAt: new Date().toISOString(),
      ws: ws,
    };
    
    connectedExtensions.set(extensionId, extensionInfo);
    console.log('🔗 Extension identified:', {
      extensionId: extensionInfo.extensionId,
      version: extensionInfo.version,
    });
    
    // Send welcome message
    ws.send(JSON.stringify({
      type: 'welcome',
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
  const message = {
    type: 'execute_workflow',
    data: {
      executionId,
      workflow,
      inputs: inputs || {},
      options: options || {},
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
        type: 'execute_workflow',
        data: {
          executionId,
          workflow,
          inputs: inputs || {},
          options: options || {},
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
    type: 'stop_workflow',
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
    type: 'get_status',
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
    type: 'ping',
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
// PERIODIC TASKS
// ═══════════════════════════════════════════════════════════

// Heartbeat - send ping to all connected extensions every 30 seconds
setInterval(() => {
  connectedExtensions.forEach((extension, extensionId) => {
    if (extension.ws.readyState === WebSocket.OPEN) {
      extension.ws.send(JSON.stringify({
        type: 'ping',
        requestId: uuidv4(),
      }));
    } else {
      // Remove dead connections
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
  console.log('╔════════════════════════════════════════════════╗');
  console.log('║   Automa WebSocket Server                     ║');
  console.log('╚════════════════════════════════════════════════╝');
  console.log('');
  console.log(`🚀 HTTP Server:     http://localhost:${PORT}`);
  console.log(`🔌 WebSocket:       ws://localhost:${PORT}`);
  console.log(`🔑 Auth Token:      ${AUTH_TOKEN}`);
  console.log('');
  console.log('📡 API Endpoints:');
  console.log(`   GET  /health                    - Health check`);
  console.log(`   GET  /api/extensions            - List connected extensions`);
  console.log(`   POST /api/execute               - Execute workflow on extension`);
  console.log(`   POST /api/execute-all           - Execute on all extensions`);
  console.log(`   POST /api/stop/:executionId     - Stop workflow execution`);
  console.log(`   GET  /api/executions            - Get execution history`);
  console.log(`   GET  /api/executions/:id        - Get specific execution`);
  console.log(`   POST /api/status/:extensionId   - Get extension status`);
  console.log(`   POST /api/ping/:extensionId     - Ping extension`);
  console.log(`   POST /api/workflow-log          - Receive workflow log data`);
  console.log(`   POST /api/screenshot            - Receive screenshot data`);
  console.log(`   POST /api/screenshot-step       - Receive step screenshot data`);
  console.log('');
  console.log('📝 Waiting for connections...');
  console.log('════════════════════════════════════════════════');
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

