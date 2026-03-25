'use strict';

class SelectionPopupSuppression {
  constructor(logger) {
    this.logger = logger;
    this.suppressedUntil = 0;
    this.reason = '';
  }

  suppress(durationMs, reason) {
    const nextDurationMs = Math.max(0, Number(durationMs) || 0);
    const nextUntil = Date.now() + nextDurationMs;

    if (nextUntil <= this.suppressedUntil) {
      return;
    }

    this.suppressedUntil = nextUntil;
    this.reason = reason || 'unspecified';
    this.logger &&
      this.logger.info('Selection popup temporarily suppressed.', {
        reason: this.reason,
        durationMs: nextDurationMs
      });
  }

  isSuppressed() {
    return Date.now() < this.suppressedUntil;
  }

  getRemainingMs() {
    return Math.max(0, this.suppressedUntil - Date.now());
  }
}

module.exports = {
  SelectionPopupSuppression
};
