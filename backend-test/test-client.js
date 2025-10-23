#!/usr/bin/env node

/**
 * Test client to simulate workflow execution requests
 * Usage: node test-client.js [extensionId]
 */

const http = require('http');

const BASE_URL = 'http://localhost:8000';
const EXTENSION_ID = process.argv[2] || 'test-extension-id';

// Sample workflow
const sampleWorkflow = {
  drawflow: {
    nodes: [
      {
        id: 'trigger-1',
        label: 'trigger',
        data: {
          type: 'manual',
        },
      },
      {
        id: 'new-tab-1',
        label: 'new-tab',
        data: {
          url: 'https://example.com',
          active: true,
        },
      },
      {
        id: 'delay-1',
        label: 'delay',
        data: {
          time: 2000,
        },
      },
      {
        id: 'get-text-1',
        label: 'get-text',
        data: {
          selector: 'h1',
          multiple: false,
        },
      },
    ],
    edges: [
      {
        id: 'edge-1',
        source: 'trigger-1',
        target: 'new-tab-1',
        sourceHandle: 'trigger-1-output-1',
        targetHandle: 'new-tab-1-input-1',
      },
      {
        id: 'edge-2',
        source: 'new-tab-1',
        target: 'delay-1',
        sourceHandle: 'new-tab-1-output-1',
        targetHandle: 'delay-1-input-1',
      },
      {
        id: 'edge-3',
        source: 'delay-1',
        target: 'get-text-1',
        sourceHandle: 'delay-1-output-1',
        targetHandle: 'get-text-1-input-1',
      },
    ],
  },
  name: 'Test Workflow from Script',
  settings: {
    saveLog: true,
    blockDelay: 0,
    notification: true,
  },
};

function makeRequest(path, method = 'GET', body = null) {
  return new Promise((resolve, reject) => {
    const url = new URL(path, BASE_URL);
    const options = {
      hostname: url.hostname,
      port: url.port,
      path: url.pathname + url.search,
      method: method,
      headers: {
        'Content-Type': 'application/json',
      },
    };

    const req = http.request(options, (res) => {
      let data = '';
      
      res.on('data', (chunk) => {
        data += chunk;
      });
      
      res.on('end', () => {
        try {
          resolve({
            status: res.statusCode,
            data: JSON.parse(data),
          });
        } catch (e) {
          resolve({
            status: res.statusCode,
            data: data,
          });
        }
      });
    });

    req.on('error', reject);

    if (body) {
      req.write(JSON.stringify(body));
    }

    req.end();
  });
}

async function main() {
  console.log('╔════════════════════════════════════════════════╗');
  console.log('║   Automa WebSocket Server Test Client         ║');
  console.log('╚════════════════════════════════════════════════╝');
  console.log('');
~
  try {
    // 1. Check health
    console.log('1️⃣  Checking server health...');
    const health = await makeRequest('/health');
    console.log('   Status:', health.data.status);
    console.log('   Connected extensions:', health.data.connectedExtensions);
    console.log('');

    // 2. List connected extensions
    console.log('2️⃣  Getting connected extensions...');
    const extensions = await makeRequest('/api/extensions');
    console.log('   Total:', extensions.data.count);
    if (extensions.data.extensions.length > 0) {
      extensions.data.extensions.forEach(ext => {
        console.log(`   - ${ext.extensionId} (v${ext.version})`);
      });
    } else {
      console.log('   ⚠️  No extensions connected!');
      console.log('   Please connect the browser extension first.');
      return;
    }
    console.log('');

    // 3. Execute workflow
    console.log('3️⃣  Executing test workflow...');
    console.log('   Extension ID:', EXTENSION_ID);
    const execution = await makeRequest('/api/execute', 'POST', {
      extensionId: EXTENSION_ID,
      workflow: sampleWorkflow,
      inputs: {
        testVariable: 'Hello from test client!',
        timestamp: new Date().toISOString(),
      },
    });

    if (execution.status === 200) {
      console.log('   ✅ Success!');
      console.log('   Execution ID:', execution.data.executionId);
      console.log('   Status:', execution.data.status);
      console.log('');

      // 4. Wait and check execution status
      console.log('4️⃣  Waiting 5 seconds before checking status...');
      await new Promise(resolve => setTimeout(resolve, 5000));

      const execStatus = await makeRequest(`/api/executions/${execution.data.executionId}`);
      console.log('   Execution status:', execStatus.data.status);
      if (execStatus.data.duration) {
        console.log('   Duration:', `${execStatus.data.duration}ms`);
      }
      console.log('');

      // 5. Get execution history
      console.log('5️⃣  Getting execution history...');
      const history = await makeRequest('/api/executions');
      console.log('   Total executions:', history.data.count);
      console.log('   Recent executions:');
      history.data.executions.slice(0, 5).forEach((exec, i) => {
        console.log(`   ${i + 1}. ${exec.executionId}`);
        console.log(`      Status: ${exec.status}`);
        if (exec.workflow) {
          console.log(`      Workflow: ${exec.workflow.name}`);
        }
      });
    } else {
      console.log('   ❌ Failed!');
      console.log('   Status:', execution.status);
      console.log('   Error:', execution.data);
    }

  } catch (error) {
    console.error('❌ Error:', error.message);
    console.log('');
    console.log('Make sure the WebSocket server is running:');
    console.log('   cd backend-test');
    console.log('   npm start');
  }

  console.log('');
  console.log('════════════════════════════════════════════════');
  console.log('Test completed!');
}

main();

