'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const vscode = require('vscode');
const { execFileSync } = require('child_process');

function asNonEmptyString(value) {
  if (typeof value !== 'string') {
    return undefined;
  }

  const normalized = value.trim();
  return normalized ? normalized : undefined;
}

function getDefaultOrganization(authPayload) {
  const directId =
    asNonEmptyString(authPayload && authPayload.selected_organization_id) ||
    asNonEmptyString(authPayload && authPayload.default_organization_id);

  const organizations =
    authPayload && Array.isArray(authPayload.organizations) ? authPayload.organizations : [];

  if (directId) {
    const match = organizations.find((organization) => {
      return asNonEmptyString(organization && organization.id) === directId;
    });
    return {
      id: directId,
      title: asNonEmptyString(match && match.title)
    };
  }

  if (organizations.length === 0) {
    return {};
  }

  const selected = organizations.find((organization) => organization && organization.is_default) ||
    organizations[0];
  return {
    id: asNonEmptyString(selected && selected.id),
    title: asNonEmptyString(selected && selected.title)
  };
}

function parseJwt(token, logger) {
  try {
    const parts = String(token || '').split('.');
    if (parts.length !== 3) {
      throw new Error('Invalid JWT');
    }

    const payload = Buffer.from(parts[1], 'base64url').toString();
    return JSON.parse(payload);
  } catch (error) {
    if (logger) {
      logger.warn('Failed to parse Codex JWT payload.', {
        error: error && error.message ? error.message : String(error)
      });
    }
    return null;
  }
}

function getMissingRequiredTokenFields(tokens) {
  return ['id_token', 'access_token', 'refresh_token'].filter((field) => {
    return !asNonEmptyString(tokens && tokens[field]);
  });
}

function getDefaultCodexHomePath() {
  return process.env.CODEX_HOME || path.join(os.homedir(), '.codex');
}

function shouldUseWslAuthPath() {
  if (process.platform !== 'win32') {
    return false;
  }

  return Boolean(
    vscode.workspace
      .getConfiguration('chatgpt')
      .get('runCodexInWindowsSubsystemForLinux', false)
  );
}

function resolveWslDefaultCodexAuthPath(logger) {
  try {
    const output = execFileSync(
      'wsl.exe',
      ['sh', '-lc', 'wslpath -w ~/.codex/auth.json'],
      {
        encoding: 'utf8',
        windowsHide: true
      }
    );
    const resolved = String(output || '').trim();
    return resolved || null;
  } catch (error) {
    if (logger) {
      logger.warn('Failed to resolve the WSL Codex auth.json path.', {
        error: error && error.message ? error.message : String(error)
      });
    }
    return null;
  }
}

function getDefaultCodexAuthPath(logger) {
  const localPath = path.join(getDefaultCodexHomePath(), 'auth.json');
  if (!shouldUseWslAuthPath()) {
    return localPath;
  }

  return resolveWslDefaultCodexAuthPath(logger) || localPath;
}

async function loadAuthDataFromFile(authPath, logger) {
  try {
    if (!fs.existsSync(authPath)) {
      return null;
    }

    const authContent = fs.readFileSync(authPath, 'utf8');
    const authJson = JSON.parse(authContent);
    if (!authJson || typeof authJson !== 'object' || !authJson.tokens) {
      if (logger) {
        logger.warn('Codex auth.json does not contain a tokens object.', { authPath });
      }
      return null;
    }

    const missingTokenFields = getMissingRequiredTokenFields(authJson.tokens);
    if (missingTokenFields.length) {
      if (logger) {
        logger.warn('Codex auth.json is incomplete and cannot be used yet.', {
          authPath,
          missingTokenFields
        });
      }
      return null;
    }

    const idTokenPayload = parseJwt(authJson.tokens.id_token, logger);
    if (!idTokenPayload) {
      if (logger) {
        logger.warn('Codex auth.json contains an unreadable id_token.', { authPath });
      }
      return null;
    }

    const authPayload = idTokenPayload['https://api.openai.com/auth'] || {};
    const defaultOrganization = getDefaultOrganization(authPayload);
    const email = asNonEmptyString(idTokenPayload.email) || 'Unknown';
    const accountId = asNonEmptyString(authJson.tokens.account_id);
    const chatgptUserId = asNonEmptyString(authPayload.chatgpt_user_id);
    const userId = asNonEmptyString(authPayload.user_id);
    const subject = asNonEmptyString(idTokenPayload.sub);

    if (!accountId && !chatgptUserId && !userId && !subject && email === 'Unknown') {
      if (logger) {
        logger.warn('Codex auth.json does not contain a usable account identity.', { authPath });
      }
      return null;
    }

    return {
      idToken: authJson.tokens.id_token,
      accessToken: authJson.tokens.access_token,
      refreshToken: authJson.tokens.refresh_token,
      accountId,
      defaultOrganizationId: defaultOrganization.id,
      defaultOrganizationTitle: defaultOrganization.title,
      chatgptUserId,
      userId,
      subject,
      email,
      planType: authPayload.chatgpt_plan_type || 'Unknown',
      authJson
    };
  } catch (error) {
    if (logger) {
      logger.error('Failed to read Codex auth.json.', {
        authPath,
        error: error && error.message ? error.message : String(error)
      });
    }
    return null;
  }
}

module.exports = {
  getDefaultCodexAuthPath,
  getDefaultCodexHomePath,
  loadAuthDataFromFile,
  shouldUseWslAuthPath
};
