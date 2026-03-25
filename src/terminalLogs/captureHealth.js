'use strict';

function createCaptureHealth(options) {
  const now = new Date().toISOString();
  const terminalWriteApiAvailable = Boolean(options && options.terminalWriteApiAvailable);
  const shellExecutionApiAvailable = Boolean(options && options.shellExecutionApiAvailable);
  const shellIntegrationActive = Boolean(options && options.shellIntegrationActive);

  return {
    createdAt: now,
    terminalWriteApiAvailable,
    shellExecutionApiAvailable,
    shellIntegrationActive,
    shellIntegrationActivatedAt: shellIntegrationActive ? now : null,
    shellExecutionEventCount: 0,
    terminalWriteEventCount: 0,
    chunksCaptured: 0,
    bytesCaptured: 0,
    firstCapturedAt: null,
    lastCapturedAt: null,
    lastCaptureSource: null,
    lastShellExecutionStartedAt: null
  };
}

function markShellIntegrationActive(health) {
  if (!health) {
    return;
  }

  health.shellIntegrationActive = true;
  health.shellIntegrationActivatedAt = health.shellIntegrationActivatedAt || new Date().toISOString();
}

function markShellExecutionStart(health) {
  if (!health) {
    return;
  }

  health.shellExecutionEventCount += 1;
  health.lastShellExecutionStartedAt = new Date().toISOString();
}

function markCapturedChunk(health, source, data) {
  if (!health || !data) {
    return;
  }

  const timestamp = new Date().toISOString();
  const byteLength = Buffer.byteLength(String(data), 'utf8');

  if (source === 'terminalDataWrite') {
    health.terminalWriteEventCount += 1;
  }

  if (!byteLength) {
    return;
  }

  health.chunksCaptured += 1;
  health.bytesCaptured += byteLength;
  health.firstCapturedAt = health.firstCapturedAt || timestamp;
  health.lastCapturedAt = timestamp;
  health.lastCaptureSource = source;
}

function hasCapturedData(health) {
  return Boolean(health && health.bytesCaptured > 0);
}

function describeCaptureHealth(health) {
  if (!health) {
    return 'Terminal capture diagnostics are unavailable.';
  }

  if (hasCapturedData(health)) {
    return (
      `Captured ${formatBytes(health.bytesCaptured)} across ${health.chunksCaptured} chunks` +
      ` via ${formatCaptureSource(health.lastCaptureSource)}.`
    );
  }

  const reasons = [];

  if (!health.terminalWriteApiAvailable) {
    reasons.push('the proposed terminal data stream API is unavailable');
  }

  if (!health.shellExecutionApiAvailable) {
    reasons.push('the shell execution API is unavailable');
  } else if (!health.shellIntegrationActive) {
    reasons.push('shell integration is not active for this terminal');
  }

  if (!reasons.length) {
    reasons.push('no terminal output events have been received yet');
  }

  return (
    `No terminal output has been captured since ${health.createdAt} because ${joinReasons(reasons)}. ` +
    'Existing terminal scrollback is not backfilled.'
  );
}

function formatCaptureHealthForEmptyLog(health) {
  return `${describeCaptureHealth(health)} The generated selection bundle only contains the current selection.`;
}

function formatCaptureSource(value) {
  switch (value) {
    case 'terminalDataWrite':
      return 'terminalDataWrite';
    case 'shellExecution':
      return 'shellExecution';
    case 'commandSnapshot':
      return 'commandSnapshot';
    default:
      return 'an unknown source';
  }
}

function formatBytes(byteLength) {
  if (!Number.isFinite(byteLength) || byteLength <= 0) {
    return '0 B';
  }

  if (byteLength < 1024) {
    return `${byteLength} B`;
  }

  if (byteLength < 1024 * 1024) {
    return `${(byteLength / 1024).toFixed(1).replace(/\.0$/, '')} KB`;
  }

  return `${(byteLength / (1024 * 1024)).toFixed(1).replace(/\.0$/, '')} MB`;
}

function joinReasons(reasons) {
  if (!reasons.length) {
    return 'unknown reasons';
  }

  if (reasons.length === 1) {
    return reasons[0];
  }

  if (reasons.length === 2) {
    return `${reasons[0]} and ${reasons[1]}`;
  }

  return `${reasons.slice(0, -1).join(', ')}, and ${reasons[reasons.length - 1]}`;
}

module.exports = {
  createCaptureHealth,
  describeCaptureHealth,
  formatCaptureHealthForEmptyLog,
  hasCapturedData,
  markCapturedChunk,
  markShellExecutionStart,
  markShellIntegrationActive
};
