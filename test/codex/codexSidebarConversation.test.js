'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {
  findLastResumedConversation,
  getFileSize,
  getOfficialCodexLogPath,
  waitForConversationResume
} = require('../../src/codex/CodexSidebarConversation');

test('derives the official Codex log beside the current extension log directory', () => {
  const ownLogDirectory = path.join(
    'C:\\logs',
    'window1',
    'exthost',
    'screph.codex-terminal-recorder'
  );
  assert.equal(
    getOfficialCodexLogPath(ownLogDirectory),
    path.join('C:\\logs', 'window1', 'exthost', 'openai.chatgpt', 'Codex.log')
  );
});

test('uses the last successful resume event in the Codex log', () => {
  const first = '019ed0b4-722c-7180-9d34-8cf7e7c5c455';
  const second = '019ee6a1-07ce-7802-ba53-1d850d27c19e';
  const match = findLastResumedConversation(
    `[info] maybe_resume_success conversationId=${first}\n` +
      `[info] maybe_resume_success conversationId=${second}\n`
  );
  assert.equal(match.conversationId, second);
});

test('verifies a new successful resume appended after the URI handler call', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-sidebar-resume-'));
  const logPath = path.join(directory, 'Codex.log');
  const conversationId = '019ed0b4-722c-7180-9d34-8cf7e7c5c455';
  fs.writeFileSync(logPath, '[info] extension activated\n');
  const startOffset = getFileSize(logPath);

  const appendTimer = setTimeout(() => {
    fs.appendFileSync(
      logPath,
      `[info] maybe_resume_success conversationId=${conversationId} turnCount=1\n`
    );
  }, 10);

  try {
    const result = await waitForConversationResume(logPath, conversationId, {
      startOffset,
      timeoutMs: 250,
      pollIntervalMs: 5
    });
    assert.equal(result.resumed, true);
  } finally {
    clearTimeout(appendTimer);
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test('fails explicitly when Codex logs a resume failure without a later success', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-sidebar-failure-'));
  const logPath = path.join(directory, 'Codex.log');
  const conversationId = '019ed0b4-722c-7180-9d34-8cf7e7c5c455';
  fs.writeFileSync(
    logPath,
    `[error] Failed to resume conversation conversationId=${conversationId} error={}\n`
  );

  try {
    await assert.rejects(
      waitForConversationResume(logPath, conversationId, {
        startOffset: 0,
        timeoutMs: 25,
        pollIntervalMs: 5
      }),
      /logged a thread\/resume failure/
    );
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
