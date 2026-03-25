'use strict';

const OSC_SEQUENCE_PATTERN = /\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)/g;
const CSI_SEQUENCE_PATTERN = /\u001b\[[0-9;?]*[ -/]*[@-~]/g;
const SINGLE_ESCAPE_PATTERN = /\u001b[@-_]/g;
const BACKSPACE_PAIR_PATTERN = /[^\n]\u0008/g;
const OTHER_CONTROL_PATTERN = /[\u0000-\u0007\u000b-\u001a\u001c-\u001f\u007f]/g;

function normalizeTerminalText(data) {
  if (!data) {
    return '';
  }

  let text = data
    .replace(OSC_SEQUENCE_PATTERN, '')
    .replace(CSI_SEQUENCE_PATTERN, '')
    .replace(SINGLE_ESCAPE_PATTERN, '')
    .replace(/\r\n/g, '\n')
    .replace(/\r/g, '\n');

  while (BACKSPACE_PAIR_PATTERN.test(text)) {
    text = text.replace(BACKSPACE_PAIR_PATTERN, '');
  }

  return text.replace(/\u0008/g, '').replace(OTHER_CONTROL_PATTERN, '');
}

module.exports = {
  normalizeTerminalText
};
