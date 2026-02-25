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

async function saveTextFile({ filename, content }) {
  const hasDownloadAccess = await BrowserAPIService.permissions.contains({
    permissions: ['downloads'],
  });
  const name = `${filename || 'HTML'}.txt`;
  const blob = new Blob([content], { type: 'text/plain' });
  const dataUrl = URL.createObjectURL(blob);

  if (hasDownloadAccess) {
    await BrowserAPIService.downloads.download({
      url: dataUrl,
      filename: name,
    });
    URL.revokeObjectURL(dataUrl);
    return;
  }

  // Fallback: save using fileSaver
  fileSaver(name, dataUrl);
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

  // Get screenshot types - support both new array format and legacy single type
  const worker = this;

  let screenshotTypes = [];
  if (Array.isArray(data.types) && data.types.length > 0) {
    screenshotTypes = data.types;
  } else if (data.type) {
    screenshotTypes = [data.type];
  }

  // Check if we need to capture HTML
  const captureHTML = data.captureHTML || false;

  // If no screenshot types and no HTML capture, skip
  if (screenshotTypes.length === 0 && !captureHTML) {
    return {
      data: '',
      nextBlockId: this.getBlockConnections(id),
    };
  }

  // Store reference to this context

  try {
    const options = {
      quality: data.quality,
      format: data.ext || 'png',
    };

    // Get previous step from workflow history or prevBlock
    const prevStep = getPreviousStep(worker.engine, id, prevBlock);

    const saveScreenshot = async (dataUrl, type) => {
      const filename = data.fileName
        ? `${data.fileName}_${type}`
        : `Screenshot_${type}`;

      if (data.saveToColumn) worker.addDataToColumn(data.dataColumn, dataUrl);
      if (saveToComputer)
        await saveImage({
          filename,
          uri: dataUrl,
          ext: data.ext,
        });
      if (data.assignVariable) {
        // Use specific variable name for this type, or fallback to default
        const variableName =
          data.variableNames?.[type] ||
          `${data.variableName || 'screenshot'}_${type}`;
        await worker.setVariable(variableName, dataUrl);
      }
    };

    // Process each screenshot type
    const screenshots = {};
    const htmlDataMap = new Map();

    if (data.captureActiveTab) {
      if (!worker.activeTab.id) {
        throw new Error('no-tab');
      }

      let tab = null;
      const isChrome = !IS_FIREFOX;
      const captureTab = async () => {
        let result = null;

        if (isChrome) {
          const currentTab = await BrowserAPIService.tabs.get(
            worker.activeTab.id
          );
          result = await BrowserAPIService.tabs.captureVisibleTab(
            currentTab.windowId,
            options
          );
        } else {
          result = await BrowserAPIService.tabs.captureTab(
            worker.activeTab.id,
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

        if (worker.windowId) {
          await BrowserAPIService.windows.update(worker.windowId, {
            focused: true,
          });
        }
      }

      await BrowserAPIService.tabs.update(worker.activeTab.id, {
        active: true,
      });
      await waitTabLoaded({ tabId: worker.activeTab.id, listenError: true });

      // Capture screenshots for each selected type
      for (const type of screenshotTypes) {
        let screenshot = null;

        if (type === 'fullpage') {
          screenshot = await BrowserAPIService.tabs.sendMessage(
            worker.activeTab.id,
            {
              isBlock: true,
              name: 'take-screenshot',
              label: 'take-screenshot',
              options,
              data: {
                type: 'fullpage',
              },
              tabId: worker.activeTab.id,
            },
            { frameId: worker.activeTab.frameId }
          );
        } else if (type === 'page') {
          screenshot = await captureTab();
        }

        if (screenshot) {
          screenshots[type] = screenshot;
          await saveScreenshot(screenshot, type);
        }
      }

      // Handle HTML-only capture (no screenshot)
      if (captureHTML) {
        let elementHTML = null;
        let pageHTML = null;
        let htmlContent = null;

        // If selector is provided, try to get specific element
        if (data.selector && data.selector.trim()) {
          try {
            const result = await BrowserAPIService.tabs.sendMessage(
              worker.activeTab.id,
              {
                isBlock: true,
                name: 'take-screenshot',
                label: 'take-screenshot',
                options,
                data: {
                  type: 'element',
                  selector: data.selector,
                },
                tabId: worker.activeTab.id,
              },
              { frameId: worker.activeTab.frameId }
            );

            if (typeof result === 'object' && result.elementHTML) {
              elementHTML = result.elementHTML;
              pageHTML = result.pageHTML;
              htmlContent = elementHTML; // Use element HTML as main content
            }
          } catch (error) {
            console.warn(
              'Failed to capture element HTML, falling back to full page:',
              error
            );
          }
        }

        // If no selector provided or element not found, get full page HTML
        if (!htmlContent) {
          try {
            const result = await BrowserAPIService.tabs.sendMessage(
              worker.activeTab.id,
              {
                isBlock: true,
                name: 'get-page-html',
                label: 'get-page-html',
                data: {},
                tabId: worker.activeTab.id,
              },
              { frameId: worker.activeTab.frameId }
            );

            if (result && result.pageHTML) {
              pageHTML = result.pageHTML;
              htmlContent = pageHTML;
            }
          } catch (error) {
            console.warn('Failed to capture page HTML:', error);
          }
        }

        if (htmlContent) {
          // Store HTML for backend
          htmlDataMap.set('html', { elementHTML, pageHTML, htmlContent });

          // Save HTML file only if saveToComputer is enabled
          if (saveToComputer) {
            const filename = data.fileName
              ? `${data.fileName}_html`
              : 'HTML_content';
            await saveTextFile({ filename, content: htmlContent });
          }

          // Assign HTML to variables if enabled
          if (data.assignVariable) {
            const htmlVariableName = data.htmlVariableName || 'htmlContent';
            await worker.setVariable(htmlVariableName, htmlContent);
          }
        }
      }

      if (tab) {
        await BrowserAPIService.windows.update(tab.windowId, { focused: true });
        await BrowserAPIService.tabs.update(tab.id, { active: true });
      }
    } else if (screenshotTypes.includes('page')) {
      // For non-active tab capture, only support page type
      const screenshot = await BrowserAPIService.tabs.captureVisibleTab(
        options
      );
      screenshots.page = screenshot;
      await saveScreenshot(screenshot, 'page');
    }

    // Send screenshots to backend for step logging
    for (const [type, screenshot] of Object.entries(screenshots)) {
      const backendData = {
        screenshot,
        blockId: id,
        blockLabel: label,
        tabUrl: worker.activeTab?.url || 'unknown',
        tabTitle: worker.activeTab?.title || 'unknown',
        timestamp: Date.now(),
        workflowId: worker.engine?.id || 'unknown',
        description: data.description || '',
        screenshotType: type,
        prevStep,
      };

      // HTML data is now handled separately in HTML-only capture

      await sendScreenshotToBackend(backendData);
    }

    // Send HTML-only data to backend if no screenshots
    if (captureHTML && htmlDataMap.has('html')) {
      const htmlData = htmlDataMap.get('html');
      const backendData = {
        screenshot:
          'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', // 1x1 transparent PNG
        blockId: id,
        blockLabel: label,
        tabUrl: worker.activeTab?.url || 'unknown',
        tabTitle: worker.activeTab?.title || 'unknown',
        timestamp: Date.now(),
        workflowId: worker.engine?.id || 'unknown',
        description: data.description || '',
        screenshotType: 'html',
        elementHTML: htmlData.elementHTML,
        pageHTML: htmlData.pageHTML,
        htmlContent: htmlData.htmlContent,
        prevStep,
      };

      await sendScreenshotToBackend(backendData);
    }

    // Return the first screenshot as main data (for backward compatibility)
    const mainScreenshot = screenshots[screenshotTypes[0]] || screenshots.page;

    return {
      data: mainScreenshot,
      nextBlockId: worker.getBlockConnections(id),
    };
  } catch (error) {
    if (screenshotTypes.includes('element'))
      error.data = { selector: data.selector };

    throw error;
  }
}

export default takeScreenshotAndLog;
