'use strict';

const path = require('path');
const { fork } = require('node:child_process');

class WindowsSelectionPopupPresenter {
  constructor(logger) {
    this.logger = logger;
    this.popupScriptPath = path.join(__dirname, 'showSelectionPopupCli.js');
    this.activeChild = null;
  }

  isSupported() {
    return process.platform === 'win32';
  }

  async showAction(payload) {
    if (!this.isSupported()) {
      return {
        action: 'unsupported',
        message: 'Native selection popup is only available on Windows.'
      };
    }

    if (this.activeChild) {
      return {
        action: 'busy',
        message: 'Native selection popup is already open.'
      };
    }

    this.logger &&
      this.logger.info('Opening native selection popup.', {
        payload,
        popupScriptPath: this.popupScriptPath,
        execPath: process.execPath
      });

    return new Promise((resolve) => {
      const child = fork(this.popupScriptPath, [], {
        cwd: path.dirname(this.popupScriptPath),
        env: {
          ...process.env,
          ELECTRON_RUN_AS_NODE: '1'
        },
        execArgv: [],
        silent: true,
        windowsHide: true
      });

      this.activeChild = child;
      let settled = false;
      let stderr = '';
      let stdout = '';

      const finish = (result) => {
        if (settled) {
          return;
        }

        settled = true;
        if (this.activeChild === child) {
          this.activeChild = null;
        }

        resolve({
          ...(result || { action: 'dismiss' }),
          stderr: stderr.trim() || undefined,
          stdout: stdout.trim() || undefined
        });
      };

      if (child.stdout) {
        child.stdout.setEncoding('utf8');
        child.stdout.on('data', (chunk) => {
          stdout += chunk;
        });
      }

      if (child.stderr) {
        child.stderr.setEncoding('utf8');
        child.stderr.on('data', (chunk) => {
          stderr += chunk;
        });
      }

      child.once('message', (message) => {
        finish(normalizePopupResult(message));
      });
      child.once('error', (error) => {
        finish({
          action: 'error',
          message: error && error.message ? error.message : String(error)
        });
      });
      child.once('exit', (code, signal) => {
        if (!settled) {
          finish(
            code && code !== 0
              ? {
                  action: 'error',
                  message: `Native selection popup process exited with code ${code}.`,
                  signal
                }
              : {
                  action: 'dismiss',
                  signal
                }
          );
        }
      });

      try {
        child.send(payload || {});
      } catch (error) {
        finish({
          action: 'error',
          message: error && error.message ? error.message : String(error)
        });
      }
    });
  }

  dispose() {
    if (!this.activeChild) {
      return;
    }

    try {
      this.activeChild.kill();
    } catch (error) {
      this.logger &&
        this.logger.warn('Failed to terminate native selection popup process.', {
          error: error && error.message ? error.message : String(error)
        });
    } finally {
      this.activeChild = null;
    }
  }
}

function normalizePopupResult(message) {
  if (!message || typeof message !== 'object') {
    return { action: 'dismiss' };
  }

  const action = typeof message.action === 'string' ? message.action : 'dismiss';
  return {
    ...message,
    action
  };
}

module.exports = {
  WindowsSelectionPopupPresenter
};
