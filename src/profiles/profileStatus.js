'use strict';

function normalizeTimestamp(value) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric) || numeric <= 0) {
    return null;
  }
  return Math.round(numeric);
}

function normalizeNumber(value, fallback) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : fallback;
}

const LOW_REMAINING_PERCENT_THRESHOLD = 5;
const FULL_REMAINING_PERCENT_THRESHOLD = 99;
const DEFAULT_PRIMARY_WINDOW_MINUTES = 5 * 60;
const MINUTES_PER_DAY = 24 * 60;
const USAGE_API_SOURCE_PREFIX = 'https://chatgpt.com/backend-api/wham/usage';
const RATE_LIMIT_DISPLAY_FRESHNESS_MS = 60 * 60 * 1000;

function normalizePlanType(planType) {
  const normalized = String(planType || '').trim();
  if (!normalized) {
    return 'Unknown';
  }
  return normalized;
}

function formatPlanType(planType) {
  const normalized = normalizePlanType(planType);
  return normalized === 'Unknown' ? normalized : normalized.toUpperCase();
}

function getPlanSortRank(planType) {
  const normalized = normalizePlanType(planType).toLowerCase();
  if (normalized.includes('enterprise')) {
    return 60;
  }
  if (normalized.includes('team') || normalized.includes('business')) {
    return 50;
  }
  if (normalized.includes('pro')) {
    return 40;
  }
  if (normalized.includes('plus')) {
    return 30;
  }
  if (normalized.includes('go')) {
    return 20;
  }
  if (normalized.includes('free')) {
    return 10;
  }
  return 0;
}

function formatDuration(durationMs) {
  const totalSeconds = Math.max(0, Math.ceil(normalizeNumber(durationMs, 0) / 1000));

  if (totalSeconds < 60) {
    return `${totalSeconds}s`;
  }

  const totalMinutes = Math.ceil(totalSeconds / 60);
  const days = Math.floor(totalMinutes / (24 * 60));
  const hours = Math.floor((totalMinutes % (24 * 60)) / 60);
  const minutes = totalMinutes % 60;
  const parts = [];

  if (days > 0) {
    parts.push(`${days}d`);
  }
  if (hours > 0) {
    parts.push(`${hours}h`);
  }
  if (minutes > 0 && parts.length < 2) {
    parts.push(`${minutes}m`);
  }
  if (parts.length === 0) {
    parts.push('0m');
  }

  return parts.join(' ');
}

function formatWindowMinutes(windowMinutes) {
  const minutes = Math.max(0, Math.round(normalizeNumber(windowMinutes, 0)));
  if (!minutes) {
    return 'custom';
  }

  if (minutes >= MINUTES_PER_DAY) {
    const exactDays = minutes / MINUTES_PER_DAY;
    const roundedDays = Math.round(exactDays);
    if (roundedDays > 0 && Math.abs(minutes - roundedDays * MINUTES_PER_DAY) <= 1) {
      return `${roundedDays}d`;
    }

    if (minutes % MINUTES_PER_DAY === 0) {
      return `${minutes / MINUTES_PER_DAY}d`;
    }
  }

  if (minutes % 60 === 0) {
    return `${minutes / 60}h`;
  }

  if (minutes > 60) {
    const hours = Math.floor(minutes / 60);
    const remainingMinutes = minutes % 60;
    return `${hours}h ${remainingMinutes}m`;
  }

  return `${minutes}m`;
}

function formatCompactWindowMinutes(windowMinutes) {
  const formatted = formatWindowMinutes(windowMinutes);
  return formatted === 'custom' ? null : formatted.replace(/\s+/g, '').toUpperCase();
}

function getWindowLabel(windowState, fallbackLabel) {
  if (!windowState) {
    return fallbackLabel;
  }

  const windowLabel = formatWindowMinutes(windowState.windowMinutes);
  return `${fallbackLabel} (${windowLabel})`;
}

function getActiveLimitState(windowState, now) {
  if (!windowState || typeof windowState !== 'object') {
    return null;
  }

  const resetAt = normalizeTimestamp(windowState.resetAt);
  return {
    usedPercent: Math.max(0, Math.min(100, normalizeNumber(windowState.usedPercent, 0))),
    resetAt,
    active: Boolean(resetAt && resetAt > now),
    windowMinutes: Math.max(0, Math.round(normalizeNumber(windowState.windowMinutes, 0)))
  };
}

function isUsageApiRateLimitState(rateLimitState) {
  return Boolean(
    rateLimitState &&
      typeof rateLimitState.sourceFile === 'string' &&
      rateLimitState.sourceFile.startsWith(USAGE_API_SOURCE_PREFIX)
  );
}

function isFreshUsageApiRateLimitState(rateLimitState, now = Date.now()) {
  if (!isUsageApiRateLimitState(rateLimitState)) {
    return false;
  }

  const observedAt = normalizeTimestamp(rateLimitState.observedAt);
  return Boolean(observedAt && now - observedAt <= RATE_LIMIT_DISPLAY_FRESHNESS_MS);
}

function isActiveProfileForRateDisplay(profile, options = {}) {
  if (options.isActiveProfile === true) {
    return true;
  }

  if (options.isActiveProfile === false) {
    return false;
  }

  return Boolean(
    options.activeProfileId &&
      profile &&
      profile.id &&
      String(options.activeProfileId) === String(profile.id)
  );
}

function getRateLimitSourceType(rateLimitState) {
  if (!rateLimitState || !rateLimitState.sourceFile) {
    return null;
  }

  return isUsageApiRateLimitState(rateLimitState) ? 'usageApi' : 'localSessions';
}

function getDisplayRateLimitState(profile, now = Date.now(), options = {}) {
  const rateLimitState = profile && profile.rateLimitState ? profile.rateLimitState : null;
  if (!rateLimitState) {
    return null;
  }

  if (isActiveProfileForRateDisplay(profile, options)) {
    return isFreshUsageApiRateLimitState(rateLimitState, now) ? rateLimitState : null;
  }

  return rateLimitState;
}

function getProfileRateStatus(profile, now = Date.now(), options = {}) {
  const rateLimitState = getDisplayRateLimitState(profile, now, options);
  const rawPrimary = getActiveLimitState(rateLimitState && rateLimitState.primary, now);
  const secondary = getActiveLimitState(
    rateLimitState && rateLimitState.secondary,
    now
  );
  if (!rateLimitState) {
    return {
      cooldownActive: false,
      cooldownUntil: null,
      compactText: 'n/a',
      quickPickText: '[n/a]',
      tooltipText: 'No fresh Usage API data',
      maxUsedPercent: 0,
      primary: null,
      secondary: null,
      planText: formatPlanType(profile && profile.planType),
      observedAt: null,
      sourceFile: null,
      sourceType: null,
      isEstimatedRateLimitData: false,
      hasFreshUsageApiData: false
    };
  }

  const hasFreshUsageApiData = isFreshUsageApiRateLimitState(rateLimitState, now);
  const primary = applyWeeklyZeroToPrimary(rawPrimary, secondary, now);
  const activeResetTimes = [primary, secondary]
    .filter((windowState) => Boolean(windowState && windowState.active && windowState.resetAt))
    .map((windowState) => windowState.resetAt);
  const storedCooldownUntil = normalizeTimestamp(profile && profile.cooldownUntil);
  const cooldownUntil =
    [storedCooldownUntil].concat(activeResetTimes).filter((value) => Boolean(value && value > now)).sort((a, b) => b - a)[0] ||
    null;
  const cooldownActive = Boolean(cooldownUntil && cooldownUntil > now);
  const maxUsedPercent = Math.max(
    primary && primary.active ? primary.usedPercent : 0,
    secondary && secondary.active ? secondary.usedPercent : 0
  );

  return {
    cooldownActive,
    cooldownUntil,
    compactText: cooldownActive ? `Reset in ${formatDuration(cooldownUntil - now)}` : 'Ready',
    quickPickText: cooldownActive
      ? `[Reset in: ${formatDuration(cooldownUntil - now)}]`
      : '[Ready]',
    tooltipText: cooldownActive ? `Reset in ${formatDuration(cooldownUntil - now)}` : 'Ready',
    maxUsedPercent,
    primary,
    secondary,
    planText: formatPlanType(profile && profile.planType),
    observedAt: normalizeTimestamp(rateLimitState.observedAt),
    sourceFile: rateLimitState.sourceFile || null,
    sourceType: getRateLimitSourceType(rateLimitState),
    isEstimatedRateLimitData: !hasFreshUsageApiData,
    hasFreshUsageApiData
  };
}

function getRawWindowRemainingPercent(windowState, now = Date.now()) {
  if (!windowState) {
    return null;
  }

  if (!windowState.resetAt || windowState.resetAt <= now) {
    return 100;
  }

  return Math.max(0, Math.min(100, 100 - windowState.usedPercent));
}

function roundRemainingPercent(remainingPercent, options = {}) {
  if (remainingPercent == null) {
    return -1;
  }

  const normalized = Math.max(0, Math.min(100, normalizeNumber(remainingPercent, 0)));
  if (options.roundLowRemainingToZero === true && normalized < LOW_REMAINING_PERCENT_THRESHOLD) {
    return 0;
  }

  if (normalized >= FULL_REMAINING_PERCENT_THRESHOLD) {
    return 100;
  }

  return Math.round(normalized);
}

function getWindowRemainingPercent(windowState, now = Date.now(), options = {}) {
  const remainingPercent = getRawWindowRemainingPercent(windowState, now);
  return roundRemainingPercent(remainingPercent, options);
}

function isWindowLowRemaining(windowState, now = Date.now()) {
  const remainingPercent = getRawWindowRemainingPercent(windowState, now);
  return remainingPercent != null && remainingPercent < LOW_REMAINING_PERCENT_THRESHOLD;
}

function isWindowZeroRemaining(windowState, now = Date.now()) {
  const remainingPercent = getRawWindowRemainingPercent(windowState, now);
  return remainingPercent === 0;
}

function applyWeeklyZeroToPrimary(primary, secondary, now = Date.now()) {
  if (!isWindowZeroRemaining(secondary, now)) {
    return primary;
  }

  return {
    usedPercent: 100,
    resetAt: secondary.resetAt,
    active: Boolean(secondary.resetAt && secondary.resetAt > now),
    windowMinutes:
      primary && primary.windowMinutes
        ? primary.windowMinutes
        : DEFAULT_PRIMARY_WINDOW_MINUTES
  };
}

function isProfileWeeklyTokensLow(profile, now = Date.now(), options = {}) {
  const status = getProfileRateStatus(profile, now, options);
  return isWindowLowRemaining(status.secondary, now);
}

function getProfileDisplaySortKey(profile, now = Date.now(), options = {}) {
  const status = getProfileRateStatus(profile, now, options);
  const planType = normalizePlanType(profile && profile.planType);
  const weeklyTokensLow = isWindowLowRemaining(status.secondary, now);

  return {
    primaryRemainingPercent: weeklyTokensLow ? 0 : getWindowRemainingPercent(status.primary, now),
    secondaryRemainingPercent: getWindowRemainingPercent(status.secondary, now),
    planRank: getPlanSortRank(planType),
    planType: planType.toLowerCase(),
    name: String((profile && profile.name) || '').toLowerCase(),
    weeklyTokensLow
  };
}

function compareProfilesForDisplay(left, right, activeProfileId, now = Date.now()) {
  const leftActive = Boolean(activeProfileId && left && left.id === activeProfileId);
  const rightActive = Boolean(activeProfileId && right && right.id === activeProfileId);
  if (leftActive !== rightActive) {
    return leftActive ? -1 : 1;
  }

  const leftKey = getProfileDisplaySortKey(left, now, { activeProfileId });
  const rightKey = getProfileDisplaySortKey(right, now, { activeProfileId });
  const numericSorts = [
    rightKey.primaryRemainingPercent - leftKey.primaryRemainingPercent,
    rightKey.secondaryRemainingPercent - leftKey.secondaryRemainingPercent,
    rightKey.planRank - leftKey.planRank
  ];
  const numericSort = numericSorts.find((value) => value !== 0);
  if (numericSort) {
    return numericSort;
  }

  const planSort = leftKey.planType.localeCompare(rightKey.planType);
  if (planSort !== 0) {
    return planSort;
  }

  return leftKey.name.localeCompare(rightKey.name);
}

function sortProfilesForDisplay(profiles, activeProfileId, now = Date.now()) {
  return [...(profiles || [])].sort((left, right) => {
    return compareProfilesForDisplay(left, right, activeProfileId, now);
  });
}

function formatAbsoluteTimestamp(timestamp) {
  const normalized = normalizeTimestamp(timestamp);
  if (!normalized) {
    return 'n/a';
  }
  return new Date(normalized).toLocaleString();
}

function formatResetText(timestamp, now = Date.now()) {
  const normalized = normalizeTimestamp(timestamp);
  if (!normalized || normalized <= now) {
    return 'Ready';
  }
  return `Reset in ${formatDuration(normalized - now)}`;
}

function formatWindowCountdown(windowState, now = Date.now()) {
  if (!windowState) {
    return 'n/a';
  }

  if (!windowState.resetAt || windowState.resetAt <= now) {
    return 'Ready';
  }

  return formatDuration(windowState.resetAt - now);
}

function isFreePlanStatus(status) {
  return normalizePlanType(status && status.planText).toLowerCase().includes('free');
}

function getWindowMinutesUntilReset(windowState, now) {
  const resetAt = normalizeTimestamp(windowState && windowState.resetAt);
  if (!resetAt || resetAt <= now) {
    return 0;
  }

  return Math.ceil((resetAt - now) / (60 * 1000));
}

function getCompactPrimaryWindowLabel(status, now = Date.now()) {
  const primary = status && status.primary;
  const windowMinutes = Math.max(0, Math.round(normalizeNumber(primary && primary.windowMinutes, 0)));

  if (isFreePlanStatus(status)) {
    const resetWindowMinutes = getWindowMinutesUntilReset(primary, now);
    if (resetWindowMinutes > DEFAULT_PRIMARY_WINDOW_MINUTES) {
      return formatCompactWindowMinutes(resetWindowMinutes) || '5H';
    }
  }

  if (windowMinutes > 0) {
    return formatCompactWindowMinutes(windowMinutes) || '5H';
  }

  return '5H';
}

function shouldHideMissingSecondaryWindow(status, now = Date.now()) {
  if (status && status.secondary) {
    return false;
  }

  return isFreePlanStatus(status) && getWindowMinutesUntilReset(status && status.primary, now) > DEFAULT_PRIMARY_WINDOW_MINUTES;
}

function formatCompactWindow(windowState, label, now = Date.now(), options = {}) {
  const includeCountdown = options.includeCountdown !== false;
  const percentageMode = options.percentageMode === 'remaining' ? 'remaining' : 'used';
  if (!windowState) {
    return `${label} n/a`;
  }

  const isReady = !windowState.resetAt || windowState.resetAt <= now;
  const percentValue =
    percentageMode === 'remaining'
      ? getWindowRemainingPercent(windowState, now, {
          roundLowRemainingToZero: options.roundLowRemainingToZero === true
        })
      : isReady
        ? 0
        : Math.round(windowState.usedPercent);
  const percentText = `${percentValue}%`;
  if (!includeCountdown || isReady) {
    return `${label} ${percentText}`;
  }

  return `${label} ${percentText} ${formatWindowCountdown(windowState, now)}`;
}

function formatCompactRateSummary(status, now = Date.now(), options = {}) {
  const primaryText = formatCompactWindow(status.primary, getCompactPrimaryWindowLabel(status, now), now, {
    includeCountdown: options.includePrimaryCountdown !== false,
    percentageMode: options.percentageMode
  });
  if (shouldHideMissingSecondaryWindow(status, now)) {
    return primaryText;
  }

  const secondaryText = formatCompactWindow(status.secondary, 'W', now, {
    includeCountdown: options.includeSecondaryCountdown !== false,
    percentageMode: options.percentageMode,
    roundLowRemainingToZero: options.roundLowWeeklyRemainingToZero === true
  });

  return `${primaryText} | ${secondaryText}`;
}

module.exports = {
  compareProfilesForDisplay,
  formatAbsoluteTimestamp,
  formatCompactRateSummary,
  formatCompactWindow,
  formatDuration,
  formatPlanType,
  formatResetText,
  formatWindowCountdown,
  formatWindowMinutes,
  getDisplayRateLimitState,
  getProfileDisplaySortKey,
  getProfileRateStatus,
  getWindowLabel,
  getWindowRemainingPercent,
  isFreshUsageApiRateLimitState,
  isUsageApiRateLimitState,
  isProfileWeeklyTokensLow,
  normalizeTimestamp,
  sortProfilesForDisplay
};
