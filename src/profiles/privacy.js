'use strict';

const vscode = require('vscode');

function isProfileNameMaskingEnabled() {
  return Boolean(vscode.workspace.getConfiguration('codexSwitch').get('maskProfileNames', false));
}

function isProfileEmailMaskingEnabled() {
  return Boolean(vscode.workspace.getConfiguration('codexSwitch').get('maskProfileEmails', false));
}

function shortProfileId(profile) {
  const id = profile && typeof profile.id === 'string' ? profile.id.replace(/-/g, '') : '';
  return id ? id.slice(0, 6) : 'hidden';
}

function displayProfileName(profileOrName) {
  if (isProfileNameMaskingEnabled()) {
    return typeof profileOrName === 'object'
      ? `Profile ${shortProfileId(profileOrName)}`
      : 'Profile';
  }

  if (typeof profileOrName === 'object') {
    return String((profileOrName && profileOrName.name) || 'profile');
  }

  return String(profileOrName || 'profile');
}

function displayProfileEmail(email) {
  const normalized = String(email || '').trim();
  if (!normalized || normalized === 'Unknown') {
    return normalized || 'Unknown';
  }

  if (isProfileEmailMaskingEnabled()) {
    return 'email hidden';
  }

  return normalized;
}

function displayAccountLabel(authData) {
  if (!authData || !authData.email || authData.email === 'Unknown') {
    return '';
  }

  return ` (${displayProfileEmail(authData.email)})`;
}

module.exports = {
  displayAccountLabel,
  displayProfileEmail,
  displayProfileName,
  isProfileEmailMaskingEnabled,
  isProfileNameMaskingEnabled
};
