import express from 'express';
import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const rootDir = path.resolve('.');

async function loadDotEnvFile(file) {
  try {
    const content = await fs.readFile(file, 'utf8');
    for (const rawLine of content.split(/\r?\n/)) {
      const line = rawLine.trim();
      if (!line || line.startsWith('#')) continue;
      const index = line.indexOf('=');
      if (index === -1) continue;
      const key = line.slice(0, index).trim();
      if (!key || Object.prototype.hasOwnProperty.call(process.env, key)) continue;
      let value = line.slice(index + 1).trim();
      if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) value = value.slice(1, -1);
      process.env[key] = value;
    }
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
}

const envFile = process.env.QBACKUP_ENV_FILE ? path.resolve(process.env.QBACKUP_ENV_FILE) : path.join(rootDir, '.env');
await loadDotEnvFile(envFile);

const {
  authMeta,
  countUsers,
  createSession,
  createUser,
  deleteSession,
  deleteUser,
  getUserBySession,
  getUserByUsername,
  listAudit,
  listUsers,
  logAudit,
  permissionsForRole,
  toPublicUser,
  updateUser,
  verifyPassword
} = await import('./auth-store.js');

const app = express();
const port = Number(process.env.PORT || 8787);
const secureCookies = ['true', '1', 'yes'].includes(String(process.env.QBACKUP_SECURE_COOKIES || '').toLowerCase());
const cookieSameSite = process.env.QBACKUP_COOKIE_SAMESITE || 'strict';
const csrfCookieName = 'qbackup_csrf';
const distDir = path.join(rootDir, 'dist');
const configDir = path.join(process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config'), 'qbackup');
const configFile = path.join(configDir, 'config.env');
const clustersFile = path.join(configDir, 'clusters.json');
const kubeconfigDir = path.join(configDir, 'kubeconfigs');
const legacyConfigFile = path.join(process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config'), 'k3s-pvc-backup-ui', 'config.env');
const appLabelName = 'app.kubernetes.io/name';
const appLabelComponent = 'app.kubernetes.io/component';
const appLabelValue = 'qbackup';
const schedulePlacementRefreshMs = 60 * 1000;
const scheduleStaggerMinutes = 10;
const scheduleStartingDeadlineSeconds = 15 * 60;
const backupJobActiveDeadlineSeconds = 2 * 60 * 60;
const backupJobTtlSecondsAfterFinished = 24 * 60 * 60;
const autoHealIntervalMs = Number.parseInt(process.env.AUTO_HEAL_INTERVAL_MS || '30000', 10);
const jobRetentionMs = 60 * 60 * 1000;
const maxRetainedJobs = 100;
const maxJobOutputEntries = 2000;
const autoHealExhaustedRetentionMs = 6 * 60 * 60 * 1000;
const stateSweepIntervalMs = 60 * 1000;
const downloadHelperLifetimeSeconds = 60 * 60;
const autoHealRetryAnnotation = 'qbackup.io/autoheal-retries';
const autoHealParentAnnotation = 'qbackup.io/autoheal-parent';
const autoHealOriginalNameAnnotation = 'qbackup.io/autoheal-original-name';
const jobs = new Map();
const rateBuckets = new Map();
const backupSlots = { limit: 0, active: 0, queue: [] };
const metricsState = {
  startedAt: Date.now(),
  httpRequests: new Map(),
  httpDurations: new Map(),
  autoHeal: {
    running: false,
    enabled: false,
    maxRetries: 0,
    runs: 0,
    actions: new Map(),
    exhausted: new Map(),
    exhaustedResources: new Map(),
    lastRunAt: null,
    lastSuccess: false,
    lastError: ''
  },
  cluster: {
    lastScrapeAt: null,
    lastSuccess: false,
    lastError: '',
    pods: [],
    jobs: [],
    schedules: []
  }
};
const httpDurationBuckets = [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10];

function envString(key, fallback) {
  return process.env[key] ?? fallback;
}

function envBool(key, fallback) {
  if (process.env[key] === undefined) return fallback;
  return boolFromEnv(process.env[key]);
}

function parseJson(content) {
  return JSON.parse(String(content || '').replace(/^\uFEFF/, ''));
}

const defaults = {
  activeClusterId: envString('ACTIVE_CLUSTER_ID', ''),
  kubeconfigPath: envString('KUBECONFIG_PATH', ''),
  kubectlContext: envString('KUBECTL_CONTEXT', ''),
  clusterName: envString('CLUSTER_NAME', ''),
  nfsServer: envString('NFS_SERVER', ''),
  nfsExportPath: envString('NFS_EXPORT_PATH', ''),
  backupRoot: envString('BACKUP_ROOT', 'pvc-backups'),
  helperImage: envString('HELPER_IMAGE', 'alpine:3.20'),
  defaultSchedule: envString('DEFAULT_SCHEDULE', '0 2 * * *'),
  backupConcurrency: normalizeBackupConcurrency(envString('BACKUP_CONCURRENCY', '3')),
  retentionDays: envString('RETENTION_DAYS', '14'),
  keepFailedPods: envBool('KEEP_FAILED_PODS', false),
  scaleConsumers: envBool('SCALE_CONSUMERS_FOR_BACKUP', true),
  archiveExtension: envString('ARCHIVE_EXTENSION', 'tgz'),
  localNfsPreflight: envString('LOCAL_NFS_PREFLIGHT', 'mount'),
  liveFileExplorerEnabled: envBool('LIVE_FILE_EXPLORER_ENABLED', false),
  autoHealEnabled: envBool('AUTO_HEAL_ENABLED', false),
  autoHealRetries: normalizeAutoHealRetries(envString('AUTO_HEAL_RETRIES', '2'))
};

if (['true', '1', 'yes'].includes(String(process.env.QBACKUP_TRUST_PROXY || '').toLowerCase())) {
  app.set('trust proxy', 1);
}

app.disable('x-powered-by');
app.use(express.json({ limit: '2mb' }));

app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
  res.setHeader('Content-Security-Policy', [
    "default-src 'self'",
    "script-src 'self'",
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data:",
    "font-src 'self' data:",
    "connect-src 'self'",
    "object-src 'none'",
    "base-uri 'self'",
    "frame-ancestors 'none'"
  ].join('; '));
  next();
});

function parseCookies(req) {
  return Object.fromEntries(
    String(req.headers.cookie || '')
      .split(';')
      .map((part) => part.trim())
      .filter(Boolean)
      .map((part) => {
        const index = part.indexOf('=');
        return index === -1 ? [part, ''] : [part.slice(0, index), decodeURIComponent(part.slice(index + 1))];
      })
  );
}

function requestIsSecure(req) {
  return secureCookies || req.secure || req.headers['x-forwarded-proto'] === 'https';
}

function setSessionCookie(req, res, token) {
  res.cookie('qbackup_session', token, {
    httpOnly: true,
    secure: requestIsSecure(req),
    sameSite: cookieSameSite,
    path: '/',
    maxAge: 7 * 24 * 60 * 60 * 1000
  });
}

function clearSessionCookie(req, res) {
  res.cookie('qbackup_session', '', {
    httpOnly: true,
    secure: requestIsSecure(req),
    sameSite: cookieSameSite,
    path: '/',
    maxAge: 0
  });
}

function ensureCsrfCookie(req, res) {
  const cookies = parseCookies(req);
  let token = cookies[csrfCookieName];
  if (!token || !/^[a-f0-9]{64}$/.test(token)) token = crypto.randomBytes(32).toString('hex');
  res.cookie(csrfCookieName, token, {
    httpOnly: false,
    secure: requestIsSecure(req),
    sameSite: cookieSameSite,
    path: '/',
    maxAge: 7 * 24 * 60 * 60 * 1000
  });
  return token;
}

function csrfProtection(req, res, next) {
  const token = ensureCsrfCookie(req, res);
  if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return next();
  const header = req.headers['x-csrf-token'];
  if (!header || header !== token) return res.status(403).json({ error: 'Invalid CSRF token.' });
  next();
}

function rateLimit({ windowMs, max, keyPrefix }) {
  return (req, res, next) => {
    const now = Date.now();
    const key = `${keyPrefix}:${req.ip}:${req.path}`;
    const bucket = rateBuckets.get(key) || { count: 0, resetAt: now + windowMs };
    if (bucket.resetAt <= now) {
      bucket.count = 0;
      bucket.resetAt = now + windowMs;
    }
    bucket.count += 1;
    rateBuckets.set(key, bucket);
    if (bucket.count > max) {
      res.setHeader('Retry-After', String(Math.ceil((bucket.resetAt - now) / 1000)));
      return res.status(429).json({ error: 'Too many requests. Try again shortly.' });
    }
    next();
  };
}

function incrementMetric(map, labels, amount = 1) {
  const key = JSON.stringify(labels);
  map.set(key, (map.get(key) || 0) + amount);
}

function jobEndedAt(job) {
  return Date.parse(job.finishedAt || job.startedAt) || 0;
}

// The process is long-lived (a container that is rarely restarted), so every
// in-memory collection needs an upper bound.
function sweepEphemeralState() {
  const now = Date.now();
  for (const [id, job] of jobs) {
    if (job.status === 'running') continue;
    if (now - jobEndedAt(job) > jobRetentionMs) jobs.delete(id);
  }
  const overflow = jobs.size - maxRetainedJobs;
  if (overflow > 0) {
    const finished = [...jobs.entries()]
      .filter(([, job]) => job.status !== 'running')
      .sort((a, b) => jobEndedAt(a[1]) - jobEndedAt(b[1]));
    for (const [id] of finished.slice(0, overflow)) jobs.delete(id);
  }
  for (const [key, bucket] of rateBuckets) {
    if (bucket.resetAt <= now) rateBuckets.delete(key);
  }
  for (const [key, seenAt] of metricsState.autoHeal.exhaustedResources) {
    if (now - seenAt > autoHealExhaustedRetentionMs) metricsState.autoHeal.exhaustedResources.delete(key);
  }
}

// Every label here must come from this fixed set. Echoing req.path back would
// let any unmatched URL mint a new metric series (and 13 histogram series).
const staticRouteLabels = new Set([
  '/', '/metrics', '/api/status', '/api/metrics', '/api/healthz', '/api/readyz',
  '/api/auth/bootstrap', '/api/auth/login', '/api/auth/logout', '/api/auth/me', '/api/auth/profile',
  '/api/users', '/api/audit', '/api/config', '/api/clusters', '/api/pvcs', '/api/schedules',
  '/api/backups', '/api/restore', '/api/file-restore/catalog', '/api/file-restore/download',
  '/api/live-files/list', '/api/live-files/read', '/api/live-files/write', '/api/live-files/create-file',
  '/api/live-files/create-folder', '/api/live-files/rename', '/api/live-files/delete', '/api/live-files/download'
]);

function routeLabel(req) {
  const value = req.path || '/';
  if (staticRouteLabels.has(value)) return value;
  if (value.startsWith('/api/jobs/')) return '/api/jobs/:id';
  if (value.startsWith('/events/jobs/')) return '/events/jobs/:id';
  if (value.startsWith('/api/archives/')) return '/api/archives/:namespace/:pvc';
  if (/^\/api\/schedules\/[^/]+\/[^/]+\/run$/.test(value)) return '/api/schedules/:namespace/:name/run';
  if (/^\/api\/schedules\/[^/]+\/[^/]+$/.test(value)) return '/api/schedules/:namespace/:name';
  if (/^\/api\/clusters\/[^/]+\/switch$/.test(value)) return '/api/clusters/:id/switch';
  if (/^\/api\/clusters\/[^/]+$/.test(value)) return '/api/clusters/:id';
  if (/^\/api\/users\/[^/]+$/.test(value)) return '/api/users/:id';
  return '/other';
}

function observeHttpRequest(req, res, seconds) {
  const labels = { method: req.method, route: routeLabel(req), status: String(res.statusCode) };
  incrementMetric(metricsState.httpRequests, labels);
  for (const le of httpDurationBuckets) {
    if (seconds <= le) incrementMetric(metricsState.httpDurations, { ...labels, le: String(le) });
  }
  incrementMetric(metricsState.httpDurations, { ...labels, le: '+Inf' });
  incrementMetric(metricsState.httpDurations, { ...labels, le: '_sum' }, seconds);
}

function metricsMiddleware(req, res, next) {
  const started = process.hrtime.bigint();
  res.on('finish', () => {
    const seconds = Number(process.hrtime.bigint() - started) / 1e9;
    observeHttpRequest(req, res, seconds);
  });
  next();
}

async function attachUser(req, _res, next) {
  try {
    const cookies = parseCookies(req);
    const token = cookies.qbackup_session || cookies.k3s_backup_session;
    req.sessionToken = token || null;
    req.user = token ? await getUserBySession(token) : null;
    next();
  } catch (error) {
    next(error);
  }
}

function hasPermission(user, permission) {
  if (!user) return false;
  return permissionsForRole(user.role).includes(permission);
}

function requireAuth(permission = 'dashboard.read') {
  return (req, res, next) => {
    if (!req.user || !hasPermission(req.user, permission)) {
      return res.status(401).json({ error: 'Unauthorized' });
    }
    next();
  };
}

app.use(attachUser);
app.use(metricsMiddleware);
app.use(csrfProtection);

function envKeyToSetting(key) {
  return {
    ACTIVE_CLUSTER_ID: 'activeClusterId',
    KUBECONFIG_PATH: 'kubeconfigPath',
    KUBECTL_CONTEXT: 'kubectlContext',
    CLUSTER_NAME: 'clusterName',
    NFS_SERVER: 'nfsServer',
    NFS_EXPORT_PATH: 'nfsExportPath',
    BACKUP_ROOT: 'backupRoot',
    HELPER_IMAGE: 'helperImage',
    DEFAULT_SCHEDULE: 'defaultSchedule',
    BACKUP_CONCURRENCY: 'backupConcurrency',
    RETENTION_DAYS: 'retentionDays',
    KEEP_FAILED_PODS: 'keepFailedPods',
    SCALE_CONSUMERS_FOR_BACKUP: 'scaleConsumers',
    ARCHIVE_EXTENSION: 'archiveExtension',
    LOCAL_NFS_PREFLIGHT: 'localNfsPreflight',
    LIVE_FILE_EXPLORER_ENABLED: 'liveFileExplorerEnabled',
    AUTO_HEAL_ENABLED: 'autoHealEnabled',
    AUTO_HEAL_RETRIES: 'autoHealRetries'
  }[key];
}

function boolFromEnv(value) {
  return String(value).toLowerCase() === 'true';
}

function normalizeBackupConcurrency(value) {
  const parsed = Number.parseInt(String(value ?? '3'), 10);
  return String(Number.isFinite(parsed) ? Math.min(Math.max(parsed, 1), 20) : 3);
}

function normalizeAutoHealRetries(value) {
  const parsed = Number.parseInt(String(value ?? '2'), 10);
  return String(Number.isFinite(parsed) ? Math.min(Math.max(parsed, 0), 10) : 2);
}

function drainBackupSlots() {
  while (backupSlots.queue.length > 0 && backupSlots.active < backupSlots.limit) {
    backupSlots.active += 1;
    backupSlots.queue.shift()();
  }
}

// Process-wide cap on concurrent on-demand backup helper Pods, so overlapping
// requests share one budget instead of each getting its own worker pool.
async function acquireBackupSlot(limit) {
  backupSlots.limit = limit;
  let released = false;
  const release = () => {
    if (released) return;
    released = true;
    backupSlots.active -= 1;
    drainBackupSlots();
  };
  if (backupSlots.active < backupSlots.limit) {
    backupSlots.active += 1;
    return release;
  }
  await new Promise((resolve) => backupSlots.queue.push(resolve));
  return release;
}

function assertClusterConfig(config) {
  const required = [
    ['clusterName', 'Cluster name'],
    ['nfsServer', 'NFS server'],
    ['nfsExportPath', 'NFS export path'],
    ['backupRoot', 'Backup root'],
    ['helperImage', 'Helper image'],
    ['defaultSchedule', 'Default schedule'],
    ['archiveExtension', 'Archive extension']
  ];
  for (const [key, label] of required) {
    if (!String(config[key] || '').trim()) {
      const error = new Error(`${label} is required.`);
      error.status = 400;
      throw error;
    }
  }
  if (!/^[A-Za-z0-9._-]+$/.test(config.archiveExtension)) {
    const error = new Error('Archive extension may only contain letters, numbers, dots, underscores, and hyphens.');
    error.status = 400;
    throw error;
  }
  if (!['mount', 'skip'].includes(config.localNfsPreflight)) {
    const error = new Error('Local NFS preflight must be mount or skip.');
    error.status = 400;
    throw error;
  }
  if (!/^\d+$/.test(String(config.autoHealRetries || ''))) {
    const error = new Error('Auto-heal retries must be a whole number between 0 and 10.');
    error.status = 400;
    throw error;
  }
  if (!/^\d+$/.test(String(config.retentionDays || ''))) {
    const error = new Error('Retention days must be a whole number. Use 0 to disable cleanup.');
    error.status = 400;
    throw error;
  }
}

function shellQuote(value) {
  return `'${String(value).replaceAll("'", "'\\''")}'`;
}

function safeFileName(value) {
  return String(value || 'cluster').toLowerCase().replace(/[^a-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 64) || 'cluster';
}

function looksLikeKubeconfig(value) {
  const text = String(value || '').trim();
  return text.includes('apiVersion:') && text.includes('clusters:') && text.includes('users:');
}

function extractKubeconfigContext(value) {
  const match = String(value || '').match(/(?:^|\s)current-context:\s*["']?([^"'\s]+)/);
  return match?.[1] || '';
}

function assertContextIsName(value) {
  if (!looksLikeKubeconfig(value)) return;
  const error = new Error('Kubectl Context must be a context name, not kubeconfig YAML. Paste kubeconfig YAML into the Kubeconfig YAML field, or leave context blank to use the current context.');
  error.status = 400;
  throw error;
}

function clusterIdFromConfig(config) {
  const base = String(config.clusterName || config.kubectlContext || 'cluster').toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '') || 'cluster';
  return base.slice(0, 48);
}

function normalizeCluster(input = {}, fallback = defaults) {
  const config = { ...fallback, ...input };
  config.backupConcurrency = normalizeBackupConcurrency(config.backupConcurrency);
  config.keepFailedPods = Boolean(config.keepFailedPods);
  config.scaleConsumers = input.scaleConsumers === undefined ? Boolean(config.scaleConsumers) : Boolean(input.scaleConsumers);
  config.liveFileExplorerEnabled = input.liveFileExplorerEnabled === undefined ? Boolean(config.liveFileExplorerEnabled) : Boolean(input.liveFileExplorerEnabled);
  config.autoHealEnabled = input.autoHealEnabled === undefined ? Boolean(config.autoHealEnabled) : Boolean(input.autoHealEnabled);
  config.autoHealRetries = normalizeAutoHealRetries(config.autoHealRetries);
  config.localNfsPreflight = config.localNfsPreflight || 'mount';
  config.id = String(input.id || input.clusterId || clusterIdFromConfig(config));
  if (input.kubeconfigContent) config.kubeconfigContent = String(input.kubeconfigContent);
  delete config.clusters;
  delete config.clusterId;
  delete config.activeClusterId;
  return config;
}

function clusterSummary(cluster) {
  return {
    id: cluster.id,
    clusterName: cluster.clusterName,
    kubectlContext: cluster.kubectlContext,
    hasKubeconfig: Boolean(cluster.kubeconfigPath),
    nfsServer: cluster.nfsServer,
    nfsExportPath: cluster.nfsExportPath,
    backupRoot: cluster.backupRoot
  };
}

async function readEnvConfig() {
  const config = { ...defaults };
  let found = false;
  try {
    let content;
    try {
      content = await fs.readFile(configFile, 'utf8');
      found = true;
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
      content = await fs.readFile(legacyConfigFile, 'utf8');
      found = true;
    }
    for (const line of content.split(/\r?\n/)) {
      const match = line.match(/^([A-Z0-9_]+)=(.*)$/);
      if (!match) continue;
      const setting = envKeyToSetting(match[1]);
      if (!setting) continue;
      let value = match[2].trim();
      if (value.startsWith("'") && value.endsWith("'")) value = value.slice(1, -1).replaceAll("'\\''", "'");
      if (setting === 'activeClusterId') config[setting] = value;
      else if (setting === 'keepFailedPods' || setting === 'scaleConsumers' || setting === 'liveFileExplorerEnabled' || setting === 'autoHealEnabled') config[setting] = boolFromEnv(value);
      else if (setting === 'backupConcurrency') config[setting] = normalizeBackupConcurrency(value);
      else if (setting === 'autoHealRetries') config[setting] = normalizeAutoHealRetries(value);
      else config[setting] = value;
    }
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  return { config, found };
}

async function writeEnvConfig(input) {
  const config = normalizeCluster(input);
  config.backupConcurrency = normalizeBackupConcurrency(config.backupConcurrency);
  await fs.mkdir(configDir, { recursive: true });
  const lines = [
    ['ACTIVE_CLUSTER_ID', config.id],
    ['KUBECONFIG_PATH', config.kubeconfigPath || ''],
    ['KUBECTL_CONTEXT', config.kubectlContext],
    ['CLUSTER_NAME', config.clusterName],
    ['NFS_SERVER', config.nfsServer],
    ['NFS_EXPORT_PATH', config.nfsExportPath],
    ['BACKUP_ROOT', config.backupRoot],
    ['HELPER_IMAGE', config.helperImage],
    ['DEFAULT_SCHEDULE', config.defaultSchedule],
    ['BACKUP_CONCURRENCY', normalizeBackupConcurrency(config.backupConcurrency)],
    ['RETENTION_DAYS', config.retentionDays],
    ['KEEP_FAILED_PODS', config.keepFailedPods ? 'true' : 'false'],
    ['ARCHIVE_EXTENSION', config.archiveExtension],
    ['LOCAL_NFS_PREFLIGHT', config.localNfsPreflight || 'mount'],
    ['LIVE_FILE_EXPLORER_ENABLED', config.liveFileExplorerEnabled ? 'true' : 'false'],
    ['AUTO_HEAL_ENABLED', config.autoHealEnabled ? 'true' : 'false'],
    ['AUTO_HEAL_RETRIES', normalizeAutoHealRetries(config.autoHealRetries)],
    ['SCALE_CONSUMERS_FOR_BACKUP', config.scaleConsumers ? 'true' : 'false']
  ].map(([key, value]) => `${key}=${shellQuote(value ?? '')}`);
  const tempFile = `${configFile}.${process.pid}.${Date.now()}.tmp`;
  await fs.writeFile(tempFile, `${lines.join('\n')}\n`, { mode: 0o600 });
  await fs.rename(tempFile, configFile);
  await fs.chmod(configFile, 0o600).catch(() => null);
  return config;
}

async function prepareCluster(input, existing = {}) {
  const cluster = normalizeCluster({ ...existing, ...input, kubeconfigPath: input.kubeconfigPath ?? existing.kubeconfigPath });
  assertContextIsName(cluster.kubectlContext);

  if (cluster.kubeconfigContent) {
    if (!looksLikeKubeconfig(cluster.kubeconfigContent)) {
      const error = new Error('Kubeconfig YAML does not look valid. Paste the full kubeconfig, including apiVersion, clusters, contexts, and users.');
      error.status = 400;
      throw error;
    }
    const file = path.join(kubeconfigDir, `${safeFileName(cluster.id)}.yaml`);
    await fs.mkdir(kubeconfigDir, { recursive: true });
    await fs.writeFile(file, cluster.kubeconfigContent.trimEnd() + '\n', { mode: 0o600 });
    await fs.chmod(file, 0o600).catch(() => null);
    cluster.kubeconfigPath = file;
    if (!String(cluster.kubectlContext || '').trim()) cluster.kubectlContext = extractKubeconfigContext(cluster.kubeconfigContent);
  }

  delete cluster.kubeconfigContent;
  assertClusterConfig(cluster);
  return cluster;
}

async function readClusterStore() {
  try {
    const parsed = parseJson(await fs.readFile(clustersFile, 'utf8'));
    const clusters = Array.isArray(parsed.clusters) ? parsed.clusters.map((item) => normalizeCluster(item)) : [];
    if (clusters.length > 0) {
      const activeClusterId = clusters.some((cluster) => cluster.id === parsed.activeClusterId) ? parsed.activeClusterId : clusters[0].id;
      return { activeClusterId, clusters };
    }
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  const { config: envConfig, found } = await readEnvConfig();
  if (found || boolFromEnv(process.env.QBACKUP_BOOTSTRAP_CLUSTER)) {
    const legacy = normalizeCluster({ ...envConfig, id: envConfig.activeClusterId || envConfig.id });
    return { activeClusterId: legacy.id, clusters: [legacy] };
  }
  return { activeClusterId: '', clusters: [] };
}

async function writeClusterStore(store) {
  const clusters = store.clusters.map((cluster) => normalizeCluster(cluster));
  const activeClusterId = clusters.some((cluster) => cluster.id === store.activeClusterId) ? store.activeClusterId : clusters[0]?.id;
  await fs.mkdir(configDir, { recursive: true });
  const tempFile = `${clustersFile}.${process.pid}.${Date.now()}.tmp`;
  await fs.writeFile(tempFile, `${JSON.stringify({ activeClusterId, clusters }, null, 2)}\n`, { mode: 0o600 });
  await fs.rename(tempFile, clustersFile);
  await fs.chmod(clustersFile, 0o600).catch(() => null);
  const active = clusters.find((cluster) => cluster.id === activeClusterId) || clusters[0];
  if (active) await writeEnvConfig(active);
  return { activeClusterId, clusters };
}

async function readConfig() {
  const store = await readClusterStore();
  const active = store.clusters.find((cluster) => cluster.id === store.activeClusterId) || store.clusters[0];
  if (!active) {
    return {
      ...defaults,
      id: '',
      clusterId: '',
      activeClusterId: '',
      clusters: []
    };
  }
  return {
    ...active,
    clusterId: active.id,
    activeClusterId: active.id,
    clusters: store.clusters.map(clusterSummary)
  };
}

async function writeConfig(input) {
  const store = await readClusterStore();
  const activeIndex = store.clusters.findIndex((cluster) => cluster.id === store.activeClusterId);
  if (activeIndex === -1) {
    const error = new Error('Create a cluster before saving cluster settings.');
    error.status = 400;
    throw error;
  }
  const current = store.clusters[activeIndex];
  const updated = await prepareCluster({ ...input, id: current.id }, current);
  store.clusters[activeIndex] = updated;
  await writeClusterStore({ ...store, activeClusterId: updated.id });
  return readConfig();
}

async function addCluster(input) {
  const store = await readClusterStore();
  const candidate = normalizeCluster(input);
  assertContextIsName(candidate.kubectlContext);
  let id = candidate.id;
  let suffix = 2;
  while (store.clusters.some((item) => item.id === id)) id = `${candidate.id}-${suffix++}`;
  const cluster = await prepareCluster({ ...input, id });
  store.clusters.push(cluster);
  await writeClusterStore({ activeClusterId: cluster.id, clusters: store.clusters });
  return readConfig();
}

async function updateCluster(id, input) {
  const store = await readClusterStore();
  const index = store.clusters.findIndex((cluster) => cluster.id === id);
  if (index === -1) {
    const error = new Error('Cluster not found.');
    error.status = 404;
    throw error;
  }
  store.clusters[index] = await prepareCluster({ ...input, id }, store.clusters[index]);
  await writeClusterStore(store);
  return readConfig();
}

function isManagedKubeconfigPath(value) {
  if (!value) return false;
  const resolved = path.resolve(value);
  return resolved.startsWith(path.resolve(kubeconfigDir) + path.sep);
}

async function deleteCluster(id) {
  const store = await readClusterStore();
  const removed = store.clusters.find((cluster) => cluster.id === id);
  const clusters = store.clusters.filter((cluster) => cluster.id !== id);
  if (clusters.length === store.clusters.length) {
    const error = new Error('Cluster not found.');
    error.status = 404;
    throw error;
  }
  const activeClusterId = clusters.length === 0 ? '' : store.activeClusterId === id ? clusters[0].id : store.activeClusterId;
  await writeClusterStore({ activeClusterId, clusters });
  // Only remove kubeconfigs this app wrote; an operator-supplied KUBECONFIG_PATH
  // is not ours to delete.
  if (isManagedKubeconfigPath(removed?.kubeconfigPath) && !clusters.some((cluster) => cluster.kubeconfigPath === removed.kubeconfigPath)) {
    await fs.rm(removed.kubeconfigPath, { force: true }).catch(() => null);
  }
  return readConfig();
}

async function switchCluster(id) {
  const store = await readClusterStore();
  if (!store.clusters.some((cluster) => cluster.id === id)) {
    const error = new Error('Cluster not found.');
    error.status = 404;
    throw error;
  }
  await writeClusterStore({ ...store, activeClusterId: id });
  return readConfig();
}

async function commandExists(command, args = ['--version']) {
  return new Promise((resolve) => {
    const child = spawn(command, args, { shell: false });
    child.on('error', () => resolve(false));
    child.on('close', (code) => resolve(code === 0 || code === 1));
  });
}

function run(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { ...options, shell: false });
    let stdout = '';
    let stderr = '';
    child.stdout?.on('data', (chunk) => { stdout += chunk; });
    child.stderr?.on('data', (chunk) => { stderr += chunk; });
    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0) resolve({ stdout, stderr });
      else reject(Object.assign(new Error(stderr || stdout || `${command} exited with ${code}`), { stdout, stderr, code }));
    });
  });
}

function stream(command, args, writable, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { ...options, shell: false });
    let stderr = '';
    child.stderr?.on('data', (chunk) => { stderr += chunk; });
    child.stdout?.pipe(writable);
    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0) resolve({ stderr });
      else reject(Object.assign(new Error(stderr || `${command} exited with ${code}`), { stderr, code }));
    });
  });
}

function runWithInput(command, args, input, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { ...options, shell: false });
    let stdout = '';
    let stderr = '';
    child.stdout?.on('data', (chunk) => { stdout += chunk; });
    child.stderr?.on('data', (chunk) => { stderr += chunk; });
    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0) resolve({ stdout, stderr });
      else reject(Object.assign(new Error(stderr || stdout || `${command} exited with ${code}`), { stdout, stderr, code }));
    });
    child.stdin?.end(input);
  });
}

function kubectlArgs(config, args) {
  if (!config?.clusterId && !config?.id) {
    const error = new Error('No cluster configured. Add a cluster in Settings first.');
    error.status = 400;
    throw error;
  }
  assertContextIsName(config.kubectlContext);
  const prefix = [];
  if (config.kubeconfigPath) prefix.push('--kubeconfig', config.kubeconfigPath);
  if (config.kubectlContext) prefix.push('--context', config.kubectlContext);
  return [...prefix, ...args];
}

async function kubectlJson(config, args) {
  const { stdout } = await run('kubectl', kubectlArgs(config, [...args, '-o', 'json']));
  return parseJson(stdout || '{}');
}

function sanitizeName(value) {
  const safe = String(value).toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '').replace(/-+/g, '-');
  return safe || 'item';
}

function k8sName(prefix, base, suffix = '') {
  const reserve = prefix.length + 1 + (suffix ? suffix.length + 1 : 0);
  const maxBase = Math.max(1, 63 - reserve);
  const safeBase = sanitizeName(base).slice(0, maxBase).replace(/-+$/g, '') || 'x';
  return suffix ? `${prefix}-${safeBase}-${suffix}` : `${prefix}-${safeBase}`;
}

function assertArchiveName(config, archive) {
  if (!/^[A-Za-z0-9._-]+$/.test(archive) || archive.includes('..') || !archive.endsWith(`.${config.archiveExtension}`)) {
    const error = new Error('Invalid archive name.');
    error.status = 400;
    throw error;
  }
}

function normalizeRestorePath(value) {
  const raw = String(value || '.').trim().replaceAll('\\', '/').replace(/^\/+/, '');
  if (!raw || raw === '.') return '.';
  if (raw.length > 512) {
    const error = new Error('Selected path is too long.');
    error.status = 400;
    throw error;
  }
  const parts = raw.split('/').filter(Boolean);
  if (parts.some((part) => part === '.' || part === '..')) {
    const error = new Error('Selected path cannot contain . or .. segments.');
    error.status = 400;
    throw error;
  }
  return parts.join('/');
}

function normalizePvcFilePath(value) {
  return normalizeRestorePath(value);
}

function normalizePvcEntryName(value) {
  const name = String(value || '').trim();
  if (!name || name === '.' || name === '..' || name.includes('/') || name.includes('\\') || name.length > 255) {
    const error = new Error('File or folder name is invalid.');
    error.status = 400;
    throw error;
  }
  return name;
}

function assertLiveFileExplorerEnabled(config) {
  if (!config.liveFileExplorerEnabled) {
    const error = new Error('Live file explorer is disabled.');
    error.status = 403;
    throw error;
  }
}

function zipDownloadName(pvcName, archive, selectedPath) {
  const archiveBase = archive.replace(/\.[^.]+$/, '');
  const selected = selectedPath === '.' ? 'full-archive' : selectedPath.split('/').at(-1);
  return `${safeFileName(pvcName)}-${safeFileName(archiveBase)}-${safeFileName(selected)}.zip`;
}

function parseTarListEntry(line) {
  const text = String(line || '').trim();
  if (!text) return null;
  const match = text.match(/^([dl-][^\s]*)\s+(?:(\S+)\/(\S+)|\S+\s+\S+)\s+(\d+)\s+(\d{4}-\d{2}-\d{2})\s+([0-9:]+)\s+(.+)$/);
  if (!match) return null;
  const rawPath = match[7].replace(/^\.\/+/, '').replace(/\/$/, '');
  const cleanPath = normalizeRestorePath(rawPath);
  if (cleanPath === '.') return null;
  const parts = cleanPath.split('/');
  const type = match[1].startsWith('d') ? 'directory' : 'file';
  return {
    path: cleanPath,
    name: parts.at(-1) || cleanPath,
    type,
    size: type === 'directory' ? '-' : match[4],
    modified: `${match[5]} ${match[6]}`
  };
}

function yamlString(value) {
  return JSON.stringify(String(value ?? ''));
}

function podPlacementYaml(nodeName, indent) {
  return nodeName ? `${' '.repeat(indent)}nodeName: ${yamlString(nodeName)}\n` : '';
}

function indentBlock(text, spaces) {
  const padding = ' '.repeat(spaces);
  return text.split('\n').map((line) => `${padding}${line}`).join('\n');
}

function backupArchiveShellScript({ echoArchive = false, retentionMaxDepth = false } = {}) {
  const retentionDepth = retentionMaxDepth ? ' -maxdepth 1' : '';
  const echoArchiveLine = echoArchive ? '\necho "archive=${archive}"' : '';
  return `set -euo pipefail
stamp="$(date +%Y%m%d%H%M%S)"
target="/backup/\${BACKUP_ROOT}/\${CLUSTER_NAME}/\${PVC_NAMESPACE}/\${PVC_NAME}"
archive="$target/\${stamp}.\${ARCHIVE_EXTENSION}"
tar_log="$(mktemp)"
mkdir -p "$target"
set +e
tar -czf "$archive" -C /source . 2>"$tar_log"
tar_rc=$?
set -e
if [ "$tar_rc" -ne 0 ]; then
  cat "$tar_log" >&2
  if [ ! -s "$archive" ] || [ ! -s "$tar_log" ] || grep -Ev '(^tar: \\./.*: No such file or directory$|^tar: .*: file changed as we read it$|^tar: error exit delayed from previous errors$)' "$tar_log" >/dev/null; then
    rm -f "$archive" "$tar_log"
    exit "$tar_rc"
  fi
  echo "qbackup: continuing after transient filesystem changes while creating $archive" >&2
fi
rm -f "$tar_log"
if [ "$ENABLE_RETENTION" = "true" ]; then
  find "$target"${retentionDepth} -type f -name "*.\${ARCHIVE_EXTENSION}" -mtime "+\${RETENTION_DAYS}" -delete
fi${echoArchiveLine}`;
}

async function findPvcConsumerNode(config, namespace, pvc) {
  const json = await kubectlJson(config, ['get', 'pods', '-n', namespace]);
  const candidates = (json.items || []).filter((pod) => {
    if (pod.metadata.deletionTimestamp) return false;
    if (pod.metadata.labels?.[appLabelName] === appLabelValue) return false;
    if (!['Pending', 'Running'].includes(pod.status?.phase)) return false;
    return (pod.spec?.volumes || []).some((volume) => volume.persistentVolumeClaim?.claimName === pvc);
  }).sort((a, b) => {
    const phaseScore = (pod) => pod.status?.phase === 'Running' ? 0 : 1;
    return phaseScore(a) - phaseScore(b);
  });
  return candidates.find((pod) => pod.spec?.nodeName)?.spec.nodeName || '';
}

function podUsesPvc(pod, pvc) {
  return (pod.spec?.volumes || []).some((volume) => volume.persistentVolumeClaim?.claimName === pvc);
}

function isQbackupAppPod(pod) {
  if (pod.metadata?.labels?.[appLabelComponent]) return false;
  if (pod.metadata?.labels?.[appLabelName] === appLabelValue) return true;
  if (pod.metadata?.labels?.app === appLabelValue) return true;
  return pod.spec?.serviceAccountName === appLabelValue && (pod.spec?.containers || []).some((container) => container.name === appLabelValue);
}

async function pvcConsumerPods(config, namespace, pvc) {
  const json = await kubectlJson(config, ['get', 'pods', '-n', namespace]);
  return (json.items || []).filter((pod) => {
    if (pod.metadata.deletionTimestamp) return false;
    if (pod.metadata.labels?.[appLabelName] === appLabelValue) return false;
    return podUsesPvc(pod, pvc);
  });
}

function qbackupInternalPvcKeysFromPods(pods) {
  const keys = new Set();
  for (const pod of pods || []) {
    if (pod.metadata?.deletionTimestamp || !isQbackupAppPod(pod)) continue;
    const namespace = pod.metadata?.namespace;
    if (!namespace) continue;
    for (const volume of pod.spec?.volumes || []) {
      const claimName = volume.persistentVolumeClaim?.claimName;
      if (claimName) keys.add(`${namespace}/${claimName}`);
    }
  }
  return keys;
}

async function qbackupInternalPvcKeys(config) {
  const json = await kubectlJson(config, ['get', 'pods', '-A']);
  return qbackupInternalPvcKeysFromPods(json.items || []);
}

async function assertNotQbackupInternalPvc(config, namespace, pvc) {
  const internalKeys = await qbackupInternalPvcKeys(config);
  if (!internalKeys.has(`${namespace}/${pvc}`)) return;
  const error = new Error(`PVC ${namespace}/${pvc} stores qbackup's own runtime data and cannot be backed up, scheduled, or restored by qbackup while the app is running.`);
  error.status = 400;
  throw error;
}

function controllerRef(pod) {
  return (pod.metadata.ownerReferences || []).find((owner) => owner.controller) || null;
}

async function resolveScalableController(config, namespace, pod) {
  const owner = controllerRef(pod);
  if (!owner) return null;
  if (owner.kind === 'ReplicaSet') {
    const replicaSet = await kubectlJson(config, ['get', 'replicaset', '-n', namespace, owner.name]);
    const rsOwner = (replicaSet.metadata?.ownerReferences || []).find((ref) => ref.controller);
    if (rsOwner?.kind === 'Deployment') return { kind: 'deployment', name: rsOwner.name };
    return { kind: 'replicaset', name: owner.name };
  }
  if (['Deployment', 'StatefulSet', 'ReplicaSet'].includes(owner.kind)) {
    return { kind: owner.kind.toLowerCase(), name: owner.name };
  }
  if (owner.kind === 'DaemonSet') return { kind: 'daemonset', name: owner.name, restartOnly: true };
  return null;
}

async function pvcConsumerControllers(config, namespace, pvc) {
  const pods = await pvcConsumerPods(config, namespace, pvc);
  const controllers = new Map();
  for (const pod of pods) {
    const controller = await resolveScalableController(config, namespace, pod).catch(() => null);
    if (!controller) continue;
    const key = `${controller.kind}/${controller.name}`;
    if (!controllers.has(key)) controllers.set(key, controller);
  }
  for (const controller of controllers.values()) {
    if (controller.restartOnly) continue;
    const current = await kubectlJson(config, ['get', controller.kind, '-n', namespace, controller.name]);
    controller.replicas = Number(current.spec?.replicas ?? 1);
  }
  return [...controllers.values()];
}

async function waitForPvcConsumersToStop(config, namespace, pvc, append, timeoutSeconds = 300) {
  const started = Date.now();
  while (Date.now() - started < timeoutSeconds * 1000) {
    const active = (await pvcConsumerPods(config, namespace, pvc)).filter((pod) => ['Pending', 'Running'].includes(pod.status?.phase));
    if (active.length === 0) return;
    append(`[${new Date().toISOString()}] Waiting for ${active.length} consumer pod(s) to stop: ${active.map((pod) => pod.metadata.name).join(', ')}\n`);
    await new Promise((resolve) => setTimeout(resolve, 5000));
  }
  throw new Error(`Timed out waiting for PVC consumers to stop for ${namespace}/${pvc}`);
}

async function prepareRestoreConsumers(config, namespace, pvc, append) {
  const nodeName = await findPvcConsumerNode(config, namespace, pvc);
  const controllers = await pvcConsumerControllers(config, namespace, pvc);
  const scalable = controllers.filter((controller) => !controller.restartOnly && controller.replicas > 0);
  const restartOnly = controllers.filter((controller) => controller.restartOnly);
  const restartable = controllers.filter((controller) => ['deployment', 'statefulset', 'daemonset'].includes(controller.kind));
  const restartControllers = async () => {
    const seen = new Set();
    for (const controller of restartable) {
      const key = `${controller.kind}/${controller.name}`;
      if (seen.has(key)) continue;
      seen.add(key);
      append(`[${new Date().toISOString()}] Restarting ${controller.kind}/${controller.name} to pick up restored files\n`);
      await run('kubectl', kubectlArgs(config, ['rollout', 'restart', controller.kind, '-n', namespace, controller.name]));
    }
  };

  if (!config.scaleConsumers) {
    append(`[${new Date().toISOString()}] Consumer scaling disabled. Restore helper will${nodeName ? ` run on ${nodeName}` : ' use default scheduling'}.\n`);
    return {
      nodeName,
      restore: restartControllers
    };
  }

  for (const controller of scalable) {
    append(`[${new Date().toISOString()}] Scaling ${controller.kind}/${controller.name} from ${controller.replicas} to 0\n`);
    await run('kubectl', kubectlArgs(config, ['scale', controller.kind, '-n', namespace, controller.name, '--replicas=0']));
  }
  if (scalable.length > 0) await waitForPvcConsumersToStop(config, namespace, pvc, append);

  return {
    nodeName: scalable.length > 0 ? '' : nodeName,
    restore: async () => {
      for (const controller of scalable.reverse()) {
        append(`[${new Date().toISOString()}] Scaling ${controller.kind}/${controller.name} back to ${controller.replicas}\n`);
        await run('kubectl', kubectlArgs(config, ['scale', controller.kind, '-n', namespace, controller.name, `--replicas=${controller.replicas}`]));
      }
      await restartControllers();
    }
  };
}

function cronFixedNumber(field) {
  return /^\d+$/.test(field) ? Number(field) : null;
}

// Spreads a batch of schedules across the hour so a shared cron time does not
// fire every backup Job at once. Left untouched when the shift cannot be
// expressed safely (wildcards, lists, or a shift that would cross midnight
// while day-of-month/day-of-week are pinned).
function staggerSchedule(schedule, offsetMinutes) {
  if (!offsetMinutes) return schedule;
  const parts = String(schedule).trim().split(/\s+/);
  if (parts.length !== 5) return schedule;
  const minute = cronFixedNumber(parts[0]);
  if (minute === null) return schedule;
  const total = minute + offsetMinutes;
  const hourShift = Math.floor(total / 60);
  if (!hourShift) return [String(total % 60), ...parts.slice(1)].join(' ');
  const hour = cronFixedNumber(parts[1]);
  if (hour === null) return schedule;
  if (hour + hourShift >= 24 && !(parts[2] === '*' && parts[4] === '*')) return schedule;
  return [String(total % 60), String((hour + hourShift) % 24), ...parts.slice(2)].join(' ');
}

function scheduleStaggerOffset(index, concurrency) {
  return Math.floor(index / Math.max(concurrency, 1)) * scheduleStaggerMinutes;
}

function cronJobManifest(config, namespace, pvc, schedule, nodeName = '') {
  const cronjobName = k8sName('pvc-backup', pvc);
  const retentionEnabled = String(config.retentionDays) === '0' ? 'false' : 'true';
  return `apiVersion: batch/v1
kind: CronJob
metadata:
  name: ${cronjobName}
  namespace: ${namespace}
  labels:
    ${appLabelName}: ${appLabelValue}
    ${appLabelComponent}: schedule
    backup-pvc: ${pvc}
spec:
  schedule: ${yamlString(schedule)}
  startingDeadlineSeconds: ${scheduleStartingDeadlineSeconds}
  concurrencyPolicy: Forbid
  successfulJobsHistoryLimit: 1
  failedJobsHistoryLimit: 3
  jobTemplate:
    metadata:
      annotations:
        ${autoHealParentAnnotation}: ${cronjobName}
    spec:
      backoffLimit: 0
      activeDeadlineSeconds: ${backupJobActiveDeadlineSeconds}
      ttlSecondsAfterFinished: ${backupJobTtlSecondsAfterFinished}
      template:
        metadata:
          labels:
            ${appLabelName}: ${appLabelValue}
            ${appLabelComponent}: schedule
            backup-pvc: ${pvc}
        spec:
${podPlacementYaml(nodeName, 10)}          restartPolicy: Never
          containers:
            - name: backup
              image: ${yamlString(config.helperImage)}
              imagePullPolicy: IfNotPresent
              command: ["/bin/sh", "-ceu"]
              args:
                - |
${indentBlock(backupArchiveShellScript(), 18)}
              env:
                - name: BACKUP_ROOT
                  value: ${yamlString(config.backupRoot)}
                - name: CLUSTER_NAME
                  value: ${yamlString(config.clusterName)}
                - name: PVC_NAMESPACE
                  value: ${yamlString(namespace)}
                - name: PVC_NAME
                  value: ${yamlString(pvc)}
                - name: ARCHIVE_EXTENSION
                  value: ${yamlString(config.archiveExtension)}
                - name: ENABLE_RETENTION
                  value: ${yamlString(retentionEnabled)}
                - name: RETENTION_DAYS
                  value: ${yamlString(config.retentionDays)}
              volumeMounts:
                - name: source
                  mountPath: /source
                  readOnly: true
                - name: backup
                  mountPath: /backup
          volumes:
            - name: source
              persistentVolumeClaim:
                claimName: ${pvc}
                readOnly: true
            - name: backup
              nfs:
                server: ${yamlString(config.nfsServer)}
                path: ${yamlString(config.nfsExportPath)}
`;
}

async function applyManifest(config, manifest) {
  const temp = path.join(os.tmpdir(), `qbackup-${crypto.randomUUID()}.yaml`);
  await fs.writeFile(temp, manifest);
  try {
    const { stdout, stderr } = await run('kubectl', kubectlArgs(config, ['apply', '-f', temp]));
    return stdout || stderr;
  } finally {
    await fs.rm(temp, { force: true });
  }
}

async function annotateAutoHealParent(config, namespace, kind, name, parentName) {
  const patch = JSON.stringify({
    metadata: {
      annotations: {
        [autoHealParentAnnotation]: parentName,
        [autoHealRetryAnnotation]: '0',
        [autoHealOriginalNameAnnotation]: name
      }
    }
  });
  await run('kubectl', kubectlArgs(config, ['patch', kind, '-n', namespace, name, '--type', 'merge', '-p', patch])).catch(() => null);
}

async function patchCronJobPlacement(config, namespace, name, nodeName) {
  const patch = nodeName
    ? [{ op: 'add', path: '/spec/jobTemplate/spec/template/spec/nodeName', value: nodeName }]
    : [{ op: 'remove', path: '/spec/jobTemplate/spec/template/spec/nodeName' }];
  try {
    const { stdout, stderr } = await run('kubectl', kubectlArgs(config, ['patch', 'cronjob', '-n', namespace, name, '--type', 'json', '-p', JSON.stringify(patch)]));
    return stdout || stderr;
  } catch (error) {
    if (!nodeName && String(error.stderr || error.message || '').includes('missing path')) return '';
    throw error;
  }
}

async function patchCronJobSafety(config, namespace, name) {
  const patch = {
    spec: {
      startingDeadlineSeconds: scheduleStartingDeadlineSeconds,
      jobTemplate: {
        spec: {
          backoffLimit: 0,
          activeDeadlineSeconds: backupJobActiveDeadlineSeconds,
          ttlSecondsAfterFinished: backupJobTtlSecondsAfterFinished
        }
      }
    }
  };
  const { stdout, stderr } = await run('kubectl', kubectlArgs(config, ['patch', 'cronjob', '-n', namespace, name, '--type', 'merge', '-p', JSON.stringify(patch)]));
  return stdout || stderr;
}

function cronJobSafetyNeedsRefresh(cronjob) {
  const spec = cronjob.spec || {};
  const jobSpec = spec.jobTemplate?.spec || {};
  return spec.startingDeadlineSeconds !== scheduleStartingDeadlineSeconds
    || jobSpec.backoffLimit !== 0
    || jobSpec.activeDeadlineSeconds !== backupJobActiveDeadlineSeconds
    || jobSpec.ttlSecondsAfterFinished !== backupJobTtlSecondsAfterFinished;
}

async function refreshCronJobPlacement(config, cronjob) {
  const namespace = cronjob.metadata?.namespace;
  const name = cronjob.metadata?.name;
  const pvc = cronjob.metadata?.labels?.['backup-pvc'];
  if (!namespace || !name || !pvc) return null;

  const safetyChanged = cronJobSafetyNeedsRefresh(cronjob);
  if (safetyChanged) await patchCronJobSafety(config, namespace, name);
  const currentNode = cronjob.spec?.jobTemplate?.spec?.template?.spec?.nodeName || '';
  const desiredNode = await findPvcConsumerNode(config, namespace, pvc);
  if (currentNode !== desiredNode) await patchCronJobPlacement(config, namespace, name, desiredNode);
  const replacements = await replaceMisplacedActiveScheduleJobs(config, cronjob, desiredNode);
  if (!safetyChanged && currentNode === desiredNode && replacements.length === 0) return null;

  return { namespace, name, pvc, previousNode: currentNode || null, nodeName: desiredNode || null, replacements, safetyChanged };
}

async function replaceMisplacedActiveScheduleJobs(config, cronjob, desiredNode) {
  if (!desiredNode) return [];
  const namespace = cronjob.metadata?.namespace;
  const name = cronjob.metadata?.name;
  const pvc = cronjob.metadata?.labels?.['backup-pvc'];
  const activeNames = new Set((cronjob.status?.active || []).map((ref) => ref.name).filter(Boolean));
  if (!namespace || !name || !pvc || activeNames.size === 0) return [];

  const label = `${appLabelName}=${appLabelValue},${appLabelComponent}=schedule,backup-pvc=${pvc}`;
  const json = await kubectlJson(config, ['get', 'pods', '-n', namespace, '-l', label]);
  const misplacedJobs = new Set();
  for (const pod of json.items || []) {
    if (pod.metadata?.deletionTimestamp) continue;
    if (pod.status?.phase !== 'Pending') continue;
    if (!pod.spec?.nodeName || pod.spec.nodeName === desiredNode) continue;
    const jobName = pod.metadata?.labels?.['job-name'] || pod.metadata?.labels?.['batch.kubernetes.io/job-name'];
    if (jobName && activeNames.has(jobName)) misplacedJobs.add(jobName);
  }

  const replacements = [];
  for (const jobName of misplacedJobs) {
    await run('kubectl', kubectlArgs(config, ['delete', 'job', '-n', namespace, jobName, '--ignore-not-found']));
    if (cronjob.spec?.suspend) {
      replacements.push({ deleted: jobName, replacement: null });
      continue;
    }
    const replacement = k8sName('retry', name, Date.now().toString().slice(-8));
    await run('kubectl', kubectlArgs(config, ['create', 'job', '-n', namespace, replacement, `--from=cronjob/${name}`]));
    await annotateAutoHealParent(config, namespace, 'job', replacement, name);
    replacements.push({ deleted: jobName, replacement });
  }

  return replacements;
}

let schedulePlacementRefreshRunning = false;

async function refreshSchedulePlacements() {
  if (schedulePlacementRefreshRunning) return;
  schedulePlacementRefreshRunning = true;
  try {
    const config = await readConfig();
    const label = `${appLabelName}=${appLabelValue},${appLabelComponent}=schedule`;
    const json = await kubectlJson(config, ['get', 'cronjobs', '-A', '-l', label]);
    const changes = [];
    for (const cronjob of json.items || []) {
      const change = await refreshCronJobPlacement(config, cronjob);
      if (change) changes.push(change);
    }
    if (changes.length > 0) {
      const replacementCount = changes.reduce((sum, item) => sum + item.replacements.length, 0);
      const safetyCount = changes.filter((item) => item.safetyChanged).length;
      console.log(`Refreshed qbackup schedules for ${changes.length} CronJob(s)${safetyCount ? `, applied safety limits to ${safetyCount}` : ''}${replacementCount ? `, and replaced ${replacementCount} misplaced active Job(s)` : ''}: ${changes.map((item) => `${item.namespace}/${item.name}${item.nodeName ? ` -> ${item.nodeName}` : ' -> default scheduling'}`).join(', ')}`);
    }
  } catch (error) {
    console.warn(`Failed to refresh qbackup schedule placement: ${error.message || error}`);
  } finally {
    schedulePlacementRefreshRunning = false;
  }
}

function createAsyncJob(type, permission, executor) {
  const id = crypto.randomUUID();
  const job = { id, type, permission, status: 'running', startedAt: new Date().toISOString(), finishedAt: null, code: null, output: [], droppedOutput: 0 };
  jobs.set(id, job);
  const append = (text, stream = 'stdout') => {
    job.output.push({ ts: new Date().toISOString(), stream, text: String(text) });
    if (job.output.length > maxJobOutputEntries) {
      job.droppedOutput += job.output.length - maxJobOutputEntries;
      job.output.splice(0, job.output.length - maxJobOutputEntries);
    }
  };
  sweepEphemeralState();
  Promise.resolve()
    .then(() => executor({ append, job }))
    .then(() => {
      job.status = 'succeeded';
      job.code = 0;
      job.finishedAt = new Date().toISOString();
    })
    .catch((error) => {
      append(`${error.message || error}\n`, 'stderr');
      if (error.stderr) append(`${error.stderr}\n`, 'stderr');
      if (error.stdout) append(`${error.stdout}\n`, 'stdout');
      job.status = 'failed';
      job.code = error.code || 1;
      job.finishedAt = new Date().toISOString();
    });
  return job;
}

function backupPodManifest(config, namespace, pvc, podName, nodeName = '') {
  const retentionEnabled = String(config.retentionDays) === '0' ? 'false' : 'true';
  return `apiVersion: v1
kind: Pod
metadata:
  name: ${podName}
  namespace: ${namespace}
  labels:
    ${appLabelName}: ${appLabelValue}
    ${appLabelComponent}: on-demand-backup
    backup-pvc: ${pvc}
spec:
${podPlacementYaml(nodeName, 2)}  restartPolicy: Never
  containers:
    - name: backup
      image: ${yamlString(config.helperImage)}
      imagePullPolicy: IfNotPresent
      command: ["/bin/sh", "-ceu"]
      args:
        - |
${indentBlock(backupArchiveShellScript({ echoArchive: true, retentionMaxDepth: true }), 10)}
      env:
        - name: BACKUP_ROOT
          value: ${yamlString(config.backupRoot)}
        - name: CLUSTER_NAME
          value: ${yamlString(config.clusterName)}
        - name: PVC_NAMESPACE
          value: ${yamlString(namespace)}
        - name: PVC_NAME
          value: ${yamlString(pvc)}
        - name: ARCHIVE_EXTENSION
          value: ${yamlString(config.archiveExtension)}
        - name: ENABLE_RETENTION
          value: ${yamlString(retentionEnabled)}
        - name: RETENTION_DAYS
          value: ${yamlString(config.retentionDays)}
      volumeMounts:
        - name: source
          mountPath: /source
          readOnly: true
        - name: backup
          mountPath: /backup
  volumes:
    - name: source
      persistentVolumeClaim:
        claimName: ${pvc}
        readOnly: true
    - name: backup
      nfs:
        server: ${yamlString(config.nfsServer)}
        path: ${yamlString(config.nfsExportPath)}
`;
}

function archiveCatalogPodManifest(config, namespace, pvc, podName) {
  return `apiVersion: v1
kind: Pod
metadata:
  name: ${podName}
  namespace: ${namespace}
  labels:
    ${appLabelName}: ${appLabelValue}
    ${appLabelComponent}: archive-catalog
    backup-pvc: ${pvc}
spec:
  restartPolicy: Never
  containers:
    - name: catalog
      image: ${yamlString(config.helperImage)}
      imagePullPolicy: IfNotPresent
      command: ["/bin/sh", "-ceu"]
      args:
        - |
          target="/backup/\${BACKUP_ROOT}/\${CLUSTER_NAME}/\${PVC_NAMESPACE}/\${PVC_NAME}"
          [ -d "$target" ] || exit 0
          for file in "$target"/*.\${ARCHIVE_EXTENSION}; do
            [ -e "$file" ] || continue
            size="$(wc -c < "$file" | tr -d ' ')"
            printf '%s\\t%s\\n' "$(basename "$file")" "$size"
          done
      env:
        - name: BACKUP_ROOT
          value: ${yamlString(config.backupRoot)}
        - name: CLUSTER_NAME
          value: ${yamlString(config.clusterName)}
        - name: PVC_NAMESPACE
          value: ${yamlString(namespace)}
        - name: PVC_NAME
          value: ${yamlString(pvc)}
        - name: ARCHIVE_EXTENSION
          value: ${yamlString(config.archiveExtension)}
      volumeMounts:
        - name: backup
          mountPath: /backup
          readOnly: true
  volumes:
    - name: backup
      nfs:
        server: ${yamlString(config.nfsServer)}
        path: ${yamlString(config.nfsExportPath)}
`;
}

function restorePodManifest(config, namespace, pvc, archive, podName, nodeName = '') {
  return `apiVersion: v1
kind: Pod
metadata:
  name: ${podName}
  namespace: ${namespace}
  labels:
    ${appLabelName}: ${appLabelValue}
    ${appLabelComponent}: restore
    backup-pvc: ${pvc}
spec:
${podPlacementYaml(nodeName, 2)}  restartPolicy: Never
  containers:
    - name: restore
      image: ${yamlString(config.helperImage)}
      imagePullPolicy: IfNotPresent
      command: ["/bin/sh", "-ceu"]
      args:
        - |
          archive="/backup/\${BACKUP_ROOT}/\${CLUSTER_NAME}/\${PVC_NAMESPACE}/\${PVC_NAME}/\${ARCHIVE_NAME}"
          test -f "$archive"
          find /target -mindepth 1 -maxdepth 1 -exec rm -rf {} +
          tar -xzf "$archive" -C /target
          echo "restored=${archive}"
      env:
        - name: BACKUP_ROOT
          value: ${yamlString(config.backupRoot)}
        - name: CLUSTER_NAME
          value: ${yamlString(config.clusterName)}
        - name: PVC_NAMESPACE
          value: ${yamlString(namespace)}
        - name: PVC_NAME
          value: ${yamlString(pvc)}
        - name: ARCHIVE_NAME
          value: ${yamlString(archive)}
      volumeMounts:
        - name: target
          mountPath: /target
        - name: backup
          mountPath: /backup
          readOnly: true
  volumes:
    - name: target
      persistentVolumeClaim:
        claimName: ${pvc}
    - name: backup
      nfs:
        server: ${yamlString(config.nfsServer)}
        path: ${yamlString(config.nfsExportPath)}
`;
}

// Helper images are not guaranteed to ship zip, and an air-gapped cluster cannot
// reach a package mirror. Fail with a message that names the cause.
function ensureZipShellScript() {
  return `if ! command -v zip >/dev/null 2>&1; then
  if command -v apk >/dev/null 2>&1; then apk add --no-cache zip >/dev/null 2>&1 || true
  elif command -v apt-get >/dev/null 2>&1; then (apt-get update >/dev/null 2>&1 && apt-get install -y zip >/dev/null 2>&1) || true
  elif command -v microdnf >/dev/null 2>&1; then microdnf install -y zip >/dev/null 2>&1 || true
  elif command -v dnf >/dev/null 2>&1; then dnf install -y zip >/dev/null 2>&1 || true
  fi
fi
if ! command -v zip >/dev/null 2>&1; then
  echo "qbackup: helper image has no zip and it could not be installed (offline package mirror or unsupported base image). Set Helper image to one that includes zip." >&2
  exit 6
fi`;
}

function fileRestorePodManifest(config, namespace, pvc, archive, selectedPath, podName) {
  return `apiVersion: v1
kind: Pod
metadata:
  name: ${podName}
  namespace: ${namespace}
  labels:
    ${appLabelName}: ${appLabelValue}
    ${appLabelComponent}: file-restore
    backup-pvc: ${pvc}
spec:
  restartPolicy: Never
  activeDeadlineSeconds: ${downloadHelperLifetimeSeconds}
  containers:
    - name: file-restore
      image: ${yamlString(config.helperImage)}
      imagePullPolicy: IfNotPresent
      command: ["/bin/sh", "-ceu"]
      args:
        - |
          archive="/backup/\${BACKUP_ROOT}/\${CLUSTER_NAME}/\${PVC_NAMESPACE}/\${PVC_NAME}/\${ARCHIVE_NAME}"
          test -f "$archive"
${indentBlock(ensureZipShellScript(), 10)}
          mkdir -p /work/extract
          tar -xzf "$archive" -C /work/extract
          selected="\${SELECTED_PATH}"
          if [ "$selected" = "." ]; then
            (cd /work/extract && zip -qr /work/output.zip .)
          else
            test -e "/work/extract/$selected"
            parent="$(dirname "$selected")"
            name="$(basename "$selected")"
            (cd "/work/extract/$parent" && zip -qr /work/output.zip "$name")
          fi
          touch /work/ready
          sleep ${downloadHelperLifetimeSeconds}
      readinessProbe:
        exec:
          command: ["test", "-f", "/work/ready"]
        periodSeconds: 1
        timeoutSeconds: 1
        failureThreshold: 600
      env:
        - name: BACKUP_ROOT
          value: ${yamlString(config.backupRoot)}
        - name: CLUSTER_NAME
          value: ${yamlString(config.clusterName)}
        - name: PVC_NAMESPACE
          value: ${yamlString(namespace)}
        - name: PVC_NAME
          value: ${yamlString(pvc)}
        - name: ARCHIVE_NAME
          value: ${yamlString(archive)}
        - name: SELECTED_PATH
          value: ${yamlString(selectedPath)}
      volumeMounts:
        - name: backup
          mountPath: /backup
          readOnly: true
        - name: work
          mountPath: /work
  volumes:
    - name: backup
      nfs:
        server: ${yamlString(config.nfsServer)}
        path: ${yamlString(config.nfsExportPath)}
    - name: work
      emptyDir: {}
`;
}

function fileRestoreCatalogPodManifest(config, namespace, pvc, archive, podName) {
  return `apiVersion: v1
kind: Pod
metadata:
  name: ${podName}
  namespace: ${namespace}
  labels:
    ${appLabelName}: ${appLabelValue}
    ${appLabelComponent}: file-restore-catalog
    backup-pvc: ${pvc}
spec:
  restartPolicy: Never
  containers:
    - name: catalog
      image: ${yamlString(config.helperImage)}
      imagePullPolicy: IfNotPresent
      command: ["/bin/sh", "-ceu"]
      args:
        - |
          archive="/backup/\${BACKUP_ROOT}/\${CLUSTER_NAME}/\${PVC_NAMESPACE}/\${PVC_NAME}/\${ARCHIVE_NAME}"
          test -f "$archive"
          tar -tvzf "$archive"
      env:
        - name: BACKUP_ROOT
          value: ${yamlString(config.backupRoot)}
        - name: CLUSTER_NAME
          value: ${yamlString(config.clusterName)}
        - name: PVC_NAMESPACE
          value: ${yamlString(namespace)}
        - name: PVC_NAME
          value: ${yamlString(pvc)}
        - name: ARCHIVE_NAME
          value: ${yamlString(archive)}
      volumeMounts:
        - name: backup
          mountPath: /backup
          readOnly: true
  volumes:
    - name: backup
      nfs:
        server: ${yamlString(config.nfsServer)}
        path: ${yamlString(config.nfsExportPath)}
`;
}

function liveFileHelperPodManifest(config, namespace, pvc, podName, readOnly = true, nodeName = '') {
  return `apiVersion: v1
kind: Pod
metadata:
  name: ${podName}
  namespace: ${namespace}
  labels:
    ${appLabelName}: ${appLabelValue}
    ${appLabelComponent}: live-file-explorer
    backup-pvc: ${pvc}
spec:
${podPlacementYaml(nodeName, 2)}  restartPolicy: Never
  containers:
    - name: explorer
      image: ${yamlString(config.helperImage)}
      imagePullPolicy: IfNotPresent
      command: ["/bin/sh", "-ceu"]
      args:
        - |
          touch /tmp/ready
          sleep 600
      readinessProbe:
        exec:
          command: ["test", "-f", "/tmp/ready"]
        periodSeconds: 1
        timeoutSeconds: 1
        failureThreshold: 120
      volumeMounts:
        - name: target
          mountPath: /target
          readOnly: ${readOnly ? 'true' : 'false'}
  volumes:
    - name: target
      persistentVolumeClaim:
        claimName: ${pvc}
        readOnly: ${readOnly ? 'true' : 'false'}
`;
}

function liveFileDownloadPodManifest(config, namespace, pvc, selectedPath, podName, nodeName = '') {
  return `apiVersion: v1
kind: Pod
metadata:
  name: ${podName}
  namespace: ${namespace}
  labels:
    ${appLabelName}: ${appLabelValue}
    ${appLabelComponent}: live-file-download
    backup-pvc: ${pvc}
spec:
${podPlacementYaml(nodeName, 2)}  restartPolicy: Never
  activeDeadlineSeconds: ${downloadHelperLifetimeSeconds}
  containers:
    - name: download
      image: ${yamlString(config.helperImage)}
      imagePullPolicy: IfNotPresent
      command: ["/bin/sh", "-ceu"]
      args:
        - |
${indentBlock(ensureZipShellScript(), 10)}
          selected="\${SELECTED_PATH}"
          if [ "$selected" = "." ]; then
            (cd /target && zip -qr /work/output.zip .)
          else
            test -e "/target/$selected"
            parent="$(dirname "$selected")"
            name="$(basename "$selected")"
            (cd "/target/$parent" && zip -qr /work/output.zip "$name")
          fi
          touch /work/ready
          sleep ${downloadHelperLifetimeSeconds}
      readinessProbe:
        exec:
          command: ["test", "-f", "/work/ready"]
        periodSeconds: 1
        timeoutSeconds: 1
        failureThreshold: 600
      env:
        - name: SELECTED_PATH
          value: ${yamlString(selectedPath)}
      volumeMounts:
        - name: target
          mountPath: /target
          readOnly: true
        - name: work
          mountPath: /work
  volumes:
    - name: target
      persistentVolumeClaim:
        claimName: ${pvc}
        readOnly: true
    - name: work
      emptyDir: {}
`;
}

async function waitForPodCompletion(config, namespace, podName, append = () => {}, timeoutSeconds = 1800) {
  const started = Date.now();
  let lastPhase = '';
  while (Date.now() - started < timeoutSeconds * 1000) {
    let phase = '';
    try {
      const pod = await kubectlJson(config, ['get', 'pod', '-n', namespace, podName]);
      phase = pod.status?.phase || '';
    } catch {
      phase = 'Pending';
    }
    if (phase !== lastPhase) {
      append(`[${new Date().toISOString()}] Pod ${namespace}/${podName} phase=${phase}\n`);
      lastPhase = phase;
    }
    if (phase === 'Succeeded' || phase === 'Failed') return phase;
    await new Promise((resolve) => setTimeout(resolve, 3000));
  }
  return 'Timeout';
}

function podConditionStatus(pod, type) {
  return (pod?.status?.conditions || []).find((condition) => condition.type === type)?.status || '';
}

async function runHelperPod(config, namespace, manifest, podName, append = () => {}, timeoutSeconds = 1800) {
  const maxRetries = Boolean(config.autoHealEnabled) ? Number.parseInt(normalizeAutoHealRetries(config.autoHealRetries), 10) : 0;
  let attempt = 0;
  let lastError = null;
  while (attempt <= maxRetries) {
    const attemptPodName = attempt === 0 ? podName : k8sName('retry', podName, `${attempt}-${Date.now().toString().slice(-6)}`);
    const attemptManifest = manifest.replace(new RegExp(`name: ${podName}\\n  namespace: ${namespace}`), `name: ${attemptPodName}\n  namespace: ${namespace}`);
    append(`[${new Date().toISOString()}] Creating helper Pod ${namespace}/${attemptPodName}${attempt ? ` (auto-heal retry ${attempt}/${maxRetries})` : ''}\n`);
    append(await applyManifest(config, attemptManifest));
    const phase = await waitForPodCompletion(config, namespace, attemptPodName, append, timeoutSeconds);
    const logs = await run('kubectl', kubectlArgs(config, ['logs', '-n', namespace, attemptPodName])).then((result) => result.stdout || result.stderr).catch((error) => error.stdout || error.stderr || '');
    if (logs) append(logs.endsWith('\n') ? logs : `${logs}\n`);
    if (phase !== 'Succeeded' && config.keepFailedPods) {
      append(`[${new Date().toISOString()}] Keeping failed helper Pod ${namespace}/${attemptPodName} for inspection (Keep failed helper Pods is on). Delete it manually when done.\n`, 'stderr');
    } else {
      await run('kubectl', kubectlArgs(config, ['delete', 'pod', '-n', namespace, attemptPodName, '--ignore-not-found', '--wait=false'])).catch(() => null);
    }
    if (phase === 'Succeeded') return logs;
    lastError = new Error(`Helper Pod ${namespace}/${attemptPodName} finished with phase=${phase}`);
    incrementMetric(metricsState.autoHeal.actions, { kind: 'helper_pod', result: attempt < maxRetries ? 'retry' : 'failed' });
    if (attempt >= maxRetries) break;
    append(`[${new Date().toISOString()}] Auto-heal will replace failed helper Pod ${namespace}/${attemptPodName}\n`, 'stderr');
    attempt += 1;
  }
  throw lastError || new Error(`Helper Pod ${namespace}/${podName} failed`);
}

function resourceRetryCount(resource) {
  return Number.parseInt(resource?.metadata?.annotations?.[autoHealRetryAnnotation] || '0', 10) || 0;
}

function ownerKind(resource, kind) {
  return (resource?.metadata?.ownerReferences || []).find((owner) => owner.kind === kind);
}

function autoHealExhausted(kind, resourceId = '') {
  const key = `${kind}:${resourceId}`;
  if (metricsState.autoHeal.exhaustedResources.has(key)) return;
  metricsState.autoHeal.exhaustedResources.set(key, Date.now());
  incrementMetric(metricsState.autoHeal.exhausted, { kind });
}

async function recreateStandalonePod(config, pod, retries) {
  const namespace = pod.metadata?.namespace;
  const currentName = pod.metadata?.name;
  const pvc = pod.metadata?.labels?.['backup-pvc'] || '';
  const nextName = k8sName('heal', currentName, Date.now().toString().slice(-8));
  // Re-resolve placement instead of reusing the old node (it may be why the pod
  // failed) or dropping it entirely (an RWO volume may only attach on one node).
  const nodeName = pvc ? await findPvcConsumerNode(config, namespace, pvc).catch(() => '') : '';
  const manifest = {
    apiVersion: 'v1',
    kind: 'Pod',
    metadata: {
      name: nextName,
      namespace,
      labels: pod.metadata?.labels || {},
      annotations: {
        ...(pod.metadata?.annotations || {}),
        [autoHealRetryAnnotation]: String(retries + 1),
        [autoHealOriginalNameAnnotation]: pod.metadata?.annotations?.[autoHealOriginalNameAnnotation] || currentName
      }
    },
    spec: pod.spec
  };
  if (nodeName) manifest.spec.nodeName = nodeName;
  else delete manifest.spec.nodeName;
  manifest.spec.restartPolicy = 'Never';
  await run('kubectl', kubectlArgs(config, ['delete', 'pod', '-n', namespace, currentName, '--ignore-not-found', '--wait=false']));
  await runWithInput('kubectl', kubectlArgs(config, ['apply', '-f', '-']), JSON.stringify(manifest));
  return nextName;
}

async function createReplacementJobFromCronJob(config, job, retries) {
  const namespace = job.metadata?.namespace;
  const currentName = job.metadata?.name;
  const parentName = jobParentName(job);
  const replacement = k8sName('heal', parentName, Date.now().toString().slice(-8));
  await run('kubectl', kubectlArgs(config, ['delete', 'job', '-n', namespace, currentName, '--ignore-not-found']));
  await run('kubectl', kubectlArgs(config, ['create', 'job', '-n', namespace, replacement, `--from=cronjob/${parentName}`]));
  const patch = JSON.stringify({
    metadata: {
      annotations: {
        [autoHealRetryAnnotation]: String(retries + 1),
        [autoHealParentAnnotation]: parentName,
        [autoHealOriginalNameAnnotation]: job.metadata?.annotations?.[autoHealOriginalNameAnnotation] || currentName
      }
    }
  });
  await run('kubectl', kubectlArgs(config, ['patch', 'job', '-n', namespace, replacement, '--type', 'merge', '-p', patch]));
  return replacement;
}

function jobParentName(job) {
  const currentName = job.metadata?.name || '';
  const cronOwner = ownerKind(job, 'CronJob');
  return job.metadata?.annotations?.[autoHealParentAnnotation] || cronOwner?.name || currentName.replace(/-\d+$/, '');
}

async function autoHealBackupPods(config, maxRetries) {
  const label = `${appLabelName}=${appLabelValue}`;
  const json = await kubectlJson(config, ['get', 'pods', '-A', '-l', label]);
  for (const pod of json.items || []) {
    const component = pod.metadata?.labels?.[appLabelComponent] || '';
    if (!['on-demand-backup', 'schedule'].includes(component)) continue;
    if (pod.metadata?.deletionTimestamp || pod.status?.phase !== 'Failed') continue;
    if (ownerKind(pod, 'Job')) continue;
    const retries = resourceRetryCount(pod);
    if (retries >= maxRetries) {
      autoHealExhausted('pod', `${pod.metadata?.namespace}/${pod.metadata?.name}`);
      continue;
    }
    try {
      await recreateStandalonePod(config, pod, retries);
      incrementMetric(metricsState.autoHeal.actions, { kind: 'pod', result: 'recreated' });
    } catch (error) {
      incrementMetric(metricsState.autoHeal.actions, { kind: 'pod', result: 'error' });
      throw error;
    }
  }
}

async function autoHealBackupJobs(config, maxRetries) {
  const label = `${appLabelName}=${appLabelValue},${appLabelComponent}=schedule`;
  const json = await kubectlJson(config, ['get', 'jobs', '-A', '-l', label]);
  const activeKeys = new Set((json.items || [])
    .filter((job) => Number(job.status?.active || 0) > 0)
    .map((job) => `${job.metadata?.namespace}/${jobParentName(job)}/${job.metadata?.labels?.['backup-pvc'] || ''}`));
  for (const job of json.items || []) {
    if (job.metadata?.deletionTimestamp || Number(job.status?.failed || 0) < 1) continue;
    const activeKey = `${job.metadata?.namespace}/${jobParentName(job)}/${job.metadata?.labels?.['backup-pvc'] || ''}`;
    if (activeKeys.has(activeKey)) continue;
    const retries = resourceRetryCount(job);
    if (retries >= maxRetries) {
      autoHealExhausted('job', `${job.metadata?.namespace}/${job.metadata?.name}`);
      continue;
    }
    try {
      await createReplacementJobFromCronJob(config, job, retries);
      incrementMetric(metricsState.autoHeal.actions, { kind: 'job', result: 'recreated' });
    } catch (error) {
      incrementMetric(metricsState.autoHeal.actions, { kind: 'job', result: 'error' });
      throw error;
    }
  }
}

async function runAutoHeal() {
  if (metricsState.autoHeal.running) return;
  metricsState.autoHeal.running = true;
  metricsState.autoHeal.runs += 1;
  try {
    const config = await readConfig();
    const maxRetries = Number.parseInt(normalizeAutoHealRetries(config.autoHealRetries), 10);
    metricsState.autoHeal.enabled = Boolean(config.autoHealEnabled);
    metricsState.autoHeal.maxRetries = maxRetries;
    if ((config.clusterId || config.id) && config.autoHealEnabled && maxRetries > 0) {
      await autoHealBackupJobs(config, maxRetries);
      await autoHealBackupPods(config, maxRetries);
    }
    metricsState.autoHeal.lastRunAt = new Date().toISOString();
    metricsState.autoHeal.lastSuccess = true;
    metricsState.autoHeal.lastError = '';
  } catch (error) {
    metricsState.autoHeal.lastRunAt = new Date().toISOString();
    metricsState.autoHeal.lastSuccess = false;
    metricsState.autoHeal.lastError = error.message || String(error);
    console.warn(`Auto-heal monitor failed: ${metricsState.autoHeal.lastError}`);
  } finally {
    metricsState.autoHeal.running = false;
  }
}

async function waitForFileRestoreReady(config, namespace, podName, timeoutSeconds = 600) {
  const started = Date.now();
  while (Date.now() - started < timeoutSeconds * 1000) {
    const pod = await kubectlJson(config, ['get', 'pod', '-n', namespace, podName]).catch(() => null);
    const phase = pod?.status?.phase || '';
    if (phase === 'Failed' || phase === 'Succeeded') {
      const logs = await run('kubectl', kubectlArgs(config, ['logs', '-n', namespace, podName])).then((result) => result.stdout || result.stderr).catch(() => '');
      throw new Error(logs || `File restore helper finished before the zip was ready with phase=${phase}`);
    }
    if (podConditionStatus(pod, 'Ready') === 'True') return;
    await new Promise((resolve) => setTimeout(resolve, 2000));
  }
  throw new Error(`Timed out waiting for file restore helper ${namespace}/${podName}`);
}

async function waitForLiveFileHelperReady(config, namespace, podName, timeoutSeconds = 120) {
  const started = Date.now();
  while (Date.now() - started < timeoutSeconds * 1000) {
    const pod = await kubectlJson(config, ['get', 'pod', '-n', namespace, podName]).catch(() => null);
    const phase = pod?.status?.phase || '';
    if (phase === 'Failed' || phase === 'Succeeded') {
      const logs = await run('kubectl', kubectlArgs(config, ['logs', '-n', namespace, podName])).then((result) => result.stdout || result.stderr).catch(() => '');
      throw new Error(logs || `Live file helper finished before it was ready with phase=${phase}`);
    }
    if (podConditionStatus(pod, 'Ready') === 'True') return;
    await new Promise((resolve) => setTimeout(resolve, 1500));
  }
  throw new Error(`Timed out waiting for live file helper ${namespace}/${podName}`);
}

async function withLiveFileHelper(config, namespace, pvc, readOnly, callback) {
  const podName = k8sName('live-files', pvc, Date.now().toString().slice(-10));
  const nodeName = await findPvcConsumerNode(config, namespace, pvc);
  await applyManifest(config, liveFileHelperPodManifest(config, namespace, pvc, podName, readOnly, nodeName));
  try {
    await waitForLiveFileHelperReady(config, namespace, podName);
    return await callback(podName);
  } finally {
    await run('kubectl', kubectlArgs(config, ['delete', 'pod', '-n', namespace, podName, '--ignore-not-found', '--wait=false'])).catch(() => null);
  }
}

function parseLiveFileRows(output, parentPath) {
  const prefix = parentPath === '.' ? '' : `${parentPath}/`;
  return output.split(/\r?\n/).filter(Boolean).map((line) => {
    const [name, type, size, modifiedEpoch] = line.split('\t');
    const pathValue = prefix + name;
    return {
      name,
      path: pathValue,
      type,
      size: type === 'directory' ? '-' : size,
      modified: Number(modifiedEpoch || 0) > 0 ? new Date(Number(modifiedEpoch) * 1000).toISOString() : '-'
    };
  }).sort((a, b) => {
    if (a.type !== b.type) return a.type === 'directory' ? -1 : 1;
    return a.name.localeCompare(b.name);
  });
}

function prometheusEscape(value) {
  return String(value ?? '').replaceAll('\\', '\\\\').replaceAll('\n', '\\n').replaceAll('"', '\\"');
}

function prometheusLine(name, labels, value) {
  const entries = Object.entries(labels || {}).filter(([, item]) => item !== undefined && item !== null && item !== '');
  const suffix = entries.length ? `{${entries.map(([key, item]) => `${key}="${prometheusEscape(item)}"`).join(',')}}` : '';
  return `${name}${suffix} ${Number.isFinite(Number(value)) ? value : 0}`;
}

function podAutoHealRetries(pod) {
  return Number.parseInt(pod?.metadata?.annotations?.[autoHealRetryAnnotation] || '0', 10) || 0;
}

function jobAutoHealRetries(job) {
  return Number.parseInt(job?.metadata?.annotations?.[autoHealRetryAnnotation] || '0', 10) || 0;
}

async function collectClusterMetrics(config = null) {
  const activeConfig = config || await readConfig();
  const label = `${appLabelName}=${appLabelValue}`;
  try {
    const [podsJson, jobsJson, schedulesJson] = await Promise.all([
      kubectlJson(activeConfig, ['get', 'pods', '-A', '-l', label]),
      kubectlJson(activeConfig, ['get', 'jobs', '-A', '-l', label]),
      kubectlJson(activeConfig, ['get', 'cronjobs', '-A', '-l', `${appLabelName}=${appLabelValue},${appLabelComponent}=schedule`])
    ]);
    metricsState.cluster = {
      lastScrapeAt: new Date().toISOString(),
      lastSuccess: true,
      lastError: '',
      pods: (podsJson.items || [])
        .filter((pod) => ['on-demand-backup', 'schedule'].includes(pod.metadata?.labels?.[appLabelComponent] || ''))
        .map((pod) => ({
        namespace: pod.metadata?.namespace || '',
        name: pod.metadata?.name || '',
        component: pod.metadata?.labels?.[appLabelComponent] || '',
        pvc: pod.metadata?.labels?.['backup-pvc'] || '',
        phase: pod.status?.phase || 'Unknown',
        retries: podAutoHealRetries(pod)
      })),
      jobs: (jobsJson.items || []).map((job) => ({
        namespace: job.metadata?.namespace || '',
        name: job.metadata?.name || '',
        component: job.metadata?.labels?.[appLabelComponent] || '',
        pvc: job.metadata?.labels?.['backup-pvc'] || '',
        status: Number(job.status?.failed || 0) > 0 ? 'failed' : Number(job.status?.active || 0) > 0 ? 'active' : Number(job.status?.succeeded || 0) > 0 ? 'succeeded' : 'unknown',
        retries: jobAutoHealRetries(job)
      })),
      schedules: (schedulesJson.items || []).map((schedule) => ({
        namespace: schedule.metadata?.namespace || '',
        name: schedule.metadata?.name || '',
        pvc: schedule.metadata?.labels?.['backup-pvc'] || '',
        suspended: Boolean(schedule.spec?.suspend)
      }))
    };
  } catch (error) {
    metricsState.cluster.lastScrapeAt = new Date().toISOString();
    metricsState.cluster.lastSuccess = false;
    metricsState.cluster.lastError = error.message || String(error);
  }
  return metricsState.cluster;
}

async function metricsSnapshot() {
  const config = await readConfig().catch(() => null);
  if (config?.clusterId || config?.id) await collectClusterMetrics(config);
  metricsState.autoHeal.enabled = Boolean(config?.autoHealEnabled);
  metricsState.autoHeal.maxRetries = Number.parseInt(normalizeAutoHealRetries(config?.autoHealRetries), 10);
  return {
    process: {
      startedAt: new Date(metricsState.startedAt).toISOString(),
      uptimeSeconds: Math.round(process.uptime()),
      memory: process.memoryUsage()
    },
    config: {
      clusterName: config?.clusterName || '',
      clusterId: config?.clusterId || config?.id || '',
      autoHealEnabled: Boolean(config?.autoHealEnabled),
      autoHealRetries: normalizeAutoHealRetries(config?.autoHealRetries)
    },
    jobs: [...jobs.values()].map((job) => ({ id: job.id, type: job.type, status: job.status, startedAt: job.startedAt, finishedAt: job.finishedAt })),
    backupSlots: {
      limit: Number.parseInt(normalizeBackupConcurrency(config?.backupConcurrency), 10),
      active: backupSlots.active,
      queued: backupSlots.queue.length
    },
    autoHeal: {
      running: metricsState.autoHeal.running,
      enabled: metricsState.autoHeal.enabled,
      maxRetries: metricsState.autoHeal.maxRetries,
      runs: metricsState.autoHeal.runs,
      lastRunAt: metricsState.autoHeal.lastRunAt,
      lastSuccess: metricsState.autoHeal.lastSuccess,
      lastError: metricsState.autoHeal.lastError,
      actions: Object.fromEntries(metricsState.autoHeal.actions),
      exhausted: Object.fromEntries(metricsState.autoHeal.exhausted)
    },
    cluster: metricsState.cluster
  };
}

async function prometheusMetrics() {
  const snapshot = await metricsSnapshot();
  const lines = [
    '# HELP qbackup_up qbackup process health.',
    '# TYPE qbackup_up gauge',
    prometheusLine('qbackup_up', {}, 1),
    '# HELP qbackup_process_uptime_seconds qbackup process uptime.',
    '# TYPE qbackup_process_uptime_seconds gauge',
    prometheusLine('qbackup_process_uptime_seconds', {}, snapshot.process.uptimeSeconds),
    '# HELP qbackup_process_memory_bytes qbackup process memory usage.',
    '# TYPE qbackup_process_memory_bytes gauge',
    prometheusLine('qbackup_process_memory_bytes', { kind: 'rss' }, snapshot.process.memory.rss),
    prometheusLine('qbackup_process_memory_bytes', { kind: 'heap_used' }, snapshot.process.memory.heapUsed),
    '# HELP qbackup_autoheal_enabled Whether auto-healing is enabled.',
    '# TYPE qbackup_autoheal_enabled gauge',
    prometheusLine('qbackup_autoheal_enabled', {}, snapshot.config.autoHealEnabled ? 1 : 0),
    '# HELP qbackup_autoheal_max_retries Configured maximum auto-heal retries.',
    '# TYPE qbackup_autoheal_max_retries gauge',
    prometheusLine('qbackup_autoheal_max_retries', {}, Number(snapshot.config.autoHealRetries)),
    '# HELP qbackup_autoheal_runs_total Number of auto-heal monitor passes.',
    '# TYPE qbackup_autoheal_runs_total counter',
    prometheusLine('qbackup_autoheal_runs_total', {}, snapshot.autoHeal.runs),
    '# HELP qbackup_autoheal_last_run_success Last auto-heal run result.',
    '# TYPE qbackup_autoheal_last_run_success gauge',
    prometheusLine('qbackup_autoheal_last_run_success', {}, snapshot.autoHeal.lastSuccess ? 1 : 0),
    '# HELP qbackup_cluster_scrape_success Last Kubernetes metrics scrape result.',
    '# TYPE qbackup_cluster_scrape_success gauge',
    prometheusLine('qbackup_cluster_scrape_success', {}, snapshot.cluster.lastSuccess ? 1 : 0),
    '# HELP qbackup_http_requests_total HTTP requests by method, route, and status.',
    '# TYPE qbackup_http_requests_total counter'
  ];

  for (const [key, value] of metricsState.httpRequests) lines.push(prometheusLine('qbackup_http_requests_total', JSON.parse(key), value));
  lines.push('# HELP qbackup_http_request_duration_seconds HTTP request duration histogram.');
  lines.push('# TYPE qbackup_http_request_duration_seconds histogram');
  const histogramCounts = new Map();
  for (const [key, value] of metricsState.httpDurations) {
    const labels = JSON.parse(key);
    if (labels.le === '_sum') {
      const { le, ...rest } = labels;
      lines.push(prometheusLine('qbackup_http_request_duration_seconds_sum', rest, value));
    } else if (labels.le === '+Inf') {
      const { le, ...rest } = labels;
      histogramCounts.set(JSON.stringify(rest), value);
      lines.push(prometheusLine('qbackup_http_request_duration_seconds_bucket', labels, value));
    } else {
      lines.push(prometheusLine('qbackup_http_request_duration_seconds_bucket', labels, value));
    }
  }
  for (const [key, value] of histogramCounts) lines.push(prometheusLine('qbackup_http_request_duration_seconds_count', JSON.parse(key), value));

  lines.push('# HELP qbackup_async_jobs In-memory qbackup async jobs by status.');
  lines.push('# TYPE qbackup_async_jobs gauge');
  const asyncJobCounts = new Map();
  for (const job of snapshot.jobs) incrementMetric(asyncJobCounts, { type: job.type, status: job.status });
  for (const [key, value] of asyncJobCounts) lines.push(prometheusLine('qbackup_async_jobs', JSON.parse(key), value));
  lines.push('# HELP qbackup_backup_slots Shared on-demand backup slot budget.');
  lines.push('# TYPE qbackup_backup_slots gauge');
  lines.push(prometheusLine('qbackup_backup_slots', { state: 'limit' }, snapshot.backupSlots.limit));
  lines.push(prometheusLine('qbackup_backup_slots', { state: 'active' }, snapshot.backupSlots.active));
  lines.push(prometheusLine('qbackup_backup_slots', { state: 'queued' }, snapshot.backupSlots.queued));
  lines.push('# HELP qbackup_backup_pods qbackup-owned backup helper pods by phase.');
  lines.push('# TYPE qbackup_backup_pods gauge');
  for (const pod of snapshot.cluster.pods) lines.push(prometheusLine('qbackup_backup_pods', { namespace: pod.namespace, pod: pod.name, component: pod.component, pvc: pod.pvc, phase: pod.phase }, 1));
  lines.push('# HELP qbackup_backup_pod_autoheal_retries Auto-heal retries recorded on qbackup pods.');
  lines.push('# TYPE qbackup_backup_pod_autoheal_retries gauge');
  for (const pod of snapshot.cluster.pods) lines.push(prometheusLine('qbackup_backup_pod_autoheal_retries', { namespace: pod.namespace, pod: pod.name, component: pod.component, pvc: pod.pvc }, pod.retries));
  lines.push('# HELP qbackup_backup_jobs qbackup-owned backup jobs by status.');
  lines.push('# TYPE qbackup_backup_jobs gauge');
  for (const job of snapshot.cluster.jobs) lines.push(prometheusLine('qbackup_backup_jobs', { namespace: job.namespace, job: job.name, component: job.component, pvc: job.pvc, status: job.status }, 1));
  lines.push('# HELP qbackup_schedule_cronjobs qbackup CronJob schedules.');
  lines.push('# TYPE qbackup_schedule_cronjobs gauge');
  for (const schedule of snapshot.cluster.schedules) lines.push(prometheusLine('qbackup_schedule_cronjobs', { namespace: schedule.namespace, cronjob: schedule.name, pvc: schedule.pvc, suspended: String(schedule.suspended) }, 1));
  lines.push('# HELP qbackup_autoheal_actions_total Auto-heal actions by kind and result.');
  lines.push('# TYPE qbackup_autoheal_actions_total counter');
  for (const [key, value] of metricsState.autoHeal.actions) lines.push(prometheusLine('qbackup_autoheal_actions_total', JSON.parse(key), value));
  lines.push('# HELP qbackup_autoheal_exhausted_total Resources that reached the retry limit.');
  lines.push('# TYPE qbackup_autoheal_exhausted_total counter');
  for (const [key, value] of metricsState.autoHeal.exhausted) lines.push(prometheusLine('qbackup_autoheal_exhausted_total', JSON.parse(key), value));
  return `${lines.join('\n')}\n`;
}

app.get('/api/status', async (_req, res) => {
  const kubectl = await commandExists('kubectl', ['version', '--client']);
  res.json({ kubectl, configFile, auth: await authMeta() });
});

app.get('/api/metrics', requireAuth(), async (_req, res, next) => {
  try {
    res.json(await metricsSnapshot());
  } catch (error) {
    next(error);
  }
});

app.get('/metrics', async (req, res, next) => {
  if (String(req.headers.accept || '').includes('text/html')) {
    res.sendFile(path.join(distDir, 'index.html'), (error) => {
      if (error) next();
    });
    return;
  }
  try {
    res.setHeader('Content-Type', 'text/plain; version=0.0.4; charset=utf-8');
    res.send(await prometheusMetrics());
  } catch (error) {
    next(error);
  }
});

app.get('/api/healthz', (_req, res) => {
  res.json({ ok: true });
});

app.get('/api/readyz', async (_req, res, next) => {
  try {
    await fs.mkdir(configDir, { recursive: true });
    const meta = await authMeta();
    res.json({ ok: true, configDir, auth: { dataFile: meta.dataFile, userCount: meta.userCount } });
  } catch (error) {
    next(error);
  }
});

app.get('/api/auth/bootstrap', async (_req, res, next) => {
  try {
    res.json({ needsSetup: (await countUsers()) === 0 });
  } catch (error) {
    next(error);
  }
});

app.post('/api/auth/bootstrap', async (req, res, next) => {
  try {
    if ((await countUsers()) > 0) return res.status(409).json({ error: 'Setup already complete.' });
    const user = await createUser({ ...req.body, role: 'admin' });
    const session = await createSession(user.id);
    await logAudit('auth.bootstrap', user.id, { username: user.username });
    setSessionCookie(req, res, session.token);
    res.json({ user: toPublicUser(user) });
  } catch (error) {
    next(error);
  }
});

app.post('/api/auth/login', rateLimit({ windowMs: 15 * 60 * 1000, max: 8, keyPrefix: 'login' }), async (req, res, next) => {
  try {
    const user = await verifyPassword(req.body.username, req.body.password);
    if (!user) return res.status(401).json({ error: 'Invalid credentials' });
    const session = await createSession(user.id);
    await logAudit('auth.login', user.id, { username: user.username, method: 'password' });
    setSessionCookie(req, res, session.token);
    res.json({ user: toPublicUser(user) });
  } catch (error) {
    next(error);
  }
});

app.post('/api/auth/logout', requireAuth(), async (req, res, next) => {
  try {
    await logAudit('auth.logout', req.user.id, { username: req.user.username });
    await deleteSession(req.sessionToken);
    clearSessionCookie(req, res);
    res.json({ ok: true });
  } catch (error) {
    next(error);
  }
});

app.get('/api/auth/me', requireAuth(), (req, res) => {
  res.json({ user: toPublicUser(req.user) });
});

app.patch('/api/auth/profile', requireAuth(), async (req, res, next) => {
  try {
    const user = await updateUser(req.user.id, {
      username: req.body.username,
      firstName: req.body.firstName,
      lastName: req.body.lastName,
      email: req.body.email,
      password: req.body.password
    });
    await logAudit('auth.profile.update', req.user.id, { fields: Object.keys(req.body).filter((key) => key !== 'password') });
    res.json({ user: toPublicUser(user) });
  } catch (error) {
    next(error);
  }
});

app.get('/api/users', requireAuth('users.manage'), async (_req, res, next) => {
  try {
    res.json({ users: (await listUsers()).map(toPublicUser) });
  } catch (error) {
    next(error);
  }
});

app.post('/api/users', requireAuth('users.manage'), async (req, res, next) => {
  try {
    const created = await createUser(req.body);
    await logAudit('users.create', req.user.id, { userId: created.id, username: created.username, role: created.role });
    res.json({ user: toPublicUser(created) });
  } catch (error) {
    next(error);
  }
});

app.patch('/api/users/:id', requireAuth('users.manage'), async (req, res, next) => {
  try {
    const existing = await getUserByUsername(req.body.username || '');
    if (existing && existing.id !== req.params.id) return res.status(409).json({ error: 'Username already exists.' });
    const updated = await updateUser(req.params.id, req.body);
    await logAudit('users.update', req.user.id, { userId: updated.id, username: updated.username, role: updated.role, passwordChanged: Boolean(req.body.password) });
    res.json({ user: toPublicUser(updated) });
  } catch (error) {
    next(error);
  }
});

app.delete('/api/users/:id', requireAuth('users.manage'), async (req, res, next) => {
  try {
    if (req.params.id === req.user.id) return res.status(400).json({ error: 'You cannot delete your own account.' });
    const deleted = await deleteUser(req.params.id);
    await logAudit('users.delete', req.user.id, { userId: deleted.id, username: deleted.username, role: deleted.role });
    res.json({ ok: true });
  } catch (error) {
    next(error);
  }
});

app.get('/api/audit', requireAuth('audit.read'), async (_req, res, next) => {
  try {
    res.json({ audit: await listAudit() });
  } catch (error) {
    next(error);
  }
});

app.get('/api/config', requireAuth(), async (_req, res, next) => {
  try {
    res.json(await readConfig());
  } catch (error) {
    next(error);
  }
});

app.put('/api/config', requireAuth('settings.write'), async (req, res, next) => {
  try {
    const current = await readConfig();
    const changingLiveExplorer = Object.prototype.hasOwnProperty.call(req.body || {}, 'liveFileExplorerEnabled')
      && Boolean(req.body.liveFileExplorerEnabled) !== Boolean(current.liveFileExplorerEnabled);
    if (changingLiveExplorer && !hasPermission(req.user, 'files.manage')) {
      return res.status(403).json({ error: 'Only admins can enable or disable the live file explorer.' });
    }
    const saved = await writeConfig(req.body);
    await logAudit('settings.update', req.user.id, { keys: Object.keys(req.body || {}) });
    res.json(saved);
  } catch (error) {
    next(error);
  }
});

app.get('/api/clusters', requireAuth(), async (_req, res, next) => {
  try {
    const config = await readConfig();
    res.json({ activeClusterId: config.activeClusterId, clusters: config.clusters });
  } catch (error) {
    next(error);
  }
});

app.post('/api/clusters', requireAuth('settings.write'), async (req, res, next) => {
  try {
    const saved = await addCluster(req.body || {});
    await logAudit('clusters.create', req.user.id, { clusterId: saved.activeClusterId, clusterName: saved.clusterName });
    res.status(201).json(saved);
  } catch (error) {
    next(error);
  }
});

app.put('/api/clusters/:id', requireAuth('settings.write'), async (req, res, next) => {
  try {
    const saved = await updateCluster(req.params.id, req.body || {});
    await logAudit('clusters.update', req.user.id, { clusterId: req.params.id, keys: Object.keys(req.body || {}) });
    res.json(saved);
  } catch (error) {
    next(error);
  }
});

app.delete('/api/clusters/:id', requireAuth('settings.write'), async (req, res, next) => {
  try {
    const saved = await deleteCluster(req.params.id);
    await logAudit('clusters.delete', req.user.id, { clusterId: req.params.id });
    res.json(saved);
  } catch (error) {
    next(error);
  }
});

app.post('/api/clusters/:id/switch', requireAuth('settings.write'), async (req, res, next) => {
  try {
    const saved = await switchCluster(req.params.id);
    await logAudit('clusters.switch', req.user.id, { clusterId: req.params.id });
    res.json(saved);
  } catch (error) {
    next(error);
  }
});

app.get('/api/pvcs', requireAuth(), async (_req, res, next) => {
  try {
    const config = await readConfig();
    const [json, podJson] = await Promise.all([
      kubectlJson(config, ['get', 'pvc', '-A']),
      kubectlJson(config, ['get', 'pods', '-A'])
    ]);
    const internalKeys = qbackupInternalPvcKeysFromPods(podJson.items || []);
    const pvcs = (json.items || []).sort((a, b) => `${a.metadata.namespace}/${a.metadata.name}`.localeCompare(`${b.metadata.namespace}/${b.metadata.name}`)).map((item) => ({
      id: `${item.metadata.namespace}/${item.metadata.name}`,
      namespace: item.metadata.namespace,
      name: item.metadata.name,
      phase: item.status?.phase || 'Unknown',
      sc: item.spec?.storageClassName || '-',
      access: [...(item.status?.accessModes || item.spec?.accessModes || [])].join(',') || '-',
      size: item.spec?.resources?.requests?.storage || '-',
      pv: item.spec?.volumeName || '-',
      qbackupInternal: internalKeys.has(`${item.metadata.namespace}/${item.metadata.name}`)
    }));
    res.json(pvcs);
  } catch (error) {
    next(error);
  }
});

app.get('/api/schedules', requireAuth(), async (_req, res, next) => {
  try {
    const config = await readConfig();
    const label = `${appLabelName}=${appLabelValue},${appLabelComponent}=schedule`;
    const [json, jobsJson, podsJson] = await Promise.all([
      kubectlJson(config, ['get', 'cronjobs', '-A', '-l', label]),
      kubectlJson(config, ['get', 'jobs', '-A', '-l', label]),
      kubectlJson(config, ['get', 'pods', '-A', '-l', label])
    ]);
    const schedules = (json.items || []).map((item) => ({
      item,
      namespace: item.metadata.namespace,
      name: item.metadata.name,
      pvc: item.metadata.labels?.['backup-pvc'] || '-'
    })).map(({ item, namespace, name, pvc }) => {
      const activeRefs = item.status?.active || [];
      const activeRefNames = activeRefs.map((ref) => ref.name).filter(Boolean);
      const matchingJobs = (jobsJson.items || []).filter((job) => {
        if (job.metadata.namespace !== namespace || job.metadata.deletionTimestamp) return false;
        const jobPvc = job.metadata.labels?.['backup-pvc'];
        const active = Number(job.status?.active || 0) > 0;
        return active && (activeRefNames.includes(job.metadata.name) || job.metadata.name.startsWith(`${name}-`) || job.metadata.name.startsWith(`manual-${name}-`) || jobPvc === pvc);
      });
      const matchingPods = (podsJson.items || []).filter((pod) => {
        if (pod.metadata.namespace !== namespace || pod.metadata.deletionTimestamp) return false;
        const podPvc = pod.metadata.labels?.['backup-pvc'];
        const phase = pod.status?.phase;
        return podPvc === pvc && ['Pending', 'Running'].includes(phase);
      });
      const activeJobs = [...new Set([...activeRefNames, ...matchingJobs.map((job) => job.metadata.name)])];
      const activePods = matchingPods.map((pod) => pod.metadata.name);
      return {
        id: `${namespace}/${name}`,
        namespace,
        name,
        pvc,
        schedule: item.spec?.schedule || '-',
        suspended: Boolean(item.spec?.suspend),
        lastRun: item.status?.lastScheduleTime || '-',
        backingUp: activeJobs.length > 0 || activePods.length > 0,
        activeJobs,
        activePods
      };
    });
    res.json(schedules);
  } catch (error) {
    next(error);
  }
});

app.post('/api/schedules', requireAuth('schedules.manage'), async (req, res, next) => {
  try {
    const config = await readConfig();
    const { pvcs = [], schedule = config.defaultSchedule } = req.body;
    if (!pvcs.length) return res.status(400).json({ error: 'Select at least one PVC.' });
    const concurrency = Number.parseInt(normalizeBackupConcurrency(config.backupConcurrency), 10);
    const results = [];
    let index = 0;
    for (const tag of pvcs) {
      const [namespace, pvc] = String(tag).split('/');
      if (!namespace || !pvc) throw new Error(`Invalid PVC tag: ${tag}`);
      await assertNotQbackupInternalPvc(config, namespace, pvc);
      const nodeName = await findPvcConsumerNode(config, namespace, pvc);
      const staggered = staggerSchedule(schedule, scheduleStaggerOffset(index++, concurrency));
      const output = await applyManifest(config, cronJobManifest(config, namespace, pvc, staggered, nodeName));
      results.push({ namespace, pvc, schedule: staggered, output });
    }
    // Opt-in only: a one-off cron for one PVC must not silently become the
    // default for everyone.
    if (req.body.saveAsDefault === true && hasPermission(req.user, 'settings.write')) {
      await writeConfig({ ...config, defaultSchedule: schedule });
    }
    await logAudit('schedules.create', req.user.id, { count: pvcs.length, schedule, savedAsDefault: req.body.saveAsDefault === true });
    res.json({ results });
  } catch (error) {
    next(error);
  }
});

app.delete('/api/schedules/:namespace/:name', requireAuth('schedules.manage'), async (req, res, next) => {
  try {
    const config = await readConfig();
    const { stdout, stderr } = await run('kubectl', kubectlArgs(config, ['delete', 'cronjob', '-n', req.params.namespace, req.params.name, '--ignore-not-found']));
    await logAudit('schedules.delete', req.user.id, { namespace: req.params.namespace, name: req.params.name });
    res.json({ output: stdout || stderr });
  } catch (error) {
    next(error);
  }
});

app.patch('/api/schedules/:namespace/:name', requireAuth('schedules.manage'), async (req, res, next) => {
  try {
    const config = await readConfig();
    const spec = {};
    if (Object.prototype.hasOwnProperty.call(req.body, 'suspended')) spec.suspend = Boolean(req.body.suspended);
    if (Object.prototype.hasOwnProperty.call(req.body, 'schedule')) {
      const schedule = String(req.body.schedule || '').trim();
      if (!schedule) return res.status(400).json({ error: 'Schedule is required.' });
      spec.schedule = schedule;
    }
    const current = await kubectlJson(config, ['get', 'cronjob', '-n', req.params.namespace, req.params.name]);
    const pvc = current.metadata?.labels?.['backup-pvc'];
    const nodeName = pvc ? await findPvcConsumerNode(config, req.params.namespace, pvc) : '';
    if (Object.keys(spec).length === 0) return res.status(400).json({ error: 'No schedule changes supplied.' });
    const patch = JSON.stringify({ spec });
    const { stdout, stderr } = await run('kubectl', kubectlArgs(config, ['patch', 'cronjob', '-n', req.params.namespace, req.params.name, '--type', 'merge', '-p', patch]));
    await patchCronJobSafety(config, req.params.namespace, req.params.name);
    await patchCronJobPlacement(config, req.params.namespace, req.params.name, nodeName);
    await logAudit('schedules.update', req.user.id, { namespace: req.params.namespace, name: req.params.name, ...spec });
    res.json({ output: stdout || stderr });
  } catch (error) {
    next(error);
  }
});

app.post('/api/schedules/:namespace/:name/run', requireAuth('schedules.manage'), async (req, res, next) => {
  try {
    const config = await readConfig();
    const current = await kubectlJson(config, ['get', 'cronjob', '-n', req.params.namespace, req.params.name]);
    const pvc = current.metadata?.labels?.['backup-pvc'];
    if (pvc) await assertNotQbackupInternalPvc(config, req.params.namespace, pvc);
    const nodeName = pvc ? await findPvcConsumerNode(config, req.params.namespace, pvc) : '';
    await patchCronJobSafety(config, req.params.namespace, req.params.name);
    await patchCronJobPlacement(config, req.params.namespace, req.params.name, nodeName);
    const jobName = k8sName('manual', req.params.name, Date.now().toString().slice(-8));
    const { stdout, stderr } = await run('kubectl', kubectlArgs(config, ['create', 'job', '-n', req.params.namespace, jobName, `--from=cronjob/${req.params.name}`]));
    await annotateAutoHealParent(config, req.params.namespace, 'job', jobName, req.params.name);
    await logAudit('schedules.run', req.user.id, { namespace: req.params.namespace, cronjob: req.params.name, job: jobName });
    res.json({ output: stdout || stderr });
  } catch (error) {
    next(error);
  }
});

app.post('/api/backups', requireAuth('backups.run'), async (req, res, next) => {
  try {
    const config = await readConfig();
    const tags = req.body.pvcs || [];
    if (!tags.length) return res.status(400).json({ error: 'Select at least one PVC.' });
    const internalKeys = await qbackupInternalPvcKeys(config);
    for (const tag of tags) {
      const [namespace, pvc] = String(tag).split('/');
      if (!namespace || !pvc) return res.status(400).json({ error: `Invalid PVC tag: ${tag}` });
      if (internalKeys.has(`${namespace}/${pvc}`)) {
        return res.status(400).json({ error: `PVC ${namespace}/${pvc} stores qbackup's own runtime data and cannot be backed up, scheduled, or restored by qbackup while the app is running.` });
      }
    }
    const job = createAsyncJob('backup', 'backups.run', async ({ append }) => {
      const concurrency = Number.parseInt(normalizeBackupConcurrency(config.backupConcurrency), 10);
      let nextIndex = 0;
      append(`[${new Date().toISOString()}] Running up to ${concurrency} backup(s) at the same time (limit is shared with any other backup running now).\n`);
      const worker = async () => {
        while (nextIndex < tags.length) {
          const tag = tags[nextIndex++];
          const [namespace, pvc] = String(tag).split('/');
          if (backupSlots.active >= concurrency) {
            append(`[${new Date().toISOString()}] Queued backup for ${namespace}/${pvc} until a backup slot is free\n`);
          }
          const releaseSlot = await acquireBackupSlot(concurrency);
          try {
            const podName = k8sName('backup', pvc, Date.now().toString().slice(-10));
            const nodeName = await findPvcConsumerNode(config, namespace, pvc);
            append(`[${new Date().toISOString()}] Starting backup for ${namespace}/${pvc}${nodeName ? ` on ${nodeName}` : ''}\n`);
            await runHelperPod(config, namespace, backupPodManifest(config, namespace, pvc, podName, nodeName), podName, append);
            append(`[${new Date().toISOString()}] Backup completed for ${namespace}/${pvc}\n`);
          } finally {
            releaseSlot();
          }
        }
      };
      await Promise.all(Array.from({ length: Math.min(concurrency, tags.length) }, () => worker()));
    });
    await logAudit('backups.run', req.user.id, { pvcs: tags, jobId: job.id });
    res.status(202).json(job);
  } catch (error) {
    next(error);
  }
});

app.get('/api/archives/:namespace/:pvc', requireAuth('restore.run'), async (req, res, next) => {
  try {
    const config = await readConfig();
    const podName = k8sName('archive-catalog', req.params.pvc, Date.now().toString().slice(-10));
    let output = '';
    output = await runHelperPod(
      config,
      req.params.namespace,
      archiveCatalogPodManifest(config, req.params.namespace, req.params.pvc, podName),
      podName,
      () => {},
      300
    );
    res.json(output.split(/\r?\n/).filter((line) => line.includes('\t')).map((line) => {
      const [name, size = 'unknown'] = line.split('\t');
      return { name, size };
    }));
  } catch (error) {
    next(error);
  }
});

app.post('/api/restore', requireAuth('restore.run'), async (req, res, next) => {
  try {
    const config = await readConfig();
    const { pvc, archive } = req.body;
    if (!pvc || !archive) return res.status(400).json({ error: 'PVC and archive are required.' });
    assertArchiveName(config, archive);
    const [namespace, pvcName] = String(pvc).split('/');
    if (!namespace || !pvcName) return res.status(400).json({ error: 'Invalid PVC.' });
    await assertNotQbackupInternalPvc(config, namespace, pvcName);
    const job = createAsyncJob('restore', 'restore.run', async ({ append }) => {
      const podName = k8sName('restore', pvcName, Date.now().toString().slice(-10));
      let restoreConsumers = async () => {};
      append(`[${new Date().toISOString()}] Starting restore for ${namespace}/${pvcName} from ${archive}\n`);
      try {
        const prepared = await prepareRestoreConsumers(config, namespace, pvcName, append);
        restoreConsumers = prepared.restore;
        await runHelperPod(config, namespace, restorePodManifest(config, namespace, pvcName, archive, podName, prepared.nodeName), podName, append);
        append(`[${new Date().toISOString()}] Restore completed for ${namespace}/${pvcName}\n`);
      } finally {
        await restoreConsumers();
      }
    });
    await logAudit('restore.run', req.user.id, { pvc, archive, jobId: job.id });
    res.status(202).json(job);
  } catch (error) {
    next(error);
  }
});

app.post('/api/file-restore/catalog', requireAuth('restore.run'), async (req, res, next) => {
  try {
    const config = await readConfig();
    const { pvc, archive } = req.body;
    if (!pvc || !archive) return res.status(400).json({ error: 'PVC and archive are required.' });
    assertArchiveName(config, archive);
    const [namespace, pvcName] = String(pvc).split('/');
    if (!namespace || !pvcName) return res.status(400).json({ error: 'Invalid PVC.' });
    const podName = k8sName('file-catalog', pvcName, Date.now().toString().slice(-10));
    const output = await runHelperPod(
      config,
      namespace,
      fileRestoreCatalogPodManifest(config, namespace, pvcName, archive, podName),
      podName,
      () => {},
      300
    );
    const entries = output.split(/\r?\n/)
      .map(parseTarListEntry)
      .filter(Boolean);
    res.json({ entries });
  } catch (error) {
    next(error);
  }
});

app.post('/api/file-restore/download', requireAuth('restore.run'), async (req, res, next) => {
  let config;
  let namespace;
  let podName;
  try {
    config = await readConfig();
    const { pvc, archive } = req.body;
    if (!pvc || !archive) return res.status(400).json({ error: 'PVC and archive are required.' });
    assertArchiveName(config, archive);
    const selectedPath = normalizeRestorePath(req.body.path);
    const [pvcNamespace, pvcName] = String(pvc).split('/');
    namespace = pvcNamespace;
    if (!namespace || !pvcName) return res.status(400).json({ error: 'Invalid PVC.' });

    podName = k8sName('file-restore', pvcName, Date.now().toString().slice(-10));
    await applyManifest(config, fileRestorePodManifest(config, namespace, pvcName, archive, selectedPath, podName));
    await waitForFileRestoreReady(config, namespace, podName);

    const filename = zipDownloadName(pvcName, archive, selectedPath);
    await logAudit('file-restore.download', req.user.id, { pvc, archive, path: selectedPath, filename });
    res.setHeader('Content-Type', 'application/zip');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    await stream('kubectl', kubectlArgs(config, ['exec', '-n', namespace, podName, '--', 'cat', '/work/output.zip']), res);
    res.end();
  } catch (error) {
    if (res.headersSent) {
      res.destroy(error);
    } else {
      next(error);
    }
  } finally {
    if (config && namespace && podName) {
      await run('kubectl', kubectlArgs(config, ['delete', 'pod', '-n', namespace, podName, '--ignore-not-found', '--wait=false'])).catch(() => null);
    }
  }
});

app.post('/api/live-files/list', requireAuth('files.manage'), async (req, res, next) => {
  try {
    const config = await readConfig();
    assertLiveFileExplorerEnabled(config);
    const { pvc } = req.body;
    const selectedPath = normalizePvcFilePath(req.body.path);
    const [namespace, pvcName] = String(pvc || '').split('/');
    if (!namespace || !pvcName) return res.status(400).json({ error: 'Invalid PVC.' });
    const output = await withLiveFileHelper(config, namespace, pvcName, true, async (podName) => {
      const script = `
        base="/target"
        dir="$base"
        if [ "$FILE_PATH" != "." ]; then dir="$base/$FILE_PATH"; fi
        test -d "$dir"
        find "$dir" -mindepth 1 -maxdepth 1 -exec sh -c '
          for item do
            [ -e "$item" ] || continue
            name="$(basename "$item")"
            if [ -d "$item" ]; then type="directory"; size="-"; else type="file"; size="$(stat -c "%s" "$item")"; fi
            modified="$(stat -c "%Y" "$item")"
            printf "%s\\t%s\\t%s\\t%s\\n" "$name" "$type" "$size" "$modified"
          done
        ' sh {} +
      `;
      const { stdout } = await run('kubectl', kubectlArgs(config, ['exec', '-n', namespace, podName, '--', 'env', `FILE_PATH=${selectedPath}`, 'sh', '-ceu', script]));
      return stdout;
    });
    res.json({ path: selectedPath, entries: parseLiveFileRows(output, selectedPath) });
  } catch (error) {
    next(error);
  }
});

app.post('/api/live-files/read', requireAuth('files.manage'), async (req, res, next) => {
  try {
    const config = await readConfig();
    assertLiveFileExplorerEnabled(config);
    const { pvc } = req.body;
    const selectedPath = normalizePvcFilePath(req.body.path);
    if (selectedPath === '.') return res.status(400).json({ error: 'Select a file to open.' });
    const [namespace, pvcName] = String(pvc || '').split('/');
    if (!namespace || !pvcName) return res.status(400).json({ error: 'Invalid PVC.' });
    const content = await withLiveFileHelper(config, namespace, pvcName, true, async (podName) => {
      const script = `
        file="/target/$FILE_PATH"
        test -f "$file"
        size="$(stat -c "%s" "$file")"
        if [ "$size" -gt 1048576 ]; then
          echo "Files larger than 1 MiB are download-only." >&2
          exit 4
        fi
        if [ "$size" -gt 0 ] && ! grep -Iq . "$file"; then
          echo "Binary files are download-only." >&2
          exit 5
        fi
        cat "$file"
      `;
      const { stdout } = await run('kubectl', kubectlArgs(config, ['exec', '-n', namespace, podName, '--', 'env', `FILE_PATH=${selectedPath}`, 'sh', '-ceu', script]));
      return stdout;
    });
    await logAudit('live-files.read', req.user.id, { pvc, path: selectedPath });
    res.json({ path: selectedPath, content });
  } catch (error) {
    next(error);
  }
});

app.post('/api/live-files/write', requireAuth('files.manage'), async (req, res, next) => {
  try {
    const config = await readConfig();
    assertLiveFileExplorerEnabled(config);
    const { pvc } = req.body;
    const selectedPath = normalizePvcFilePath(req.body.path);
    const content = String(req.body.content ?? '');
    if (selectedPath === '.') return res.status(400).json({ error: 'Select a file to save.' });
    if (content.length > 1024 * 1024) return res.status(400).json({ error: 'File editor saves are limited to 1 MiB.' });
    const [namespace, pvcName] = String(pvc || '').split('/');
    if (!namespace || !pvcName) return res.status(400).json({ error: 'Invalid PVC.' });
    await withLiveFileHelper(config, namespace, pvcName, false, async (podName) => {
      const script = 'file="/target/$FILE_PATH"; test -f "$file"; cat > "$file"';
      await runWithInput('kubectl', kubectlArgs(config, ['exec', '-i', '-n', namespace, podName, '--', 'env', `FILE_PATH=${selectedPath}`, 'sh', '-ceu', script]), content);
    });
    await logAudit('live-files.write', req.user.id, { pvc, path: selectedPath, bytes: Buffer.byteLength(content) });
    res.json({ ok: true });
  } catch (error) {
    next(error);
  }
});

app.post('/api/live-files/create-file', requireAuth('files.manage'), async (req, res, next) => {
  try {
    const config = await readConfig();
    assertLiveFileExplorerEnabled(config);
    const { pvc } = req.body;
    const parentPath = normalizePvcFilePath(req.body.parentPath);
    const name = normalizePvcEntryName(req.body.name);
    const [namespace, pvcName] = String(pvc || '').split('/');
    if (!namespace || !pvcName) return res.status(400).json({ error: 'Invalid PVC.' });
    const filePath = parentPath === '.' ? name : `${parentPath}/${name}`;
    await withLiveFileHelper(config, namespace, pvcName, false, async (podName) => {
      const script = `
        parent="/target/$PARENT_PATH"
        [ "$PARENT_PATH" = "." ] && parent="/target"
        if [ ! -d "$parent" ]; then
          echo "Parent folder does not exist: $PARENT_PATH" >&2
          exit 2
        fi
        target="$parent/$ENTRY_NAME"
        if [ -e "$target" ]; then
          echo "File or folder already exists: $ENTRY_NAME" >&2
          exit 3
        fi
        touch "$target"
      `;
      await run('kubectl', kubectlArgs(config, ['exec', '-n', namespace, podName, '--', 'env', `PARENT_PATH=${parentPath}`, `ENTRY_NAME=${name}`, 'sh', '-ceu', script]));
    });
    await logAudit('live-files.create-file', req.user.id, { pvc, path: filePath });
    res.json({ ok: true, path: filePath });
  } catch (error) {
    next(error);
  }
});

app.post('/api/live-files/create-folder', requireAuth('files.manage'), async (req, res, next) => {
  try {
    const config = await readConfig();
    assertLiveFileExplorerEnabled(config);
    const { pvc } = req.body;
    const parentPath = normalizePvcFilePath(req.body.parentPath);
    const name = normalizePvcEntryName(req.body.name);
    const [namespace, pvcName] = String(pvc || '').split('/');
    if (!namespace || !pvcName) return res.status(400).json({ error: 'Invalid PVC.' });
    const folderPath = parentPath === '.' ? name : `${parentPath}/${name}`;
    await withLiveFileHelper(config, namespace, pvcName, false, async (podName) => {
      const script = `
        parent="/target/$PARENT_PATH"
        [ "$PARENT_PATH" = "." ] && parent="/target"
        if [ ! -d "$parent" ]; then
          echo "Parent folder does not exist: $PARENT_PATH" >&2
          exit 2
        fi
        target="$parent/$ENTRY_NAME"
        if [ -e "$target" ]; then
          echo "File or folder already exists: $ENTRY_NAME" >&2
          exit 3
        fi
        mkdir "$target"
      `;
      await run('kubectl', kubectlArgs(config, ['exec', '-n', namespace, podName, '--', 'env', `PARENT_PATH=${parentPath}`, `ENTRY_NAME=${name}`, 'sh', '-ceu', script]));
    });
    await logAudit('live-files.create-folder', req.user.id, { pvc, path: folderPath });
    res.json({ ok: true, path: folderPath });
  } catch (error) {
    next(error);
  }
});

app.post('/api/live-files/rename', requireAuth('files.manage'), async (req, res, next) => {
  try {
    const config = await readConfig();
    assertLiveFileExplorerEnabled(config);
    const { pvc } = req.body;
    const selectedPath = normalizePvcFilePath(req.body.path);
    const name = normalizePvcEntryName(req.body.name);
    if (selectedPath === '.') return res.status(400).json({ error: 'Cannot rename the PVC root.' });
    const [namespace, pvcName] = String(pvc || '').split('/');
    if (!namespace || !pvcName) return res.status(400).json({ error: 'Invalid PVC.' });
    const nextPath = selectedPath.includes('/') ? `${selectedPath.split('/').slice(0, -1).join('/')}/${name}` : name;
    await withLiveFileHelper(config, namespace, pvcName, false, async (podName) => {
      const script = 'source="/target/$FILE_PATH"; parent="$(dirname "$source")"; target="$parent/$ENTRY_NAME"; test -e "$source"; test ! -e "$target"; mv "$source" "$target"';
      await run('kubectl', kubectlArgs(config, ['exec', '-n', namespace, podName, '--', 'env', `FILE_PATH=${selectedPath}`, `ENTRY_NAME=${name}`, 'sh', '-ceu', script]));
    });
    await logAudit('live-files.rename', req.user.id, { pvc, from: selectedPath, to: nextPath });
    res.json({ ok: true, path: nextPath });
  } catch (error) {
    next(error);
  }
});

app.post('/api/live-files/delete', requireAuth('files.manage'), async (req, res, next) => {
  try {
    const config = await readConfig();
    assertLiveFileExplorerEnabled(config);
    const { pvc } = req.body;
    const selectedPath = normalizePvcFilePath(req.body.path);
    if (selectedPath === '.') return res.status(400).json({ error: 'Cannot delete the PVC root.' });
    const [namespace, pvcName] = String(pvc || '').split('/');
    if (!namespace || !pvcName) return res.status(400).json({ error: 'Invalid PVC.' });
    await withLiveFileHelper(config, namespace, pvcName, false, async (podName) => {
      const script = 'target="/target/$FILE_PATH"; test -e "$target"; rm -rf "$target"';
      await run('kubectl', kubectlArgs(config, ['exec', '-n', namespace, podName, '--', 'env', `FILE_PATH=${selectedPath}`, 'sh', '-ceu', script]));
    });
    await logAudit('live-files.delete', req.user.id, { pvc, path: selectedPath });
    res.json({ ok: true });
  } catch (error) {
    next(error);
  }
});

app.post('/api/live-files/download', requireAuth('files.manage'), async (req, res, next) => {
  let config;
  let namespace;
  let podName;
  try {
    config = await readConfig();
    assertLiveFileExplorerEnabled(config);
    const { pvc } = req.body;
    const selectedPath = normalizePvcFilePath(req.body.path);
    const [pvcNamespace, pvcName] = String(pvc || '').split('/');
    namespace = pvcNamespace;
    if (!namespace || !pvcName) return res.status(400).json({ error: 'Invalid PVC.' });
    podName = k8sName('live-download', pvcName, Date.now().toString().slice(-10));
    const nodeName = await findPvcConsumerNode(config, namespace, pvcName);
    await applyManifest(config, liveFileDownloadPodManifest(config, namespace, pvcName, selectedPath, podName, nodeName));
    await waitForFileRestoreReady(config, namespace, podName);
    const filename = zipDownloadName(pvcName, 'live-files.tgz', selectedPath);
    await logAudit('live-files.download', req.user.id, { pvc, path: selectedPath, filename });
    res.setHeader('Content-Type', 'application/zip');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    await stream('kubectl', kubectlArgs(config, ['exec', '-n', namespace, podName, '--', 'cat', '/work/output.zip']), res);
    res.end();
  } catch (error) {
    if (res.headersSent) {
      res.destroy(error);
    } else {
      next(error);
    }
  } finally {
    if (config && namespace && podName) {
      await run('kubectl', kubectlArgs(config, ['delete', 'pod', '-n', namespace, podName, '--ignore-not-found', '--wait=false'])).catch(() => null);
    }
  }
});

app.get('/api/jobs/:id', requireAuth(), (req, res) => {
  const job = jobs.get(req.params.id);
  if (!job) return res.status(404).json({ error: 'Job not found.' });
  if (job.permission && !hasPermission(req.user, job.permission)) return res.status(401).json({ error: 'Unauthorized' });
  res.json(job);
});

app.get('/events/jobs/:id', requireAuth(), (req, res) => {
  const initialJob = jobs.get(req.params.id);
  if (initialJob?.permission && !hasPermission(req.user, initialJob.permission)) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  let sent = 0;
  const send = () => {
    const job = jobs.get(req.params.id);
    if (!job) {
      res.write(`event: error\ndata: ${JSON.stringify({ error: 'Job not found.' })}\n\n`);
      res.end();
      return;
    }
    // `sent` counts absolute lines, so trimmed-away output does not resend or skip.
    const nextOutput = job.output.slice(Math.max(0, sent - job.droppedOutput));
    sent = job.droppedOutput + job.output.length;
    res.write(`data: ${JSON.stringify({ ...job, output: nextOutput })}\n\n`);
    if (job.status !== 'running') {
      clearInterval(interval);
      res.end();
    }
  };
  const interval = setInterval(send, 1000);
  send();
  req.on('close', () => clearInterval(interval));
});

app.use(express.static(distDir));
app.use((req, res, next) => {
  if (req.method !== 'GET' || req.path.startsWith('/api/') || req.path.startsWith('/events/')) {
    next();
    return;
  }
  res.sendFile(path.join(distDir, 'index.html'), (error) => {
    if (error) next();
  });
});

app.use((error, _req, res, _next) => {
  res.status(error.status || 500).json({ error: error.message, details: error.stderr || error.stdout });
});

app.listen(port, () => {
  console.log(`qbackup API listening on http://localhost:${port}`);
  refreshSchedulePlacements();
  setInterval(refreshSchedulePlacements, schedulePlacementRefreshMs).unref();
  runAutoHeal();
  setInterval(runAutoHeal, Number.isFinite(autoHealIntervalMs) ? autoHealIntervalMs : 30000).unref();
  setInterval(sweepEphemeralState, stateSweepIntervalMs).unref();
});
