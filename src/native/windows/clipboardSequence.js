'use strict';

let readClipboardSequenceNumber = () => null;

if (process.platform === 'win32') {
  try {
    const koffi = require('./vendor/koffi');
    const user32 = koffi.load('user32.dll');
    const GetClipboardSequenceNumber =
      user32 && user32.func('uint32_t __stdcall GetClipboardSequenceNumber(void)');

    readClipboardSequenceNumber = () =>
      GetClipboardSequenceNumber ? Number(GetClipboardSequenceNumber()) : null;
  } catch {
    readClipboardSequenceNumber = () => null;
  }
}

function getClipboardSequenceNumber() {
  const value = readClipboardSequenceNumber();
  return Number.isFinite(value) && value > 0 ? value : null;
}

module.exports = {
  getClipboardSequenceNumber
};
