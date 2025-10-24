/* eslint-disable class-methods-use-this */
import { IS_FIREFOX } from '@/common/utils/constant';
import { sleep } from '@/utils/helper';
import { MessageListener } from '@/utils/message';
import Browser from 'webextension-polyfill';

const OFFSCREEN_URL = Browser.runtime.getURL('/offscreen.html');

class BackgroundOffscreen {
  /** @type {BackgroundOffscreen} */
  static #_instance;

  /**
   * OffscreenService singleton
   * @returns {BackgroundOffscreen}
   */
  static get instance() {
    if (!this.#_instance) {
      this.#_instance = new BackgroundOffscreen();
    }

    return this.#_instance;
  }

  /** @type {MessageListener} */
  #messageListener;

  constructor() {
    this.#messageListener = new MessageListener('offscreen');

    this.on = this.#messageListener.on;
  }

  /**
   * Ensure offscreen document exists (with race condition protection)
   * @returns {Promise<boolean>}
   */
  async #ensureDocument() {
    if (IS_FIREFOX) return;

    // Check if already exists
    const isOpened = await this.isOpened();
    if (isOpened) return;

    try {
      // Use a flag to prevent multiple simultaneous creations
      if (this._creatingDocument) {
        // Wait for the other creation to complete
        while (this._creatingDocument) {
          await sleep(100);
        }
        return;
      }

      this._creatingDocument = true;

      // Double-check after acquiring lock
      const isOpenedAgain = await this.isOpened();
      if (isOpenedAgain) {
        this._creatingDocument = false;
        return;
      }

      await chrome.offscreen.createDocument({
        url: OFFSCREEN_URL,
        reasons: [
          chrome.offscreen.Reason.BLOBS,
          chrome.offscreen.Reason.CLIPBOARD,
          chrome.offscreen.Reason.IFRAME_SCRIPTING,
        ],
        justification: 'For running the workflow',
      });

      await sleep(500);
    } catch (error) {
      // If document already exists, that's fine
      if (
        error.message &&
        error.message.includes('offscreen document already exists')
      ) {
        console.log('[BackgroundOffscreen] Offscreen document already exists');
      } else {
        console.error(
          '[BackgroundOffscreen] Error creating offscreen document:',
          error
        );
        throw error;
      }
    } finally {
      this._creatingDocument = false;
    }
  }

  /**
   *
   * @returns {Promise<boolean>}
   */
  async isOpened() {
    if (IS_FIREFOX) return false;

    const contexts = await chrome.runtime.getContexts({
      documentUrls: [OFFSCREEN_URL],
      contextTypes: ['OFFSCREEN_DOCUMENT'],
    });

    return Boolean(contexts.length);
  }

  /**
   * Send message to offscreen document
   * @param {string} name
   * @param {*} data
   * @returns {Promise<*>}
   */
  async sendMessage(name, data) {
    await this.#ensureDocument();

    return this.#messageListener.sendMessage(name, data);
  }

  /**
   * Close offscreen document if exists
   * @returns {Promise<void>}
   */
  async closeDocument() {
    if (IS_FIREFOX) return;

    try {
      const isOpened = await this.isOpened();
      if (isOpened) {
        await chrome.offscreen.closeDocument();
        console.log('[BackgroundOffscreen] Offscreen document closed');
      }
    } catch (error) {
      console.error(
        '[BackgroundOffscreen] Error closing offscreen document:',
        error
      );
    }
  }

  /**
   * Recreate offscreen document (close and create new one)
   * @returns {Promise<void>}
   */
  async recreateDocument() {
    if (IS_FIREFOX) return;

    try {
      await this.closeDocument();
      await sleep(200);
      await this.#ensureDocument();
      console.log('[BackgroundOffscreen] Offscreen document recreated');
    } catch (error) {
      console.error(
        '[BackgroundOffscreen] Error recreating offscreen document:',
        error
      );
    }
  }
}

export default BackgroundOffscreen;
