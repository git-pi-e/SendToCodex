'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync, spawn } = require('child_process');
const { loadAuthDataFromFile, shouldUseWslAuthPath } = require('./authManager');
const { syncCodexAuthFile } = require('./codexAuthSync');

const APP_SERVER_RATE_LIMIT_SOURCE = 'codex-app-server://account/rateLimits/read';
const APP_SERVER_REQUEST_TIMEOUT_MS = 30000;

function createEmptyTokenUsage() {
  return {
    input_tokens: 0,
    cached_input_tokens: 0,
    output_tokens: 0,
    reasoning_output_tokens: 0,
    total_tokens: 0
  };
}

function asNumber(value) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : null;
}

function clampPercent(value) {
  const numeric = asNumber(value);
  if (numeric == null) {
    return 0;
  }
  return Math.max(0, Math.min(100, numeric));
}

function quoteShellSingle(value) {
  return `'${String(value).replace(/'/g, `'\\''`)}'`;
}

function normalizeAppServerRateLimitWindow(windowData, nowMs) {
  if (!windowData || typeof windowData !== 'object') {
    return null;
  }

  const resetAtSeconds = asNumber(windowData.resetsAt);
  const resetAt = resetAtSeconds ? Math.round(resetAtSeconds * 1000) : null;
  const windowMinutes = Math.max(0, Math.round(asNumber(windowData.windowDurationMins) || 0));
  const windowMs = windowMinutes * 60 * 1000;
  const elapsedMs =
    resetAt && windowMs > 0 ? Math.max(0, windowMs - Math.max(0, resetAt - nowMs)) : 0;

  return {
    usedPercent: clampPercent(windowData.usedPercent),
    timePercent: windowMs > 0 ? Math.max(0, Math.min(100, (elapsedMs / windowMs) * 100)) : 0,
    resetAt,
    outdated: Boolean(resetAt && resetAt <= nowMs),
    windowMinutes
  };
}

function getCodexRateLimitSnapshot(payload) {
  if (!payload || typeof payload !== 'object') {
    return null;
  }

  const byLimitId = payload.rateLimitsByLimitId;
  if (byLimitId && typeof byLimitId === 'object' && byLimitId.codex) {
    return byLimitId.codex;
  }

  if (payload.rateLimits && typeof payload.rateLimits === 'object') {
    return payload.rateLimits;
  }

  return null;
}

function normalizeAppServerRateLimitPayload(payload) {
  const snapshot = getCodexRateLimitSnapshot(payload);
  if (!snapshot) {
    return null;
  }

  const nowMs = Date.now();
  return {
    filePath: APP_SERVER_RATE_LIMIT_SOURCE,
    recordTimestampMs: nowMs,
    currentTimeMs: nowMs,
    planType: typeof snapshot.planType === 'string' && snapshot.planType.trim()
      ? snapshot.planType.trim()
      : null,
    sessionId: null,
    sessionCwd: null,
    totalUsage: createEmptyTokenUsage(),
    lastUsage: createEmptyTokenUsage(),
    primary: normalizeAppServerRateLimitWindow(snapshot.primary, nowMs),
    secondary: normalizeAppServerRateLimitWindow(snapshot.secondary, nowMs)
  };
}

function createLocalIsolatedCodexHome(authData) {
  const isolatedHome = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-multitool-rate-limit-'));
  const authPath = path.join(isolatedHome, 'auth.json');
  syncCodexAuthFile(authPath, authData);

  return {
    authPath,
    command: 'codex',
    args: ['app-server', '--stdio'],
    env: {
      ...process.env,
      CODEX_HOME: isolatedHome
    },
    cleanup: () => {
      const resolved = path.resolve(isolatedHome);
      const tmpRoot = path.resolve(os.tmpdir());
      if (!resolved.startsWith(tmpRoot + path.sep)) {
        throw new Error(`Refusing to clean unexpected Codex app-server directory: ${resolved}`);
      }
      fs.rmSync(resolved, { recursive: true, force: true });
    }
  };
}

function createWslIsolatedCodexHome(authData) {
  const linuxHome = String(
    execFileSync(
      'wsl.exe',
      ['sh', '-lc', 'mktemp -d /tmp/codex-multitool-rate-limit.XXXXXX'],
      { encoding: 'utf8', windowsHide: true }
    )
  ).trim();
  if (!linuxHome.startsWith('/tmp/codex-multitool-rate-limit.')) {
    throw new Error(`Refusing to use unexpected WSL Codex app-server directory: ${linuxHome}`);
  }

  const windowsHome = String(
    execFileSync(
      'wsl.exe',
      ['sh', '-lc', `wslpath -w ${quoteShellSingle(linuxHome)}`],
      { encoding: 'utf8', windowsHide: true }
    )
  ).trim();
  const authPath = path.join(windowsHome, 'auth.json');
  syncCodexAuthFile(authPath, authData);

  return {
    authPath,
    command: 'wsl.exe',
    args: [
      'sh',
      '-lc',
      `CODEX_HOME=${quoteShellSingle(linuxHome)} codex app-server --stdio`
    ],
    env: process.env,
    cleanup: () => {
      execFileSync(
        'wsl.exe',
        ['sh', '-lc', `rm -rf -- ${quoteShellSingle(linuxHome)}`],
        { windowsHide: true }
      );
    }
  };
}

function createIsolatedCodexHome(authData) {
  return shouldUseWslAuthPath()
    ? createWslIsolatedCodexHome(authData)
    : createLocalIsolatedCodexHome(authData);
}

function truncateLogText(value, maxLength = 4000) {
  const text = String(value || '');
  return text.length > maxLength ? `${text.slice(0, maxLength)}...` : text;
}

async function runCodexAppServerRequests(isolated, logger) {
  return new Promise((resolve, reject) => {
    const child = spawn(isolated.command, isolated.args, {
      env: isolated.env,
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true
    });
    let nextId = 1;
    let stdoutBuffer = '';
    let stderrBuffer = '';
    let settled = false;
    const pending = new Map();

    const fail = (error) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timeout);
      for (const request of pending.values()) {
        request.reject(error);
      }
      pending.clear();
      try {
        child.kill();
      } catch {
        // Ignore process cleanup failures.
      }
      reject(error);
    };

    const timeout = setTimeout(() => {
      fail(new Error('Codex app-server rate-limit request timed out'));
    }, APP_SERVER_REQUEST_TIMEOUT_MS);

    const sendRequest = (method, params) => {
      if (settled) {
        return Promise.reject(new Error('Codex app-server request already settled'));
      }

      const id = nextId++;
      const message = { id, method };
      if (params !== undefined) {
        message.params = params;
      }

      return new Promise((requestResolve, requestReject) => {
        pending.set(id, {
          method,
          resolve: requestResolve,
          reject: requestReject
        });
        child.stdin.write(`${JSON.stringify(message)}\n`, 'utf8', (error) => {
          if (error) {
            pending.delete(id);
            requestReject(error);
          }
        });
      });
    };

    child.stdout.on('data', (chunk) => {
      stdoutBuffer += chunk.toString('utf8');
      let newlineIndex = stdoutBuffer.indexOf('\n');
      while (newlineIndex !== -1) {
        const line = stdoutBuffer.slice(0, newlineIndex).trim();
        stdoutBuffer = stdoutBuffer.slice(newlineIndex + 1);
        newlineIndex = stdoutBuffer.indexOf('\n');
        if (!line) {
          continue;
        }

        let message;
        try {
          message = JSON.parse(line);
        } catch (error) {
          if (logger) {
            logger.warn('Ignoring unreadable Codex app-server JSON line.', {
              error: error && error.message ? error.message : String(error)
            });
          }
          continue;
        }

        if (message && message.id != null && pending.has(message.id)) {
          const request = pending.get(message.id);
          pending.delete(message.id);
          if (message.error) {
            request.reject(
              new Error(
                message.error && message.error.message
                  ? message.error.message
                  : JSON.stringify(message.error)
              )
            );
          } else {
            request.resolve(message.result);
          }
          continue;
        }

        if (message && message.id != null && message.method) {
          child.stdin.write(
            `${JSON.stringify({
              id: message.id,
              error: {
                message: `Unsupported Codex app-server request: ${message.method}`
              }
            })}\n`,
            'utf8'
          );
        }
      }
    });

    child.stderr.on('data', (chunk) => {
      stderrBuffer += chunk.toString('utf8');
      stderrBuffer = truncateLogText(stderrBuffer);
    });

    child.on('error', fail);
    child.on('exit', (code, signal) => {
      if (settled) {
        return;
      }
      fail(
        new Error(
          `Codex app-server exited before completing rate-limit request: code=${code} signal=${signal}`
        )
      );
    });

    (async () => {
      try {
        await sendRequest('initialize', {
          protocolVersion: '2',
          capabilities: {},
          clientInfo: {
            name: 'codex-multitool',
            version: '0.0.0'
          }
        });
        const account = await sendRequest('account/read', { refreshToken: true });
        const rateLimits = await sendRequest('account/rateLimits/read');
        if (logger && stderrBuffer.trim()) {
          logger.debug('Codex app-server wrote diagnostics while reading rate limits.', {
            stderr: stderrBuffer
          });
        }
        settled = true;
        clearTimeout(timeout);
        try {
          child.kill();
        } catch {
          // Ignore process cleanup failures.
        }
        resolve({ account, rateLimits });
      } catch (error) {
        fail(error);
      }
    })();
  });
}

async function getCodexAppServerRateLimitData(authData, logger) {
  if (!authData || !authData.idToken || !authData.accessToken || !authData.refreshToken) {
    return {
      found: false,
      error: 'No complete Codex auth tokens available for app-server rate-limit refresh'
    };
  }

  let isolated;
  try {
    isolated = createIsolatedCodexHome(authData);
    const result = await runCodexAppServerRequests(isolated, logger);
    const data = normalizeAppServerRateLimitPayload(result && result.rateLimits);
    if (!data || (!data.primary && !data.secondary)) {
      return {
        found: false,
        error: 'Codex app-server response did not include rate-limit windows'
      };
    }

    let refreshedAuthData = await loadAuthDataFromFile(isolated.authPath, logger);
    const account = result && result.account && result.account.account;
    if (refreshedAuthData && account && typeof account === 'object') {
      refreshedAuthData = {
        ...refreshedAuthData,
        email: typeof account.email === 'string' && account.email.trim()
          ? account.email.trim()
          : refreshedAuthData.email,
        planType: typeof account.planType === 'string' && account.planType.trim()
          ? account.planType.trim()
          : refreshedAuthData.planType
      };
    }

    if (logger) {
      logger.info('Loaded Codex rate limits from isolated app-server.', {
        source: APP_SERVER_RATE_LIMIT_SOURCE,
        planType: data.planType,
        primaryWindowMinutes: data.primary ? data.primary.windowMinutes : null,
        secondaryWindowMinutes: data.secondary ? data.secondary.windowMinutes : null
      });
    }

    return {
      found: true,
      data,
      refreshedAuthData
    };
  } catch (error) {
    return {
      found: false,
      error: error && error.message ? error.message : String(error)
    };
  } finally {
    if (isolated) {
      try {
        isolated.cleanup();
      } catch (error) {
        if (logger) {
          logger.warn('Failed to clean Codex app-server isolated home.', {
            error: error && error.message ? error.message : String(error)
          });
        }
      }
    }
  }
}

module.exports = {
  APP_SERVER_RATE_LIMIT_SOURCE,
  getCodexAppServerRateLimitData,
  normalizeAppServerRateLimitPayload
};
