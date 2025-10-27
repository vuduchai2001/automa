import BrowserAPIService from '@/service/browser-api/BrowserAPIService';
import backendApi from '@/utils/backendApi';

/**
 * Screenshot Manager utility for handling workflow screenshots
 */
class ScreenshotManager {
  /**
   * Take screenshot on workflow success (final step)
   * @param {Object} block - The final block that completed successfully
   * @param {Object} activeTab - Active tab information
   * @param {string} workflowId - Workflow ID
   */
  static async takeScreenshotOnSuccess(block, activeTab, workflowId) {
    try {
      // Check if we have an active tab
      if (!activeTab || !activeTab.id) {
        console.warn(
          '[ScreenshotManager] No active tab for success screenshot'
        );
        return;
      }

      // Take screenshot using Chrome API with optimized quality
      const screenshotDataUrl = await BrowserAPIService.tabs.captureVisibleTab(
        activeTab.windowId,
        { format: 'jpeg', quality: 85 }
      );

      if (!screenshotDataUrl) {
        console.warn(
          '[ScreenshotManager] Failed to capture success screenshot'
        );
        return;
      }

      // Send screenshot to backend
      await backendApi.sendScreenshot({
        workflowId,
        blockId: block.id,
        blockLabel: block.label,
        errorMessage: null,
        errorStack: null,
        status: 'success',
        timestamp: Date.now(),
        screenshotDataUrl,
        activeTabUrl: activeTab.url,
      });
    } catch (screenshotError) {
      console.error(
        '[ScreenshotManager] Error taking success screenshot:',
        screenshotError
      );
    }
  }

  /**
   * Take screenshot on error and send to backend
   * @param {Error} error - The error that occurred
   * @param {Object} block - The block that caused the error
   * @param {Object} activeTab - Active tab information
   * @param {string} workflowId - Workflow ID
   */
  static async takeScreenshotOnError(error, block, activeTab, workflowId) {
    try {
      // Check if we have an active tab
      if (!activeTab || !activeTab.id) {
        console.warn('[ScreenshotManager] No active tab for screenshot');
        return;
      }

      // Take screenshot using Chrome API with optimized quality
      const screenshotDataUrl = await BrowserAPIService.tabs.captureVisibleTab(
        activeTab.windowId,
        { format: 'jpeg', quality: 85 }
      );

      if (!screenshotDataUrl) {
        console.warn('[ScreenshotManager] Failed to capture screenshot');
        return;
      }

      // Send screenshot to backend
      await backendApi.sendScreenshot({
        workflowId,
        blockId: block.id,
        blockLabel: block.label,
        errorMessage: error.message,
        errorStack: error.stack,
        status: 'error',
        timestamp: Date.now(),
        screenshotDataUrl,
        activeTabUrl: activeTab.url,
      });
    } catch (screenshotError) {
      console.error(
        '[ScreenshotManager] Error taking screenshot:',
        screenshotError
      );
    }
  }
}

export default ScreenshotManager;
