import { fileSaver } from '@/utils/helper';
import BrowserAPIService from '@/service/browser-api/BrowserAPIService';
import { IS_FIREFOX } from '@/common/utils/constant';
import { waitTabLoaded } from '../helper';

/**
 * Get previous step information from engine history or prevBlock
 * @param {Object} engine - WorkflowEngine instance
 * @param {string} currentBlockId - Current block ID
 * @param {Object} prevBlock - Previous block object
 * @returns {Object|null} Previous step information or null
 */
function getPreviousStep(engine, currentBlockId, prevBlock) {
  // Try to get from engine history
  if (engine?.history && engine.history.length > 0) {
    const secondToLastLog = engine.history[engine.history.length - 1];
    if (secondToLastLog && secondToLastLog.blockId !== currentBlockId) {
      return {
        blockId: secondToLastLog.blockId,
        blockLabel: secondToLastLog.name,
        description: secondToLastLog.description || '',
        timestamp: secondToLastLog.timestamp,
      };
    }
  }

  // Fallback to prevBlock
  if (prevBlock) {
    return {
      blockId: prevBlock.id,
      blockLabel: prevBlock.label,
      description: prevBlock.data?.description || '',
      timestamp: prevBlock?.startedAt || Date.now(),
    };
  }

  return null;
}

async function saveImage({ filename, uri, ext }) {
  const hasDownloadAccess = await BrowserAPIService.permissions.contains({
    permissions: ['downloads'],
  });
  const name = `${filename || 'Screenshot'}.${ext || 'png'}`;

  if (hasDownloadAccess) {
    await BrowserAPIService.downloads.download({
      url: uri,
      filename: name,
    });

    return;
  }

  const image = new Image();

  image.onload = () => {
    const canvas = document.createElement('canvas');
    canvas.width = image.width;
    canvas.height = image.height;

    const context = canvas.getContext('2d');
    context.drawImage(image, 0, 0);

    fileSaver(name, canvas.toDataURL());
  };

  image.src = uri;
}

/**
 * Send screenshot to backend for step logging
 * @param {Object} data - Screenshot and metadata
 */
async function sendScreenshotToBackend(data) {
  try {
    // Get WebSocket config to determine backend URL
    const { wsConfig } = await BrowserAPIService.storage.local.get('wsConfig');
    if (!wsConfig || !wsConfig.url) {
      return;
    }

    // Extract base URL from WebSocket URL
    const baseUrl = wsConfig.url
      .replace('ws://', 'http://')
      .replace('wss://', 'https://');
    const apiUrl = `${baseUrl}/api/screenshot-step`;

    const response = await fetch(apiUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(data),
    });

    if (response.ok) {
      await response.json();
    }
  } catch (error) {
    // Silent fail for backend logging
  }
}

async function takeScreenshotAndLog({ data, id, label, prevBlock }) {
  const saveToComputer =
    typeof data.saveToComputer === 'undefined' || data.saveToComputer;

  try {
    let screenshot = null;
    const options = {
      quality: data.quality,
      format: data.ext || 'png',
    };

    // Get previous step from workflow history or prevBlock
    const prevStep = getPreviousStep(this.engine, id, prevBlock);

    const saveScreenshot = async (dataUrl) => {
      if (data.saveToColumn) this.addDataToColumn(data.dataColumn, dataUrl);
      if (saveToComputer)
        await saveImage({
          filename: data.fileName,
          uri: dataUrl,
          ext: data.ext,
        });
      if (data.assignVariable)
        await this.setVariable(data.variableName, dataUrl);
    };

    if (data.captureActiveTab) {
      if (!this.activeTab.id) {
        throw new Error('no-tab');
      }

      let tab = null;
      const isChrome = !IS_FIREFOX;
      const captureTab = async () => {
        let result = null;

        if (isChrome) {
          const currentTab = await BrowserAPIService.tabs.get(
            this.activeTab.id
          );
          result = await BrowserAPIService.tabs.captureVisibleTab(
            currentTab.windowId,
            options
          );
        } else {
          result = await BrowserAPIService.tabs.captureTab(
            this.activeTab.id,
            options
          );
        }

        return result;
      };

      if (isChrome) {
        [tab] = await BrowserAPIService.tabs.query({
          active: true,
          url: '*://*/*',
        });

        if (this.windowId) {
          await BrowserAPIService.windows.update(this.windowId, {
            focused: true,
          });
        }
      }

      await BrowserAPIService.tabs.update(this.activeTab.id, { active: true });
      await waitTabLoaded({ tabId: this.activeTab.id, listenError: true });

      screenshot = await (data.fullPage ||
      ['element', 'fullpage'].includes(data.type)
        ? this._sendMessageToTab({
            label,
            options,
            data: {
              type: data.type,
              selector: data.selector,
            },
            tabId: this.activeTab.id,
          })
        : captureTab());

      if (tab) {
        await BrowserAPIService.windows.update(tab.windowId, { focused: true });
        await BrowserAPIService.tabs.update(tab.id, { active: true });
      }

      await saveScreenshot(screenshot);
    } else {
      screenshot = await BrowserAPIService.tabs.captureVisibleTab(options);

      await saveScreenshot(screenshot);
    }

    // Send screenshot to backend for step logging
    await sendScreenshotToBackend({
      screenshot,
      blockId: id,
      blockLabel: label,
      tabUrl: this.activeTab?.url || 'unknown',
      tabTitle: this.activeTab?.title || 'unknown',
      timestamp: Date.now(),
      workflowId: this.engine?.id || 'unknown',
      description: data.description || '',
      screenshotType: data.type || 'page',
      prevStep,
    });

    return {
      data: screenshot,
      nextBlockId: this.getBlockConnections(id),
    };
  } catch (error) {
    if (data.type === 'element') error.data = { selector: data.selector };

    throw error;
  }
}

export default takeScreenshotAndLog;
