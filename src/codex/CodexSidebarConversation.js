'use strict';

const fs = require('fs');
const path = require('path');

const CODEX_EXTENSION_LOG_DIRECTORY = 'openai.chatgpt';
const CODEX_LOG_FILE_NAME = 'Codex.log';
const DEFAULT_LOG_TAIL_BYTES = 4 * 1024 * 1024;
const CODEX_CONVERSATION_ID_PATTERN =
  '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';
const RESUME_SUCCESS_PATTERN = new RegExp(
  `maybe_resume_success\\s+conversationId=(${CODEX_CONVERSATION_ID_PATTERN})`,
  'gi'
);

function getOfficialCodexLogPath(extensionLogDirectory) {
  const ownLogDirectory = String(extensionLogDirectory || '').trim();
  if (!ownLogDirectory) {
    return null;
  }

  return path.join(
    path.dirname(path.resolve(ownLogDirectory)),
    CODEX_EXTENSION_LOG_DIRECTORY,
    CODEX_LOG_FILE_NAME
  );
}

function readLogTail(filePath, maxBytes = DEFAULT_LOG_TAIL_BYTES) {
  const stat = fs.statSync(filePath);
  const bytesToRead = Math.min(stat.size, Math.max(1, Number(maxBytes) || DEFAULT_LOG_TAIL_BYTES));
  const startOffset = Math.max(0, stat.size - bytesToRead);
  const descriptor = fs.openSync(filePath, 'r');

  try {
    const buffer = Buffer.alloc(bytesToRead);
    const bytesRead = fs.readSync(descriptor, buffer, 0, bytesToRead, startOffset);
    return {
      text: buffer.subarray(0, bytesRead).toString('utf8'),
      startOffset,
      size: stat.size
    };
  } finally {
    fs.closeSync(descriptor);
  }
}

function findLastResumedConversation(text) {
  RESUME_SUCCESS_PATTERN.lastIndex = 0;
  let lastMatch = null;
  let match;
  while ((match = RESUME_SUCCESS_PATTERN.exec(String(text || ''))) !== null) {
    lastMatch = {
      conversationId: match[1].toLowerCase(),
      index: match.index
    };
  }
  RESUME_SUCCESS_PATTERN.lastIndex = 0;
  return lastMatch;
}

function captureSidebarConversationFromLog(filePath, logger, options = {}) {
  const normalizedPath = String(filePath || '').trim();
  if (!normalizedPath) {
    return {
      context: null,
      error: 'The official Codex log path is unavailable for this VS Code window.'
    };
  }

  try {
    const tail = readLogTail(normalizedPath, options.maxBytes);
    const resumed = findLastResumedConversation(tail.text);
    if (!resumed) {
      return {
        context: null,
        error: `No successful Codex thread/resume event was found in ${normalizedPath}.`
      };
    }

    const context = {
      kind: 'sidebarConversation',
      source: 'official-codex-log',
      conversationId: resumed.conversationId,
      route: `/local/${resumed.conversationId}`
    };
    if (logger && typeof logger.info === 'function') {
      logger.info('Captured Codex sidebar conversation from the official extension log.', {
        conversationId: context.conversationId,
        source: context.source
      });
    }
    return { context, error: null };
  } catch (error) {
    const message = error && error.message ? error.message : String(error);
    return {
      context: null,
      error: `Failed to read the official Codex log at ${normalizedPath}: ${message}`
    };
  }
}

function getFileSize(filePath) {
  try {
    return fs.statSync(filePath).size;
  } catch {
    return 0;
  }
}

function readLogSince(filePath, startOffset) {
  const stat = fs.statSync(filePath);
  const safeStart = stat.size >= startOffset ? startOffset : 0;
  const bytesToRead = stat.size - safeStart;
  if (bytesToRead <= 0) {
    return '';
  }

  const descriptor = fs.openSync(filePath, 'r');
  try {
    const buffer = Buffer.alloc(bytesToRead);
    const bytesRead = fs.readSync(descriptor, buffer, 0, bytesToRead, safeStart);
    return buffer.subarray(0, bytesRead).toString('utf8');
  } finally {
    fs.closeSync(descriptor);
  }
}

function hasResumeSuccess(text, conversationId) {
  const escapedId = String(conversationId).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`maybe_resume_success\\s+conversationId=${escapedId}(?:\\s|$)`, 'i').test(
    String(text || '')
  );
}

function hasResumeFailure(text, conversationId) {
  const escapedId = String(conversationId).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(
    `(?:Failed to resume conversation|Request failed)\\s+conversationId=${escapedId}(?:\\s|$)`,
    'i'
  ).test(String(text || ''));
}

async function waitForConversationResume(filePath, conversationId, options = {}) {
  const timeoutMs = Math.max(0, Number(options.timeoutMs || 60_000));
  const pollIntervalMs = Math.max(50, Number(options.pollIntervalMs || 250));
  const startOffset = Math.max(0, Number(options.startOffset) || 0);
  const startedAt = Date.now();
  let observedFailure = false;

  while (Date.now() - startedAt <= timeoutMs) {
    try {
      const appended = readLogSince(filePath, startOffset);
      if (hasResumeSuccess(appended, conversationId)) {
        return {
          resumed: true,
          waitedMs: Date.now() - startedAt
        };
      }
      observedFailure = observedFailure || hasResumeFailure(appended, conversationId);
    } catch (error) {
      if (error && error.code !== 'ENOENT') {
        throw error;
      }
    }

    await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
  }

  const failureHint = observedFailure
    ? ' The official Codex extension logged a thread/resume failure.'
    : '';
  throw new Error(
    `Codex did not confirm thread/resume for conversation ${conversationId} within ${timeoutMs}ms.${failureHint}`
  );
}

module.exports = {
  CODEX_CONVERSATION_ID_PATTERN,
  DEFAULT_LOG_TAIL_BYTES,
  captureSidebarConversationFromLog,
  findLastResumedConversation,
  getFileSize,
  getOfficialCodexLogPath,
  hasResumeFailure,
  hasResumeSuccess,
  waitForConversationResume
};
