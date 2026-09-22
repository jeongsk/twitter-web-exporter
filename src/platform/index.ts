import { unsafeWindow, GM_registerMenuCommand } from '$';
import type { Tweet } from '@/types';
import logger from '@/utils/logger';
import type { MenuAction, ResponseListener } from './types';

const page = unsafeWindow ?? window;

export function getAccountId(): string {
  return page.__META_DATA__?.userId ?? 'unknown';
}

export function registerMenuCommand(label: string, handler: () => void, action?: MenuAction) {
  void action;
  GM_registerMenuCommand(label, handler);
}

/** UserScript transport. The Chrome build replaces this module with its isolated adapter. */
export function observeResponses(listener: ResponseListener) {
  const originalOpen = page.XMLHttpRequest.prototype.open;
  page.XMLHttpRequest.prototype.open = function (method: string, url: string | URL) {
    this.addEventListener(
      'load',
      () => {
        try {
          listener({ method, url: String(url) }, this);
        } catch (error) {
          logger.error('Response listener failed', error);
        }
      },
      { once: true },
    );
    // Preserve every argument, including credentials and synchronous request flags.
    // eslint-disable-next-line prefer-rest-params
    Reflect.apply(originalOpen, this, arguments);
  };
  logger.info('Hooked into XMLHttpRequest');
  setTimeout(() => {
    if (!('webpackChunk_twitter_responsive_web' in page)) {
      logger.warn('UserScript page context could not be verified. Check your script manager.');
    }
  }, 1000);
}

export const supportsVaultBackup = false;
export async function openVaultBackup() {}
export async function notifyTweetsCaptured(module: string, tweets: Tweet[]) {
  void module;
  void tweets;
}
