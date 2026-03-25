'use strict';

function trimToMaxBytes(value, maxBytes) {
  if (!value || maxBytes <= 0) {
    return '';
  }

  if (Buffer.byteLength(value, 'utf8') <= maxBytes) {
    return value;
  }

  let low = 0;
  let high = value.length;

  while (low < high) {
    const mid = Math.floor((low + high) / 2);
    const size = Buffer.byteLength(value.slice(mid), 'utf8');

    if (size > maxBytes) {
      low = mid + 1;
    } else {
      high = mid;
    }
  }

  return value.slice(low);
}

function formatMegabytes(maxBytes) {
  return (maxBytes / (1024 * 1024)).toFixed(1).replace(/\.0$/, '');
}

module.exports = {
  trimToMaxBytes,
  formatMegabytes
};
