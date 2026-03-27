const fs = require('fs');
const path = require('path');

const BASE_URL = process.env.BASE_URL || 'http://localhost:8000';

async function request(url, options = {}) {
  const response = await fetch(`${BASE_URL}${url}`, options);
  const text = await response.text();

  let body = text;
  try {
    body = JSON.parse(text);
  } catch (error) {
    // keep text response
  }

  if (!response.ok) {
    throw new Error(
      `${response.status} ${response.statusText}: ${
        typeof body === 'string' ? body : JSON.stringify(body)
      }`
    );
  }

  return body;
}

async function main() {
  const [command = 'health', ...args] = process.argv.slice(2);

  switch (command) {
    case 'health': {
      console.log(await request('/health'));
      break;
    }

    case 'bootstrap': {
      console.log(await request('/api/bootstrap'));
      break;
    }

    case 'extensions': {
      console.log(await request('/api/extensions'));
      break;
    }

    case 'executions': {
      console.log(await request('/api/executions'));
      break;
    }

    case 'execute': {
      const [connectionId, workflowPath] = args;
      if (!connectionId || !workflowPath) {
        throw new Error(
          'Usage: node test-client.js execute <connectionId> <workflow.json>'
        );
      }

      const absolutePath = path.resolve(workflowPath);
      const workflow = JSON.parse(fs.readFileSync(absolutePath, 'utf8'));

      console.log(
        await request('/api/execute', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            connectionId,
            workflow,
            inputs: {},
            options: { checkParams: false },
          }),
        })
      );
      break;
    }

    default:
      throw new Error(
        `Unknown command "${command}". Use one of: health, bootstrap, extensions, executions, execute`
      );
  }
}

main().catch((error) => {
  console.error(error.message);
  process.exit(1);
});
