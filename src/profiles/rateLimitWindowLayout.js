'use strict';

const WEEKLY_WINDOW_MINUTES = 7 * 24 * 60;
const WEEKLY_WINDOW_TOLERANCE_MINUTES = 60;

function isWeeklyWindow(windowState) {
  const windowMinutes = Number(windowState && windowState.windowMinutes);
  return (
    Number.isFinite(windowMinutes) &&
    windowMinutes >= WEEKLY_WINDOW_MINUTES - WEEKLY_WINDOW_TOLERANCE_MINUTES
  );
}

function normalizeRateLimitWindowLayout(primary, secondary) {
  if (primary && !secondary && isWeeklyWindow(primary)) {
    return {
      primary: null,
      secondary: primary
    };
  }

  if (!primary && secondary && isWeeklyWindow(secondary)) {
    return {
      primary: null,
      secondary
    };
  }

  return {
    primary,
    secondary
  };
}

module.exports = {
  normalizeRateLimitWindowLayout
};
