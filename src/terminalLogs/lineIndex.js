'use strict';

function buildLineStarts(text) {
  const lineStarts = [0];

  for (let index = 0; index < text.length; index += 1) {
    if (text.charCodeAt(index) === 10) {
      lineStarts.push(index + 1);
    }
  }

  return lineStarts;
}

function findLineIndex(lineStarts, offset) {
  let low = 0;
  let high = lineStarts.length - 1;

  while (low <= high) {
    const mid = Math.floor((low + high) / 2);
    const lineStart = lineStarts[mid];
    const nextLineStart = mid + 1 < lineStarts.length ? lineStarts[mid + 1] : Number.MAX_SAFE_INTEGER;

    if (offset < lineStart) {
      high = mid - 1;
      continue;
    }

    if (offset >= nextLineStart) {
      low = mid + 1;
      continue;
    }

    return mid;
  }

  return Math.max(0, lineStarts.length - 1);
}

function offsetToPosition(lineStarts, offset) {
  const safeOffset = Math.max(0, offset);
  const line = findLineIndex(lineStarts, safeOffset);
  return {
    line,
    character: safeOffset - lineStarts[line]
  };
}

function createOffsetRange(lineStarts, startOffset, endOffset) {
  return {
    start: offsetToPosition(lineStarts, startOffset),
    end: offsetToPosition(lineStarts, endOffset)
  };
}

function getLineText(text, lineStarts, lineIndex) {
  const lineStart = lineStarts[lineIndex] ?? 0;
  const nextLineStart = lineIndex + 1 < lineStarts.length ? lineStarts[lineIndex + 1] : text.length;
  return text.slice(lineStart, nextLineStart).replace(/\n$/, '');
}

function buildPreview(text, lineStarts, range, contextLines) {
  const startLine = Math.max(0, range.start.line - contextLines);
  const endLine = Math.min(lineStarts.length - 1, range.end.line + contextLines);
  const previewLines = [];

  for (let lineIndex = startLine; lineIndex <= endLine; lineIndex += 1) {
    const marker =
      lineIndex >= range.start.line && lineIndex <= range.end.line ? '>' : ' ';
    previewLines.push(`${marker} ${String(lineIndex + 1).padStart(4, ' ')} | ${getLineText(text, lineStarts, lineIndex)}`);
  }

  return previewLines.join('\n');
}

module.exports = {
  buildLineStarts,
  buildPreview,
  createOffsetRange,
  offsetToPosition
};
