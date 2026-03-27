const WebSocket = require('ws');
const express = require('express');
const http = require('http');
const cors = require('cors');
const fs = require('fs');
const path = require('path');
const os = require('os');
const net = require('net');
const { execFileSync, spawn } = require('child_process');
const { chromium } = require('playwright');
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
app.use(express.static(path.join(__dirname, 'public')));

// Configuration
const PORT = process.env.PORT || 8000;
const AUTH_TOKEN = process.env.AUTH_TOKEN || 'test-token-12345';
const INTERNAL_API_PORT = Number(process.env.INTERNAL_API_PORT || PORT);
const INTERNAL_API_SECRET = process.env.INTERNAL_API_SECRET || '';
const DEFAULT_PROFILE_ID =
  process.env.DEFAULT_PROFILE_ID || 'profile-backend-test';
const SERVER_HOST = process.env.SERVER_HOST || '127.0.0.1';
const HEADLESS_EXTENSION_BUILD_DIR = path.resolve(
  __dirname,
  '..',
  'build-headless'
);
const EXTENSION_BUILD_DIR = path.resolve(
  __dirname,
  process.env.EXTENSION_BUILD_DIR ||
    (fs.existsSync(HEADLESS_EXTENSION_BUILD_DIR)
      ? '../build-headless'
      : '../build')
);
const EXTENSION_IS_HEADLESS =
  path.basename(EXTENSION_BUILD_DIR) === 'build-headless';
const PLAYWRIGHT_HEADLESS =
  String(process.env.PLAYWRIGHT_HEADLESS || 'false').toLowerCase() === 'true';
const PLAYWRIGHT_TIMEOUT_MS = Number(
  process.env.PLAYWRIGHT_TIMEOUT_MS || 120000
);
const PLAYWRIGHT_CHANNEL = process.env.PLAYWRIGHT_CHANNEL || undefined;
const PLAYWRIGHT_EXECUTABLE_PATH =
  process.env.PLAYWRIGHT_EXECUTABLE_PATH ||
  'C:\\Users\\SPYSOCIA\\Desktop\\orbita-browser-140\\orbita-browser-140\\chrome.exe';
const PLAYWRIGHT_REMOTE_DEBUGGING_HOST =
  process.env.PLAYWRIGHT_REMOTE_DEBUGGING_HOST || '127.0.0.1';
const OPEN_EXTENSION_UI_ON_LAUNCH =
  String(process.env.OPEN_EXTENSION_UI_ON_LAUNCH || 'false').toLowerCase() ===
  'true';
const browserSessions = new Map();

function resolveBrowserExecutablePath() {
  const candidates = [
    PLAYWRIGHT_EXECUTABLE_PATH,
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
    'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
    'C:\\Users\\SPYSOCIA\\Desktop\\orbita-browser-140\\orbita-browser-140\\chrome.exe',
  ].filter(Boolean);

  return candidates.find((candidate) => fs.existsSync(candidate)) || null;
}

const RESOLVED_BROWSER_EXECUTABLE_PATH = resolveBrowserExecutablePath();

// Data store (in production, use a real database)
const connectedExtensions = new Map();
const executionHistory = new Map();
const workerArtifacts = new Map();
const workerLogs = new Map();

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

function getConnectionId(extensionInfo) {
  return (
    extensionInfo.profileId ||
    extensionInfo.installationId ||
    extensionInfo.extensionId
  );
}

function resolveExtension(identifier) {
  if (!identifier) return null;

  return (
    connectedExtensions.get(identifier) ||
    Array.from(connectedExtensions.values()).find(
      (extension) =>
        extension.extensionId === identifier ||
        extension.profileId === identifier ||
        extension.installationId === identifier
    ) ||
    null
  );
}

function listBrowserSessions() {
  return Array.from(browserSessions.values()).map((session) => ({
    profileId: session.profileId,
    connectionId: session.connectionId || session.profileId,
    extensionId: session.extensionId || null,
    installationId: session.installationId || null,
    createdAt: session.createdAt,
    connectedAt: session.connectedAt || null,
    initUrl: session.initUrl,
    serviceWorkerUrl: session.serviceWorkerUrl || null,
  }));
}

function upsertExecution(executionId, patch = {}) {
  const currentExecution = executionHistory.get(executionId) || {
    executionId,
    actionLogs: [],
    workflowLogs: [],
    artifacts: [],
  };
  const nextExecution = {
    ...currentExecution,
    ...patch,
    actionLogs: patch.actionLogs || currentExecution.actionLogs || [],
    workflowLogs: patch.workflowLogs || currentExecution.workflowLogs || [],
    artifacts: patch.artifacts || currentExecution.artifacts || [],
  };

  executionHistory.set(executionId, nextExecution);
  return nextExecution;
}

function appendExecutionItem(executionId, key, item) {
  const execution = executionHistory.get(executionId) || { executionId };
  const list = [...(execution[key] || []), item];
  executionHistory.set(executionId, { ...execution, [key]: list });
  return list;
}

function sanitizePathSegment(value, fallback = 'unknown') {
  return String(value || fallback)
    .replace(/[<>:"/\\|?*\x00-\x1F]/g, '_')
    .replace(/\s+/g, '_')
    .slice(0, 120);
}

function getExecutionRecord(executionId) {
  return executionHistory.get(executionId) || { executionId };
}

function getExecutionLogsDir(executionId, profileId) {
  const execution = getExecutionRecord(executionId);
  const safeProfileId = sanitizePathSegment(
    profileId ||
      execution.profileId ||
      execution.connectionId ||
      'unknown-profile'
  );
  const safeExecutionId = sanitizePathSegment(executionId, 'unknown-execution');
  const targetDir = path.join(logsDir, safeProfileId, safeExecutionId);

  if (!fs.existsSync(targetDir)) {
    fs.mkdirSync(targetDir, { recursive: true });
  }

  return targetDir;
}

function writeJsonFile(targetDir, filename, data) {
  const filepath = path.join(targetDir, filename);
  fs.writeFileSync(filepath, JSON.stringify(data, null, 2));
  return filepath;
}

function getDateParts(timestamp = Date.now()) {
  const date = new Date(timestamp);
  const safeDate = Number.isNaN(date.getTime()) ? new Date() : date;

  return {
    date: safeDate,
    dateStr: safeDate.toISOString().split('T')[0],
    timeStr: safeDate.toTimeString().split(' ')[0].replace(/:/g, '-'),
  };
}

function writeExecutionJsonFile({
  executionId,
  profileId,
  prefix,
  timestamp = Date.now(),
  data,
}) {
  const { dateStr, timeStr } = getDateParts(timestamp);
  const targetDir = getExecutionLogsDir(executionId, profileId);
  const filename = `${prefix}-${dateStr}-${timeStr}.json`;

  return writeJsonFile(targetDir, filename, data);
}

function persistWorkflowLogFile(
  executionId,
  workflowLog,
  profileId,
  timestamp
) {
  return writeExecutionJsonFile({
    executionId,
    profileId,
    prefix: 'workflow-log',
    timestamp,
    data: {
      executionId,
      workflowLog,
    },
  });
}

function persistFinishJobFile(executionId, profileId, timestamp = Date.now()) {
  return writeExecutionJsonFile({
    executionId,
    profileId,
    prefix: 'finish-job',
    timestamp,
    data: {
      executionId,
      finishJobCalledAt: new Date(timestamp).toISOString(),
    },
  });
}

function finalizeRunningExecutionsForConnection(connectionId, reason = '') {
  const executions = Array.from(executionHistory.values()).filter(
    (execution) =>
      execution.status === 'running' &&
      (execution.connectionId === connectionId ||
        execution.profileId === connectionId)
  );

  executions.forEach((execution) => {
    const finishedAt = Date.now();
    const workflowLog = {
      actionIndex: 0,
      logLevel: 'error',
      logType: 'workflow',
      message: reason || 'Workflow disconnected before final callback',
      logData: {
        workflowId: execution.workflowId || execution.workflow?.id || null,
        workflowName:
          execution.workflowName || execution.workflow?.name || null,
        status: 'disconnected',
        startedAt: execution.startedAtFormatted || null,
        endedAt: new Date(finishedAt).toISOString(),
      },
      receivedAt: new Date(finishedAt).toISOString(),
      synthetic: true,
    };

    appendExecutionItem(execution.executionId, 'workflowLogs', workflowLog);
    const workflowLogFile = persistWorkflowLogFile(
      execution.executionId,
      workflowLog,
      execution.profileId,
      finishedAt
    );
    const finishJobFile = persistFinishJobFile(
      execution.executionId,
      execution.profileId,
      finishedAt
    );

    upsertExecution(execution.executionId, {
      status: 'disconnected',
      message: workflowLog.message,
      completedAt: finishedAt,
      completedAtFormatted: new Date(finishedAt).toISOString(),
      workflowLogFile,
      finishJobCalledAt: finishedAt,
      finishJobCalledAtFormatted: new Date(finishedAt).toISOString(),
      finishJobFile,
    });
  });
}

function saveBase64Artifact({
  executionId,
  artifactType,
  artifactName,
  dataBase64,
  mimeType,
  capturedAt,
  metadata,
}) {
  const { dateStr, timeStr } = getDateParts(capturedAt);
  const safeArtifactName = (artifactName || `${artifactType || 'artifact'}`)
    .replace(/[<>:"/\\|?*\x00-\x1F]/g, '_')
    .slice(0, 120);
  const filename = `${executionId}-${dateStr}-${timeStr}-${safeArtifactName}`;
  const filepath = path.join(imagesDir, filename);

  fs.writeFileSync(filepath, dataBase64, 'base64');

  const artifactRecord = {
    executionId,
    artifactType,
    artifactName,
    mimeType,
    capturedAt: capturedAt || new Date().toISOString(),
    metadata: metadata || {},
    filename,
    filepath,
  };

  const metadataFilepath = writeJsonFile(
    imagesDir,
    `${filename}.json`,
    artifactRecord
  );

  return { ...artifactRecord, metadataFilepath };
}

function getServerAddresses(port) {
  const interfaces = os.networkInterfaces();
  const results = new Set([
    `http://localhost:${port}`,
    `http://127.0.0.1:${port}`,
  ]);

  Object.values(interfaces).forEach((entries) => {
    (entries || []).forEach((entry) => {
      if (entry.family === 'IPv4' && !entry.internal) {
        results.add(`http://${entry.address}:${port}`);
      }
    });
  });

  return Array.from(results);
}

function buildBootstrapConfig(overrides = {}) {
  const profileId =
    overrides.profile_id || overrides.profileId || DEFAULT_PROFILE_ID;
  const wsUrl =
    overrides.ws_url ||
    overrides.wsUrl ||
    `ws://${SERVER_HOST}:${PORT}/ws?token=${encodeURIComponent(AUTH_TOKEN)}`;
  const internalApiPort =
    overrides.internal_api_port ||
    overrides.internalApiPort ||
    INTERNAL_API_PORT;
  const internalApiSecret =
    overrides.internal_api_secret ||
    overrides.internalApiSecret ||
    INTERNAL_API_SECRET;

  return {
    profileId,
    wsUrl,
    internalApiPort,
    internalApiSecret,
  };
}

function internalApiAuthMiddleware(req, res, next) {
  if (!INTERNAL_API_SECRET) return next();

  const authHeader = req.headers.authorization || '';
  if (authHeader === `Bearer ${INTERNAL_API_SECRET}`) {
    next();
    return;
  }

  res.status(401).json({ error: 'Unauthorized - Invalid internal API secret' });
}

function getBrowserSessionDir(profileId) {
  const safeProfileId = (profileId || DEFAULT_PROFILE_ID).replace(
    /[^a-zA-Z0-9-_]/g,
    '_'
  );
  return path.join(__dirname, '.sessions', safeProfileId);
}

async function ensureDirectory(dirPath) {
  await fs.promises.mkdir(dirPath, { recursive: true });
}

function getFreePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
    srv.on('error', reject);
  });
}

async function waitForDebugEndpoint(port, timeoutMs = 30000) {
  const startedAt = Date.now();

  while (Date.now() - startedAt < timeoutMs) {
    try {
      const response = await fetch(
        `http://${PLAYWRIGHT_REMOTE_DEBUGGING_HOST}:${port}/json/version`
      );
      if (response.ok) {
        const json = await response.json();
        if (json.webSocketDebuggerUrl) {
          return json;
        }
      }
    } catch (error) {
      // keep polling
    }

    await new Promise((resolve) => setTimeout(resolve, 500));
  }

  throw new Error(`Timed out waiting for remote debugging endpoint on ${port}`);
}

function escapePowerShellString(value) {
  return String(value).replace(/'/g, "''");
}

function getOrphanBrowserPids(userDataDir) {
  if (process.platform !== 'win32') return [];

  const escapedDir = escapePowerShellString(userDataDir);
  const script = `
    $dir = '${escapedDir}'
    Get-CimInstance Win32_Process |
      Where-Object {
        $_.Name -in @('chrome.exe', 'msedge.exe', 'orbita.exe') -and
        $_.CommandLine -and
        $_.CommandLine -match [regex]::Escape($dir)
      } |
      Select-Object -ExpandProperty ProcessId
  `;

  try {
    const output = execFileSync(
      'powershell',
      ['-NoProfile', '-Command', script],
      {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
      }
    );

    return output
      .split(/\r?\n/)
      .map((line) => Number(line.trim()))
      .filter((pid) => Number.isInteger(pid) && pid > 0);
  } catch (error) {
    return [];
  }
}

async function killBrowserProcessesForUserDataDir(userDataDir) {
  const pids = getOrphanBrowserPids(userDataDir);

  for (const pid of pids) {
    try {
      process.kill(pid, 'SIGKILL');
    } catch (error) {
      // ignore kill errors
    }
  }

  if (pids.length > 0) {
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
}

async function closeBrowserSession(profileId, { clearDataDir = false } = {}) {
  const session = browserSessions.get(profileId);
  const userDataDir = session?.userDataDir || getBrowserSessionDir(profileId);

  if (session) {
    browserSessions.delete(profileId);

    try {
      await session.context?.close();
    } catch (error) {
      console.warn(`⚠️ Failed to close browser session ${profileId}:`, error);
    }

    try {
      session.browserProcess?.kill();
    } catch (error) {
      // ignore kill errors
    }
  }

  await killBrowserProcessesForUserDataDir(userDataDir);

  if (clearDataDir) {
    let lastError = null;

    for (let attempt = 0; attempt < 5; attempt += 1) {
      try {
        await fs.promises.rm(userDataDir, { recursive: true, force: true });
        lastError = null;
        break;
      } catch (error) {
        lastError = error;

        if (error.code !== 'EBUSY' && error.code !== 'EPERM') {
          throw error;
        }

        await new Promise((resolve) => setTimeout(resolve, 500 * (attempt + 1)));
      }
    }

    if (lastError) throw lastError;
  }
}

function waitForExtensionConnection(
  profileId,
  timeoutMs = PLAYWRIGHT_TIMEOUT_MS
) {
  const existing = resolveExtension(profileId);
  if (existing?.ws?.readyState === WebSocket.OPEN) {
    return Promise.resolve(existing);
  }

  return new Promise((resolve, reject) => {
    const startedAt = Date.now();

    const timer = setInterval(() => {
      const extension = resolveExtension(profileId);
      if (extension?.ws?.readyState === WebSocket.OPEN) {
        clearInterval(timer);
        resolve(extension);
        return;
      }

      if (Date.now() - startedAt >= timeoutMs) {
        clearInterval(timer);
        reject(
          new Error(`Timed out waiting for extension connection (${profileId})`)
        );
      }
    }, 1000);
  });
}

async function launchBrowserSession({
  profileId,
  wsUrl,
  internalApiPort,
  internalApiSecret,
}) {
  if (!fs.existsSync(EXTENSION_BUILD_DIR)) {
    throw new Error(
      `Extension build directory not found: ${EXTENSION_BUILD_DIR}. Build the extension first.`
    );
  }

  if (!RESOLVED_BROWSER_EXECUTABLE_PATH) {
    throw new Error(
      'No supported Chromium-based browser executable found. Set PLAYWRIGHT_EXECUTABLE_PATH in backend-test/.env.'
    );
  }

  await closeBrowserSession(profileId);

  const userDataDir = getBrowserSessionDir(profileId);
  await ensureDirectory(userDataDir);
  const remoteDebuggingPort = await getFreePort();
  let browserProcess = null;
  let browser = null;
  let context = null;
  const browserArgs = [
    `--remote-debugging-port=${remoteDebuggingPort}`,
    `--user-data-dir=${userDataDir}`,
    `--disable-extensions-except=${EXTENSION_BUILD_DIR}`,
    `--load-extension=${EXTENSION_BUILD_DIR}`,
    '--no-default-browser-check',
    '--disable-dev-shm-usage',
    '--disable-features=DialMediaRouteProvider',
    '--no-first-run',
    '--no-default-browser-check',
    '--new-window',
    'about:blank',
  ];
  try {
    browserProcess = spawn(RESOLVED_BROWSER_EXECUTABLE_PATH, browserArgs, {
      detached: false,
      stdio: 'ignore',
    });

    const debugInfo = await waitForDebugEndpoint(
      remoteDebuggingPort,
      Math.min(PLAYWRIGHT_TIMEOUT_MS, 30000)
    );
    browser = await chromium.connectOverCDP(debugInfo.webSocketDebuggerUrl);
    context = browser.contexts()[0];
    if (!context) {
      throw new Error('Connected browser has no default context');
    }

    const serviceWorker =
      context.serviceWorkers()[0] ||
      (await context
        .waitForEvent('serviceworker', {
          timeout: Math.min(PLAYWRIGHT_TIMEOUT_MS, 30000),
        })
        .catch(() => null));
    const detectedExtensionId = serviceWorker?.url()?.split('/')[2] || null;

    if (serviceWorker) {
      await serviceWorker.evaluate(
        async ({
          profileIdValue,
          wsUrlValue,
          internalApiPortValue,
          internalApiSecretValue,
        }) => {
          await chrome.storage.local.set({
            profileId: profileIdValue,
            workerMode: true,
            wsConfig: {
              enabled: true,
              url: wsUrlValue,
            },
            internalApiPort: internalApiPortValue,
            internalApiSecret: internalApiSecretValue || null,
          });
        },
        {
          profileIdValue: profileId,
          wsUrlValue: wsUrl,
          internalApiPortValue: internalApiPort,
          internalApiSecretValue: internalApiSecret || '',
        }
      );
    }

    const initUrl = `http://localhost:${PORT}/automa-init?profile_id=${encodeURIComponent(
      profileId
    )}&ws_url=${encodeURIComponent(
      wsUrl
    )}&internal_api_port=${encodeURIComponent(internalApiPort)}${
      internalApiSecret
        ? `&internal_api_secret=${encodeURIComponent(internalApiSecret)}`
        : ''
    }`;

    if (
      detectedExtensionId &&
      !EXTENSION_IS_HEADLESS &&
      OPEN_EXTENSION_UI_ON_LAUNCH
    ) {
      const extensionPage = await context.newPage();
      await extensionPage.goto(
        `chrome-extension://${detectedExtensionId}/newtab.html#/workflows`,
        {
          waitUntil: 'load',
          timeout: PLAYWRIGHT_TIMEOUT_MS,
        }
      );
    }

    browserSessions.set(profileId, {
      profileId,
      browser,
      browserProcess,
      context,
      remoteDebuggingPort,
      serviceWorkerUrl: serviceWorker?.url() || null,
      extensionId: detectedExtensionId,
      userDataDir,
      initUrl,
      createdAt: new Date().toISOString(),
    });

    context.on('close', () => {
      browserSessions.delete(profileId);
    });

    return browserSessions.get(profileId);
  } catch (error) {
    try {
      await context?.close();
    } catch (_) {
      // ignore cleanup errors
    }

    try {
      browserProcess?.kill();
    } catch (_) {
      // ignore cleanup errors
    }

    browserSessions.delete(profileId);

    throw new Error(
      `Failed to launch browser session using ${RESOLVED_BROWSER_EXECUTABLE_PATH}: ${error.message}`
    );
  }
}

async function ensureExtensionConnection({
  profileId,
  wsUrl,
  internalApiPort,
  internalApiSecret,
  relaunch = false,
}) {
  const extension = resolveExtension(profileId);
  if (!relaunch && extension?.ws?.readyState === WebSocket.OPEN) {
    return extension;
  }

  await launchBrowserSession({
    profileId,
    wsUrl,
    internalApiPort,
    internalApiSecret,
  });

  return waitForExtensionConnection(profileId);
}

function buildSmokeWorkflow() {
  return {
    id: 'wf-smoke-delay',
    name: 'Worker Smoke Delay',
    version: '1.0.0',
    extVersion: '1.29.12',
    drawflow: {
      nodes: [
        {
          id: 'trigger-smoke-1',
          label: 'trigger',
          data: {
            disableBlock: false,
            type: 'manual',
            parameters: [],
          },
          position: { x: 80, y: 120 },
          type: 'BlockBasic',
        },
        {
          id: 'new-tab-smoke-1',
          label: 'new-tab',
          data: {
            active: true,
            customUserAgent: false,
            disableBlock: false,
            inGroup: false,
            onError: {
              dataToInsert: [],
              enable: false,
              errorMessage: '',
              insertData: false,
              retry: false,
              retryInterval: 2,
              retryTimes: 1,
              toDo: 'error',
            },
            settings: {
              blockTimeout: 0,
              debugMode: false,
            },
            updatePrevTab: false,
            url: 'about:blank',
            userAgent: '',
            waitTabLoaded: true,
          },
          position: { x: 360, y: 120 },
          type: 'BlockBasic',
        },
        {
          id: 'delay-smoke-1',
          label: 'delay',
          data: {
            disableBlock: false,
            time: 800,
          },
          position: { x: 660, y: 120 },
          type: 'BlockDelay',
        },
      ],
      edges: [
        {
          id: 'smoke-edge-trigger-new-tab',
          source: 'trigger-smoke-1',
          target: 'new-tab-smoke-1',
          sourceHandle: 'trigger-smoke-1-output-1',
          targetHandle: 'new-tab-smoke-1-input-1',
        },
        {
          id: 'smoke-edge-new-tab-delay',
          source: 'new-tab-smoke-1',
          target: 'delay-smoke-1',
          sourceHandle: 'new-tab-smoke-1-output-1',
          targetHandle: 'delay-smoke-1-input-1',
        },
      ],
    },
    settings: {
      saveLog: true,
      notification: false,
      debugMode: false,
      blockDelay: 0,
      onError: 'stop-workflow',
    },
    globalData: '{\n  "key": "value"\n}',
  };
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
  const wsToken = urlParams.searchParams.get('token');

  // Accept all connections — auth is validated via JWT in identify message
  console.log(
    '✅ New WebSocket connection established',
    profileId ? `(profile: ${profileId})` : ''
  );

  let extensionId = null;
  let connectionId = null;
  let extensionInfo = null;
  let isAuthenticated = false;

  // ─────────────────────────────────────────────────────────
  // Handle incoming messages from extension
  // ─────────────────────────────────────────────────────────
  ws.on('message', (data) => {
    try {
      const message = JSON.parse(data.toString());
      const messageKind = message.command || message.type;
      console.log('📨 Received from extension:', messageKind);

      switch (messageKind) {
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

        case 'error':
          console.error('❌ [Extension Error]', message.error || message);
          break;

        default:
          console.warn('⚠️  Unknown message kind:', messageKind);
      }
    } catch (error) {
      console.error('❌ Error handling message:', error);
      ws.send(
        JSON.stringify({
          type: 'error',
          error: {
            message: error.message,
            stack: error.stack,
          },
        })
      );
    }
  });

  // ─────────────────────────────────────────────────────────
  // Handle connection close
  // ─────────────────────────────────────────────────────────
  ws.on('close', (code, reason) => {
    console.log(`🔌 Connection closed: ${code} - ${reason}`);
    if (connectionId) {
      finalizeRunningExecutionsForConnection(
        connectionId,
        `Connection closed: ${code} ${reason || ''}`.trim()
      );
    }
    if (connectionId) {
      connectedExtensions.delete(connectionId);
      console.log(`📤 Extension ${connectionId} removed from connected list`);
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
    const jwtToken = message.data.token || wsToken;
    if (jwtToken) {
      // In mock server: validate against mockSessions
      const session = mockSessions.get(jwtToken);
      if (session) {
        isAuthenticated = true;
        console.log(
          `🔐 Extension authenticated via JWT (user: ${session.user.email})`
        );
      } else {
        // Accept anyway in dev mode, just log warning
        isAuthenticated = true;
        console.warn(
          `⚠️  Extension JWT not in mockSessions, accepting in dev mode`
        );
      }
    } else {
      isAuthenticated = true;
      console.warn(
        '⚠️  Extension connected without JWT token, accepting in dev mode'
      );
    }

    extensionId = message.data.extensionId;
    extensionInfo = {
      extensionId: message.data.extensionId,
      installationId: message.data.installationId,
      profileId: message.data.profileId || profileId,
      version: message.data.version,
      connectedAt: new Date().toISOString(),
      ws: ws,
      authToken: jwtToken || null,
      isAuthenticated,
    };

    connectionId = getConnectionId(extensionInfo);

    const previousConnection = connectedExtensions.get(connectionId);
    if (
      previousConnection &&
      previousConnection.ws &&
      previousConnection.ws !== ws &&
      previousConnection.ws.readyState === WebSocket.OPEN
    ) {
      previousConnection.ws.close(4001, 'Superseded by newer connection');
    }

    connectedExtensions.set(connectionId, {
      ...extensionInfo,
      connectionId,
    });
    if (browserSessions.has(connectionId)) {
      const session = browserSessions.get(connectionId);
      browserSessions.set(connectionId, {
        ...session,
        connectionId,
        extensionId: extensionInfo.extensionId,
        installationId: extensionInfo.installationId,
        connectedAt: extensionInfo.connectedAt,
      });
    }
    console.log('🔗 Extension identified:', {
      connectionId,
      extensionId: extensionInfo.extensionId,
      profileId: extensionInfo.profileId,
      version: extensionInfo.version,
    });

    // Send welcome message — extension reads message.command
    ws.send(
      JSON.stringify({
        command: 'welcome',
        message: 'Successfully connected to Automa WebSocket Server',
        serverVersion: '1.0.0',
        timestamp: Date.now(),
      })
    );
  }

  function handleWorkflowStarted(message) {
    console.log('🚀 Workflow started:', {
      executionId: message.executionId,
      workflowId: message.workflowId,
    });

    const execution = upsertExecution(message.executionId, {
      executionId: message.executionId,
      workflowId: message.workflowId,
      status: 'running',
      startedAt: message.timestamp,
      startedAtFormatted: new Date(message.timestamp).toISOString(),
      profileId: extensionInfo?.profileId || null,
      extensionId,
    });

    const filepath = writeExecutionJsonFile({
      executionId: message.executionId,
      profileId: execution.profileId,
      prefix: 'workflow-started',
      timestamp: message.timestamp,
      data: {
        executionId: message.executionId,
        workflowId: message.workflowId,
        status: 'running',
        timestamp: message.timestamp,
        profileId: execution.profileId,
        extensionId,
      },
    });

    upsertExecution(message.executionId, { workflowStartedFile: filepath });
  }

  function handleWorkflowCompleted(message) {
    console.log('✅ Workflow completed:', {
      executionId: message.executionId,
      status: message.status,
      duration: message.duration ? `${message.duration}ms` : 'N/A',
    });

    const execution = upsertExecution(message.executionId, {
      status: 'completed',
      completedAt: message.timestamp,
      completedAtFormatted: new Date(message.timestamp).toISOString(),
      duration: message.duration,
      result: message.data,
    });

    const filepath = writeExecutionJsonFile({
      executionId: message.executionId,
      profileId: execution.profileId,
      prefix: 'workflow-completed',
      timestamp: message.timestamp,
      data: message,
    });

    upsertExecution(message.executionId, { workflowCompletedFile: filepath });

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
      hasVariables: message.data?.variables
        ? Object.keys(message.data.variables).length
        : 0,
      hasExtractedData: !!message.data?.extractedData,
      sampleData: {
        table: message.data?.table?.slice(0, 2) || [],
        variables: message.data?.variables
          ? Object.keys(message.data.variables).slice(0, 5)
          : [],
        logs: message.logs?.slice(0, 3) || [],
      },
    });

    const execution = upsertExecution(message.executionId, {
      status: message.status,
      message: message.message,
      completedAt: message.timestamp,
      completedAtFormatted: new Date(message.timestamp).toISOString(),
      duration: message.duration,
      data: message.data,
      logs: message.logs,
    });

    const filepath = writeExecutionJsonFile({
      executionId: message.executionId,
      profileId: execution.profileId,
      prefix: 'workflow-result',
      timestamp: message.timestamp,
      data: message,
    });

    upsertExecution(message.executionId, { workflowResultFile: filepath });

    // Log detailed results
    logExecutionResults(message.executionId, message);
  }

  function handleWorkflowFailed(message) {
    console.log('❌ Workflow failed:', {
      executionId: message.executionId,
      error: message.error?.message,
    });

    const execution = upsertExecution(message.executionId, {
      status: 'failed',
      completedAt: message.timestamp,
      completedAtFormatted: new Date(message.timestamp).toISOString(),
      error: message.error,
    });

    const filepath = writeExecutionJsonFile({
      executionId: message.executionId,
      profileId: execution.profileId,
      prefix: 'workflow-failed',
      timestamp: message.timestamp,
      data: message,
    });

    upsertExecution(message.executionId, { workflowFailedFile: filepath });

    // Log failure
    logExecution(message.executionId);
  }

  function handleWorkflowStopped(message) {
    console.log('⏸️  Workflow stopped:', {
      executionId: message.executionId,
      workflowId: message.workflowId,
    });

    const execution = upsertExecution(message.executionId, {
      status: 'stopped',
      stoppedAt: message.timestamp,
      stoppedAtFormatted: new Date(message.timestamp).toISOString(),
    });

    const filepath = writeExecutionJsonFile({
      executionId: message.executionId,
      profileId: execution.profileId,
      prefix: 'workflow-stopped',
      timestamp: message.timestamp,
      data: message,
    });

    upsertExecution(message.executionId, { workflowStoppedFile: filepath });
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
    console.log(
      `║ 📦 WORKFLOW RESULT: ${executionId.substring(0, 20).padEnd(27)} ║`
    );
    console.log('╠═══════════════════════════════════════════════════╣');
    console.log(`║ Status:   ${message.status.toUpperCase().padEnd(40)} ║`);
    console.log(
      `║ Message:  ${(message.message || '').substring(0, 40).padEnd(40)} ║`
    );
    console.log(`║ Duration: ${(message.duration + 'ms').padEnd(40)} ║`);
    console.log('╠═══════════════════════════════════════════════════╣');

    if (message.data) {
      console.log('║ 📊 DATA:                                          ║');

      if (message.data.table && message.data.table.length > 0) {
        console.log(
          `║   - Table rows: ${String(message.data.table.length).padEnd(33)} ║`
        );
        console.log(
          `║   - Sample: ${JSON.stringify(message.data.table[0])
            .substring(0, 35)
            .padEnd(37)} ║`
        );
      }

      if (
        message.data.variables &&
        Object.keys(message.data.variables).length > 0
      ) {
        const varCount = Object.keys(message.data.variables).length;
        console.log(`║   - Variables: ${String(varCount).padEnd(32)} ║`);
        Object.entries(message.data.variables)
          .slice(0, 3)
          .forEach(([key, value]) => {
            const varLine = `${key}: ${JSON.stringify(value)}`.substring(0, 37);
            console.log(`║     • ${varLine.padEnd(41)} ║`);
          });
      }

      if (message.data.extractedData) {
        console.log('║   - Extracted Data:                               ║');
        console.log(
          `║     • Blocks: ${String(
            message.data.extractedData.blocksExecuted
          ).padEnd(33)} ║`
        );
        console.log(
          `║     • Time: ${String(
            message.data.extractedData.executionTime + 'ms'
          ).padEnd(35)} ║`
        );
        if (
          message.data.extractedData.errors &&
          message.data.extractedData.errors.length > 0
        ) {
          console.log(
            `║     • Errors: ${String(
              message.data.extractedData.errors.length
            ).padEnd(33)} ║`
          );
        }
      }
    }

    if (message.logs && message.logs.length > 0) {
      console.log('╠═══════════════════════════════════════════════════╣');
      console.log(`║ 📝 LOGS: ${String(message.logs.length).padEnd(40)} ║`);
      message.logs.slice(0, 5).forEach((log, i) => {
        const logLine = `${log.name || 'Block'}: ${
          log.type || 'info'
        }`.substring(0, 40);
        console.log(`║   ${String(i + 1)}. ${logLine.padEnd(44)} ║`);
      });
      if (message.logs.length > 5) {
        console.log(
          `║   ... and ${String(message.logs.length - 5)} more logs${' '.repeat(
            28
          )} ║`
        );
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
  const bootstrapConfig = buildBootstrapConfig();

  res.json({
    status: 'ok',
    timestamp: new Date().toISOString(),
    connectedExtensions: connectedExtensions.size,
    uptime: process.uptime(),
    extensionBuildDir: EXTENSION_BUILD_DIR,
    extensionBuildMode: EXTENSION_IS_HEADLESS ? 'headless' : 'full',
    wsUrl: bootstrapConfig.wsUrl,
    internalApiPort: bootstrapConfig.internalApiPort,
    bootstrapUrl: `http://localhost:${PORT}/automa-init?profile_id=${encodeURIComponent(
      bootstrapConfig.profileId
    )}&ws_url=${encodeURIComponent(
      bootstrapConfig.wsUrl
    )}&internal_api_port=${encodeURIComponent(
      bootstrapConfig.internalApiPort
    )}`,
  });
});

app.get('/healthz', (req, res) => {
  res.json({
    status: 'ok',
    timestamp: new Date().toISOString(),
  });
});

app.get('/automa-init', (req, res) => {
  const bootstrapConfig = buildBootstrapConfig(req.query);
  const initUrl = new URL(`http://localhost:${PORT}/automa-init`);
  initUrl.searchParams.set('profile_id', bootstrapConfig.profileId);
  initUrl.searchParams.set('ws_url', bootstrapConfig.wsUrl);
  initUrl.searchParams.set(
    'internal_api_port',
    bootstrapConfig.internalApiPort
  );

  if (bootstrapConfig.internalApiSecret) {
    initUrl.searchParams.set(
      'internal_api_secret',
      bootstrapConfig.internalApiSecret
    );
  }

  res.type('html').send(`<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>Automa Init</title>
  <style>
    body { font-family: system-ui, sans-serif; padding: 32px; line-height: 1.5; background: #111827; color: #F9FAFB; }
    code { background: rgba(255,255,255,.08); padding: 2px 6px; border-radius: 4px; }
    .card { max-width: 860px; margin: 0 auto; padding: 24px; background: #1F2937; border-radius: 12px; }
    a { color: #93C5FD; }
  </style>
</head>
<body>
  <div class="card">
    <h1>Automa Worker Bootstrap</h1>
    <p>Keep this tab open in the same browser profile as the extension. The extension background will read this URL and bootstrap worker-mode WebSocket settings without login.</p>
    <p><strong>profile_id:</strong> <code>${
      bootstrapConfig.profileId
    }</code></p>
    <p><strong>ws_url:</strong> <code>${bootstrapConfig.wsUrl}</code></p>
    <p><strong>internal_api_port:</strong> <code>${
      bootstrapConfig.internalApiPort
    }</code></p>
    <p><strong>internal_api_secret:</strong> <code>${
      bootstrapConfig.internalApiSecret || '(empty)'
    }</code></p>
    <p><strong>Canonical URL:</strong> <a href="${initUrl.toString()}">${initUrl.toString()}</a></p>
    <p><a href="/">Open backend dashboard</a></p>
  </div>
</body>
</html>`);
});

app.get('/api/bootstrap', (req, res) => {
  const bootstrapConfig = buildBootstrapConfig(req.query);
  res.json({
    extensionBuildDir: EXTENSION_BUILD_DIR,
    extensionBuildMode: EXTENSION_IS_HEADLESS ? 'headless' : 'full',
    profileId: bootstrapConfig.profileId,
    wsUrl: bootstrapConfig.wsUrl,
    internalApiPort: bootstrapConfig.internalApiPort,
    internalApiSecret: bootstrapConfig.internalApiSecret,
    initUrl: `http://localhost:${PORT}/automa-init?profile_id=${encodeURIComponent(
      bootstrapConfig.profileId
    )}&ws_url=${encodeURIComponent(
      bootstrapConfig.wsUrl
    )}&internal_api_port=${encodeURIComponent(
      bootstrapConfig.internalApiPort
    )}${
      bootstrapConfig.internalApiSecret
        ? `&internal_api_secret=${encodeURIComponent(
            bootstrapConfig.internalApiSecret
          )}`
        : ''
    }`,
  });
});

// Get connected extensions
app.get('/api/extensions', (req, res) => {
  const extensions = Array.from(connectedExtensions.values()).map((ext) => ({
    connectionId: ext.connectionId,
    extensionId: ext.extensionId,
    profileId: ext.profileId,
    installationId: ext.installationId,
    version: ext.version,
    connectedAt: ext.connectedAt,
    isAuthenticated: ext.isAuthenticated,
  }));

  res.json({
    count: extensions.length,
    extensions,
    browserSessions: listBrowserSessions(),
  });
});

app.get('/api/browser-sessions', (req, res) => {
  res.json({
    count: browserSessions.size,
    sessions: listBrowserSessions(),
  });
});

app.post('/api/browser-sessions/launch', async (req, res) => {
  const {
    profileId = `pw-${uuidv4()}`,
    relaunch = false,
    waitForConnection = true,
  } = req.body || {};
  const bootstrapConfig = buildBootstrapConfig({ profile_id: profileId });

  try {
    if (relaunch) {
      await closeBrowserSession(profileId, { clearDataDir: true });
    }

    let extension = null;
    if (waitForConnection) {
      try {
        extension = await ensureExtensionConnection({
          profileId,
          wsUrl: bootstrapConfig.wsUrl,
          internalApiPort: bootstrapConfig.internalApiPort,
          internalApiSecret: bootstrapConfig.internalApiSecret,
          relaunch,
        });
      } catch (error) {
        const session =
          listBrowserSessions().find((item) => item.profileId === profileId) ||
          null;

        if (session) {
          return res.json({
            success: true,
            profileId,
            session,
            extension: null,
            connected: false,
            warning: error.message,
          });
        }

        throw error;
      }
    } else {
      await launchBrowserSession({
        profileId,
        wsUrl: bootstrapConfig.wsUrl,
        internalApiPort: bootstrapConfig.internalApiPort,
        internalApiSecret: bootstrapConfig.internalApiSecret,
      });
    }

    res.json({
      success: true,
      profileId,
      session:
        listBrowserSessions().find(
          (session) => session.profileId === profileId
        ) || null,
      extension: extension
        ? {
            connectionId: extension.connectionId,
            extensionId: extension.extensionId,
            profileId: extension.profileId,
          }
        : null,
      connected: Boolean(extension),
    });
  } catch (error) {
    res.status(500).json({
      error: 'Failed to launch browser session',
      message: error.message,
    });
  }
});

app.post('/api/browser-sessions/:profileId/close', async (req, res) => {
  const { profileId } = req.params;

  try {
    await closeBrowserSession(profileId);
    res.json({
      success: true,
      profileId,
      message: 'Browser session closed',
    });
  } catch (error) {
    res.status(500).json({
      error: 'Failed to close browser session',
      message: error.message,
    });
  }
});

app.get('/api/browser-sessions/:profileId/debug', async (req, res) => {
  const { profileId } = req.params;
  const session = browserSessions.get(profileId);

  if (!session) {
    return res.status(404).json({ error: 'Browser session not found' });
  }

  try {
    const serviceWorker = session.context.serviceWorkers()[0] || null;
    if (!serviceWorker) {
      return res.status(404).json({ error: 'Service worker not available' });
    }

    const snapshot = await serviceWorker.evaluate(async () => {
      const storage = await chrome.storage.local.get(null);
      return {
        runtimeId: chrome.runtime.id,
        serviceWorkerUrl: self.location.href,
        storage,
      };
    });

    res.json({
      success: true,
      profileId,
      snapshot,
    });
  } catch (error) {
    res.status(500).json({
      error: 'Failed to inspect browser session',
      message: error.message,
    });
  }
});

// Execute workflow on specific extension
app.post('/api/execute', async (req, res) => {
  const {
    connectionId,
    extensionId,
    profileId,
    workflow,
    inputs,
    options,
    autoLaunchBrowser = true,
    relaunchBrowser = false,
  } = req.body;
  let targetExtensionId = connectionId || profileId || extensionId;

  if (!workflow) {
    return res.status(400).json({ error: 'workflow is required' });
  }

  if (!targetExtensionId && !autoLaunchBrowser) {
    return res.status(400).json({
      error:
        'connectionId, profileId, or extensionId is required when autoLaunchBrowser is false',
    });
  }

  const wsUrl = buildBootstrapConfig().wsUrl;
  const workerProfileId = targetExtensionId || `pw-${uuidv4()}`;

  try {
    let extension = resolveExtension(targetExtensionId);

    if (
      (!extension || extension.ws.readyState !== WebSocket.OPEN) &&
      autoLaunchBrowser
    ) {
      extension = await ensureExtensionConnection({
        profileId: workerProfileId,
        wsUrl,
        internalApiPort: INTERNAL_API_PORT,
        internalApiSecret: INTERNAL_API_SECRET || null,
        relaunch: relaunchBrowser,
      });
      targetExtensionId = extension.connectionId;
    }

    if (!extension || extension.ws.readyState !== WebSocket.OPEN) {
      return res.status(400).json({
        error: 'Extension not connected',
        targetExtensionId,
      });
    }

    const executionId = uuidv4();

    upsertExecution(executionId, {
      executionId,
      connectionId: extension.connectionId,
      extensionId: extension.extensionId,
      profileId: extension.profileId,
      status: 'pending',
      requestedAt: Date.now(),
      requestedAtFormatted: new Date().toISOString(),
      workflow: {
        name: workflow.name,
        id: workflow.id,
      },
    });

    const message = {
      command: 'executeAction',
      request_id: executionId,
      params: {
        action_id: `action-${executionId}`,
        action_index: 0,
        action_type: 'workflow.execute',
        workflow_id: workflow.id,
        workflow_name: workflow.name,
        workflow_version: workflow.version || workflow.extVersion || '1.0.0',
        workflow_config: workflow,
        options: options || {},
        params: inputs || {},
        internal_api_port: INTERNAL_API_PORT,
        internal_api_secret: INTERNAL_API_SECRET || null,
      },
    };

    extension.ws.send(JSON.stringify(message));
    console.log('📤 Workflow execution request sent:', {
      executionId,
      connectionId: extension.connectionId,
      extensionId: extension.extensionId,
      workflowName: workflow.name,
      autoLaunchBrowser,
    });

    res.json({
      success: true,
      executionId,
      status: 'pending',
      connectionId: extension.connectionId,
      profileId: extension.profileId,
      launchedBrowser: autoLaunchBrowser,
      message: 'Workflow execution request sent to extension',
    });
  } catch (error) {
    console.error('❌ Error executing workflow:', error);
    res.status(500).json({
      error: 'Failed to execute workflow',
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
      upsertExecution(executionId, {
        executionId,
        connectionId: extension.connectionId,
        extensionId: extension.extensionId,
        profileId: extension.profileId,
        status: 'pending',
        requestedAt: Date.now(),
        requestedAtFormatted: new Date().toISOString(),
        workflow: {
          name: workflow.name,
          id: workflow.id,
        },
      });

      const message = {
        command: 'executeAction',
        request_id: executionId,
        params: {
          action_id: `action-${executionId}`,
          action_index: 0,
          action_type: 'workflow.execute',
          workflow_id: workflow.id,
          workflow_name: workflow.name,
          workflow_version: workflow.version || workflow.extVersion || '1.0.0',
          workflow_config: workflow,
          options: options || {},
          params: inputs || {},
          internal_api_port: INTERNAL_API_PORT,
          internal_api_secret: INTERNAL_API_SECRET || null,
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

app.post('/api/execute-smoke', async (req, res) => {
  const {
    profileId = `pw-smoke-${uuidv4()}`,
    autoLaunchBrowser = true,
    relaunchBrowser = false,
  } = req.body || {};

  try {
    const response = await fetch(`http://127.0.0.1:${PORT}/api/execute`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        profileId,
        autoLaunchBrowser,
        relaunchBrowser,
        workflow: buildSmokeWorkflow(),
        inputs: {},
        options: { checkParams: false },
      }),
    });

    const result = await response.json();
    if (!response.ok) {
      return res.status(response.status).json(result);
    }

    res.json({
      ...result,
      workflow: {
        id: 'wf-smoke-delay',
        name: 'Worker Smoke Delay',
      },
    });
  } catch (error) {
    res.status(500).json({
      error: 'Failed to execute smoke workflow',
      message: error.message,
    });
  }
});

// Stop workflow execution
app.post('/api/stop/:executionId', (req, res) => {
  const { executionId } = req.params;

  const execution = executionHistory.get(executionId);
  if (!execution) {
    return res.status(404).json({ error: 'Execution not found' });
  }

  const extension = resolveExtension(
    execution.connectionId || execution.profileId || execution.extensionId
  );
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

  const extension = resolveExtension(extensionId);
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

  const extension = resolveExtension(extensionId);
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

// Worker internal API compatibility
app.post('/action-log', internalApiAuthMiddleware, (req, res) => {
  const {
    job_id: executionId,
    action_index: actionIndex = 0,
    log_level: logLevel = 'info',
    log_type: logType = 'general',
    message = '',
    log_data: logData = {},
  } = req.body || {};

  if (!executionId) {
    return res.status(404).json({ error: 'job_id is required' });
  }

  const logRecord = {
    executionId,
    actionIndex,
    logLevel,
    logType,
    message,
    logData,
    receivedAt: new Date().toISOString(),
  };

  appendExecutionItem(executionId, 'actionLogs', logRecord);
  workerLogs.set(`action:${executionId}:${Date.now()}`, logRecord);

  const execution = getExecutionRecord(executionId);
  const logFilepath = writeExecutionJsonFile({
    executionId,
    profileId: execution.profileId,
    prefix: `action-${actionIndex}`,
    data: logRecord,
  });

  upsertExecution(executionId, {
    lastActionLogFile: logFilepath,
  });

  res.json({ status: 'ok', file: logFilepath });
});

app.post('/workflow-log', internalApiAuthMiddleware, (req, res) => {
  const {
    job_id: executionId,
    action_index: actionIndex = 0,
    log_level: logLevel = 'info',
    log_type: logType = 'workflow',
    message = '',
    log_data: logData = {},
  } = req.body || {};

  if (!executionId) {
    return res.status(404).json({ error: 'job_id is required' });
  }

  const workflowLog = {
    actionIndex,
    logLevel,
    logType,
    message,
    logData,
    receivedAt: new Date().toISOString(),
  };

  appendExecutionItem(executionId, 'workflowLogs', workflowLog);
  const execution = upsertExecution(executionId, {
    status: logData.status || 'finished',
    workflowId:
      logData.workflowId || executionHistory.get(executionId)?.workflowId,
    workflowName:
      logData.workflowName || executionHistory.get(executionId)?.workflow?.name,
    message,
    completedAtFormatted: new Date().toISOString(),
  });

  const workflowLogFile = persistWorkflowLogFile(
    executionId,
    workflowLog,
    execution.profileId
  );

  upsertExecution(executionId, {
    workflowLogFile,
  });

  res.json({ status: 'ok', file: workflowLogFile });
});

app.post('/artifact-log', internalApiAuthMiddleware, (req, res) => {
  const {
    job_id: executionId,
    artifact_type: artifactType,
    artifact_name: artifactName,
    data_base64: dataBase64,
    mime_type: mimeType,
    captured_at: capturedAt,
    metadata = {},
  } = req.body || {};

  if (!executionId) {
    return res.status(404).json({ error: 'job_id is required' });
  }

  if (!dataBase64) {
    return res.status(400).json({ error: 'data_base64 is required' });
  }

  try {
    const artifactRecord = saveBase64Artifact({
      executionId,
      artifactType,
      artifactName,
      dataBase64,
      mimeType,
      capturedAt,
      metadata,
    });

    appendExecutionItem(executionId, 'artifacts', artifactRecord);
    workerArtifacts.set(
      `${executionId}:${artifactRecord.filename}`,
      artifactRecord
    );

    res.status(202).json({
      status: 'queued',
      artifact: artifactRecord,
    });
  } catch (error) {
    res.status(500).json({
      error: 'Failed to save artifact',
      message: error.message,
    });
  }
});

app.post('/finish-job', internalApiAuthMiddleware, (req, res) => {
  const { job_id: executionId } = req.body || {};

  if (!executionId) {
    return res.status(404).json({ error: 'job_id is required' });
  }

  upsertExecution(executionId, {
    finishJobCalledAt: Date.now(),
    finishJobCalledAtFormatted: new Date().toISOString(),
  });

  const execution = getExecutionRecord(executionId);
  const finishFilepath = persistFinishJobFile(executionId, execution.profileId);

  res.json({ status: 'ok', file: finishFilepath });
});

// Receive workflow log data from extension
app.post('/api/workflow-log', (req, res) => {
  const {
    workflowId,
    status,
    timestamp,
    workflowRefData,
    variables,
    globalData,
    tableData,
  } = req.body;

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
        console.warn(
          '⚠️  [Backend] Invalid timestamp, using current date:',
          timestamp
        );
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
      dataSize: JSON.stringify(logData).length,
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
    activeTabUrl,
  } = req.body;

  if (!workflowId || !screenshotDataUrl) {
    return res
      .status(400)
      .json({ error: 'workflowId and screenshotDataUrl are required' });
  }

  try {
    // Extract base64 data from data URL
    const base64Data = screenshotDataUrl.replace(
      /^data:image\/[a-z]+;base64,/,
      ''
    );

    // Generate filename with timestamp and status
    const date = new Date(timestamp);
    const dateStr = date.toISOString().split('T')[0]; // YYYY-MM-DD
    const timeStr = date.toTimeString().split(' ')[0].replace(/:/g, '-'); // HH-MM-SS
    const statusPrefix =
      status === 'success'
        ? 'success'
        : status === 'manual'
        ? 'manual'
        : 'error';
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
      errorMessage: errorMessage?.substring(0, 50) + '...',
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
    htmlContent,
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
      tabTitle: tabTitle?.substring(0, 30) + '...',
    });

    res.json({
      success: true,
      message: 'Step data saved successfully',
      filename,
      metadataFilename,
      workflowId,
      blockId,
      hasScreenshot: !!(screenshot && screenshotType !== 'html'),
      hasHTML: !!(htmlContent || elementHTML || pageHTML),
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
const mockWorkflows = new Map(); // id -> ActionWorkflowResponse format
const mockVersions = new Map(); // workflowId -> [version, ...]
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
    return res
      .status(401)
      .json({ message: 'Unauthorized - No token provided' });
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

  console.log(
    `📋 [Workflows] LIST - returning ${paginated.length}/${allWorkflows.length}`
  );
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
    existing.workflow_config = {
      ...existing.workflow_config,
      ...workflow_config,
    };
    // Sync top-level fields from config if provided
    if (workflow_config.name) existing.name = workflow_config.name;
    if (workflow_config.description !== undefined)
      existing.description = workflow_config.description;
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
  console.log(
    `✏️  [Workflows] PATCH ${req.params.id} v${existing.version} - "${existing.name}"`
  );
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
app.post(
  '/api/v1/control/workflows/:id/approve',
  authMiddleware,
  (req, res) => {
    const wf = mockWorkflows.get(req.params.id);
    if (!wf) {
      return res.status(404).json({ message: 'Workflow not found' });
    }
    if (wf.status !== 'draft') {
      return res
        .status(400)
        .json({ message: `Cannot approve workflow in "${wf.status}" status` });
    }

    wf.status = 'approved';
    wf.updated_at = nowISO();
    mockWorkflows.set(req.params.id, wf);

    console.log(`✅ [Workflows] APPROVE ${req.params.id} - "${wf.name}"`);
    res.json({ data: toWorkflowResponse(wf) });
  }
);

// POST /api/v1/control/workflows/:id/deprecate — Deprecate workflow
app.post(
  '/api/v1/control/workflows/:id/deprecate',
  authMiddleware,
  (req, res) => {
    const wf = mockWorkflows.get(req.params.id);
    if (!wf) {
      return res.status(404).json({ message: 'Workflow not found' });
    }

    wf.status = 'deprecated';
    wf.updated_at = nowISO();
    mockWorkflows.set(req.params.id, wf);

    console.log(`⚠️  [Workflows] DEPRECATE ${req.params.id} - "${wf.name}"`);
    res.json({ data: toWorkflowResponse(wf) });
  }
);

// GET /api/v1/control/workflows/:id/versions — Get version history
app.get(
  '/api/v1/control/workflows/:id/versions',
  authMiddleware,
  (req, res) => {
    const wf = mockWorkflows.get(req.params.id);
    if (!wf) {
      return res.status(404).json({ message: 'Workflow not found' });
    }

    const versions = mockVersions.get(req.params.id) || [];
    console.log(
      `📜 [Workflows] VERSIONS ${req.params.id} - ${versions.length} versions`
    );
    res.json({ data: versions });
  }
);

// POST /api/v1/control/workflows/:id/rollback — Rollback to version
app.post(
  '/api/v1/control/workflows/:id/rollback',
  authMiddleware,
  (req, res) => {
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

    console.log(
      `⏪ [Workflows] ROLLBACK ${req.params.id} to ${target_version_id} - "${wf.name}"`
    );
    res.json({
      data: {
        workflow: toWorkflowResponse(wf),
        rolled_back_to_version: targetVersion.version,
        new_version: wf.version,
      },
    });
  }
);

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
      extension.ws.send(
        JSON.stringify({
          command: 'ping',
          requestId: uuidv4(),
        })
      );
    } else {
      connectedExtensions.delete(extensionId);
      console.log(`🗑️  Removed dead connection: ${extensionId}`);
    }
  });
}, 30000);

// Clean up old execution history (keep last 1000)
setInterval(() => {
  if (executionHistory.size > 1000) {
    const entries = Array.from(executionHistory.entries()).sort(
      (a, b) => (b[1].requestedAt || 0) - (a[1].requestedAt || 0)
    );

    const toKeep = entries.slice(0, 1000);
    executionHistory.clear();
    toKeep.forEach(([key, value]) => executionHistory.set(key, value));

    console.log('🧹 Cleaned up old execution history');
  }
}, 60000);

// ═══════════════════════════════════════════════════════════
// START SERVER
// ═══════════════════════════════════════════════════════════

server.listen(PORT, '0.0.0.0', () => {
  const bootstrapConfig = buildBootstrapConfig();
  const bootstrapUrl = `http://localhost:${PORT}/automa-init?profile_id=${encodeURIComponent(
    bootstrapConfig.profileId
  )}&ws_url=${encodeURIComponent(
    bootstrapConfig.wsUrl
  )}&internal_api_port=${encodeURIComponent(bootstrapConfig.internalApiPort)}${
    bootstrapConfig.internalApiSecret
      ? `&internal_api_secret=${encodeURIComponent(
          bootstrapConfig.internalApiSecret
        )}`
      : ''
  }`;
  const addresses = getServerAddresses(PORT);

  console.log('╔════════════════════════════════════════════════════════════╗');
  console.log('║   Automa Backend Test Server                              ║');
  console.log('╚════════════════════════════════════════════════════════════╝');
  console.log('');
  console.log(`🚀 HTTP Server:     http://localhost:${PORT}`);
  console.log(`🔌 WebSocket:       ws://localhost:${PORT}/ws`);
  console.log(`🔑 WS Token:        ${AUTH_TOKEN}`);
  console.log(`🧪 Init URL:        ${bootstrapUrl}`);
  console.log(`🧷 Internal API:    http://localhost:${INTERNAL_API_PORT}`);
  console.log(`🔐 Internal Secret: ${INTERNAL_API_SECRET || '(empty)'}`);
  console.log('');
  console.log('🌐 Reachable Addresses:');
  addresses.forEach((address) => console.log(`   ${address}`));
  console.log('');
  console.log('🔐 IAM Auth (/api/v1/iam):');
  console.log(
    `   POST /api/v1/iam/auth/login/password   - Login (test@automa.dev / 123456)`
  );
  console.log(
    `   POST /api/v1/iam/auth/rotate           - Rotate token (body: { refresh_token })`
  );
  console.log(`   POST /api/v1/iam/auth/logout           - Logout`);
  console.log('');
  console.log('📋 Workflows (/api/v1/control/workflows):');
  console.log(
    `   POST   .../workflows/list              - List (body: { skip, limit })`
  );
  console.log(`   GET    .../workflows/:id               - Get by ID`);
  console.log(`   POST   .../workflows                   - Create`);
  console.log(`   PATCH  .../workflows/:id               - Update config`);
  console.log(`   DELETE .../workflows/:id               - Delete`);
  console.log(
    `   POST   .../workflows/:id/approve       - Approve (draft -> approved)`
  );
  console.log(`   POST   .../workflows/:id/deprecate     - Deprecate`);
  console.log(`   GET    .../workflows/:id/versions      - Version history`);
  console.log(
    `   POST   .../workflows/:id/rollback      - Rollback to version`
  );
  console.log('');
  console.log('📁 Folders:');
  console.log(
    `   GET /folders  |  POST /folders  |  PUT /folders/:id  |  DELETE /folders/:id`
  );
  console.log('');
  console.log('📦 Packages:');
  console.log(
    `   GET /packages |  POST /packages |  PUT /packages/:id |  DELETE /packages/:id`
  );
  console.log('');
  console.log('📡 Worker-Compatible HTTP APIs:');
  console.log(
    `   GET  /health                           - Health / test connection`
  );
  console.log(
    `   GET  /healthz                          - Internal API health`
  );
  console.log(
    `   GET  /automa-init                      - Worker bootstrap tab`
  );
  console.log(`   GET  /api/bootstrap                    - Bootstrap JSON`);
  console.log(`   POST /action-log                       - Worker action log`);
  console.log(
    `   POST /workflow-log                     - Worker workflow log`
  );
  console.log(
    `   POST /artifact-log                     - Worker artifact log`
  );
  console.log(
    `   POST /finish-job                       - Worker finish-job callback`
  );
  console.log(
    `   POST /api/workflow-log                 - Workflow execution log`
  );
  console.log(`   POST /api/screenshot                   - Screenshot upload`);
  console.log(
    `   POST /api/screenshot-step              - Step screenshot upload`
  );
  console.log('');
  console.log('📡 WebSocket Control:');
  console.log(
    `   GET  /api/extensions                   - Connected extensions`
  );
  console.log(
    `   POST /api/execute                      - Execute workflow on extension`
  );
  console.log(
    `   POST /api/execute-all                  - Execute on all extensions`
  );
  console.log(
    `   POST /api/stop/:executionId            - Stop workflow execution`
  );
  console.log(`   GET  /api/executions                   - Execution history`);
  console.log(`   GET  /api/executions/:id               - Specific execution`);
  console.log('');
  console.log('📝 Waiting for connections...');
  console.log('════════════════════════════════════════════════════════════');
});

// Graceful shutdown
async function shutdown(signal) {
  console.log(`\n🛑 ${signal} signal received: closing server`);

  await Promise.all(
    Array.from(browserSessions.keys()).map((profileId) =>
      closeBrowserSession(profileId)
    )
  );

  server.close(() => {
    console.log('✅ Server closed');
    process.exit(0);
  });
}

process.on('SIGTERM', () => {
  shutdown('SIGTERM').catch((error) => {
    console.error('❌ Shutdown error:', error);
    process.exit(1);
  });
});

process.on('SIGINT', () => {
  shutdown('SIGINT').catch((error) => {
    console.error('❌ Shutdown error:', error);
    process.exit(1);
  });
});
