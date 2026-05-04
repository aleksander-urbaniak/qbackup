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
const jobs = new Map();
const rateBuckets = new Map();

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
  localNfsPreflight: envString('LOCAL_NFS_PREFLIGHT', 'mount')
};

if (['true', '1', 'yes'].includes(String(process.env.QBACKUP_TRUST_PROXY || '').toLowerCase())) {
  app.set('trust proxy', 1);
}

app.disable('x-powered-by');
app.use(express.json({ limit: '1mb' }));

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
    LOCAL_NFS_PREFLIGHT: 'localNfsPreflight'
  }[key];
}

function boolFromEnv(value) {
  return String(value).toLowerCase() === 'true';
}

function normalizeBackupConcurrency(value) {
  const parsed = Number.parseInt(String(value ?? defaults.backupConcurrency), 10);
  return String(Number.isFinite(parsed) ? Math.min(Math.max(parsed, 1), 20) : 1);
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
      else if (setting === 'keepFailedPods' || setting === 'scaleConsumers') config[setting] = boolFromEnv(value);
      else if (setting === 'backupConcurrency') config[setting] = normalizeBackupConcurrency(value);
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

async function deleteCluster(id) {
  const store = await readClusterStore();
  const clusters = store.clusters.filter((cluster) => cluster.id !== id);
  if (clusters.length === store.clusters.length) {
    const error = new Error('Cluster not found.');
    error.status = 404;
    throw error;
  }
  const activeClusterId = clusters.length === 0 ? '' : store.activeClusterId === id ? clusters[0].id : store.activeClusterId;
  await writeClusterStore({ activeClusterId, clusters });
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

function yamlString(value) {
  return JSON.stringify(String(value ?? ''));
}

function podPlacementYaml(nodeName, indent) {
  return nodeName ? `${' '.repeat(indent)}nodeName: ${yamlString(nodeName)}\n` : '';
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

async function pvcConsumerPods(config, namespace, pvc) {
  const json = await kubectlJson(config, ['get', 'pods', '-n', namespace]);
  return (json.items || []).filter((pod) => {
    if (pod.metadata.deletionTimestamp) return false;
    if (pod.metadata.labels?.[appLabelName] === appLabelValue) return false;
    return podUsesPvc(pod, pvc);
  });
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
  concurrencyPolicy: Forbid
  successfulJobsHistoryLimit: 1
  failedJobsHistoryLimit: 3
  jobTemplate:
    spec:
      backoffLimit: 0
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
                  set -euo pipefail
                  stamp="$(date +%Y%m%d%H%M%S)"
                  target="/backup/\${BACKUP_ROOT}/\${CLUSTER_NAME}/\${PVC_NAMESPACE}/\${PVC_NAME}"
                  mkdir -p "$target"
                  tar -czf "$target/\${stamp}.\${ARCHIVE_EXTENSION}" -C /source .
                  if [ "$ENABLE_RETENTION" = "true" ]; then
                    find "$target" -type f -name "*.\${ARCHIVE_EXTENSION}" -mtime "+\${RETENTION_DAYS}" -delete
                  fi
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

function createAsyncJob(type, executor) {
  const id = crypto.randomUUID();
  const job = { id, type, status: 'running', startedAt: new Date().toISOString(), finishedAt: null, code: null, output: [] };
  jobs.set(id, job);
  const append = (text, stream = 'stdout') => {
    job.output.push({ ts: new Date().toISOString(), stream, text: String(text) });
  };
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
          set -euo pipefail
          stamp="$(date +%Y%m%d%H%M%S)"
          target="/backup/\${BACKUP_ROOT}/\${CLUSTER_NAME}/\${PVC_NAMESPACE}/\${PVC_NAME}"
          mkdir -p "$target"
          tar -czf "$target/\${stamp}.\${ARCHIVE_EXTENSION}" -C /source .
          if [ "$ENABLE_RETENTION" = "true" ]; then
            find "$target" -maxdepth 1 -type f -name "*.\${ARCHIVE_EXTENSION}" -mtime "+\${RETENTION_DAYS}" -delete
          fi
          echo "archive=\${target}/\${stamp}.\${ARCHIVE_EXTENSION}"
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

async function runHelperPod(config, namespace, manifest, podName, append = () => {}, timeoutSeconds = 1800) {
  append(`[${new Date().toISOString()}] Creating helper Pod ${namespace}/${podName}\n`);
  append(await applyManifest(config, manifest));
  const phase = await waitForPodCompletion(config, namespace, podName, append, timeoutSeconds);
  const logs = await run('kubectl', kubectlArgs(config, ['logs', '-n', namespace, podName])).then((result) => result.stdout || result.stderr).catch((error) => error.stdout || error.stderr || '');
  if (logs) append(logs.endsWith('\n') ? logs : `${logs}\n`);
  await run('kubectl', kubectlArgs(config, ['delete', 'pod', '-n', namespace, podName, '--ignore-not-found', '--wait=false'])).catch(() => null);
  if (phase !== 'Succeeded') throw new Error(`Helper Pod ${namespace}/${podName} finished with phase=${phase}`);
  return logs;
}

app.get('/api/status', async (_req, res) => {
  const kubectl = await commandExists('kubectl', ['version', '--client']);
  res.json({ kubectl, configFile, auth: await authMeta() });
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

app.post('/api/clusters/:id/switch', requireAuth(), async (req, res, next) => {
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
    const json = await kubectlJson(config, ['get', 'pvc', '-A']);
    const pvcs = (json.items || []).sort((a, b) => `${a.metadata.namespace}/${a.metadata.name}`.localeCompare(`${b.metadata.namespace}/${b.metadata.name}`)).map((item) => ({
      id: `${item.metadata.namespace}/${item.metadata.name}`,
      namespace: item.metadata.namespace,
      name: item.metadata.name,
      phase: item.status?.phase || 'Unknown',
      sc: item.spec?.storageClassName || '-',
      access: [...(item.status?.accessModes || item.spec?.accessModes || [])].join(',') || '-',
      size: item.spec?.resources?.requests?.storage || '-',
      pv: item.spec?.volumeName || '-'
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
    const results = [];
    for (const tag of pvcs) {
      const [namespace, pvc] = String(tag).split('/');
      if (!namespace || !pvc) throw new Error(`Invalid PVC tag: ${tag}`);
      const nodeName = await findPvcConsumerNode(config, namespace, pvc);
      const output = await applyManifest(config, cronJobManifest(config, namespace, pvc, schedule, nodeName));
      results.push({ namespace, pvc, output });
    }
    await writeConfig({ ...config, defaultSchedule: schedule });
    await logAudit('schedules.create', req.user.id, { count: pvcs.length, schedule });
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
    if (nodeName) spec.jobTemplate = { spec: { template: { spec: { nodeName } } } };
    if (Object.keys(spec).length === 0) return res.status(400).json({ error: 'No schedule changes supplied.' });
    const patch = JSON.stringify({ spec });
    const { stdout, stderr } = await run('kubectl', kubectlArgs(config, ['patch', 'cronjob', '-n', req.params.namespace, req.params.name, '--type', 'merge', '-p', patch]));
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
    const nodeName = pvc ? await findPvcConsumerNode(config, req.params.namespace, pvc) : '';
    if (nodeName) {
      const patch = JSON.stringify({ spec: { jobTemplate: { spec: { template: { spec: { nodeName } } } } } });
      await run('kubectl', kubectlArgs(config, ['patch', 'cronjob', '-n', req.params.namespace, req.params.name, '--type', 'merge', '-p', patch]));
    }
    const jobName = k8sName('manual', req.params.name, Date.now().toString().slice(-8));
    const { stdout, stderr } = await run('kubectl', kubectlArgs(config, ['create', 'job', '-n', req.params.namespace, jobName, `--from=cronjob/${req.params.name}`]));
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
    const job = createAsyncJob('backup', async ({ append }) => {
      const concurrency = Number.parseInt(normalizeBackupConcurrency(config.backupConcurrency), 10);
      let nextIndex = 0;
      append(`[${new Date().toISOString()}] Running up to ${concurrency} backup(s) at the same time.\n`);
      const worker = async () => {
        while (nextIndex < tags.length) {
          const tag = tags[nextIndex++];
        const [namespace, pvc] = String(tag).split('/');
        if (!namespace || !pvc) throw new Error(`Invalid PVC tag: ${tag}`);
        const podName = k8sName('backup', pvc, Date.now().toString().slice(-10));
          const nodeName = await findPvcConsumerNode(config, namespace, pvc);
          append(`[${new Date().toISOString()}] Starting backup for ${namespace}/${pvc}${nodeName ? ` on ${nodeName}` : ''}\n`);
          await runHelperPod(config, namespace, backupPodManifest(config, namespace, pvc, podName, nodeName), podName, append);
          append(`[${new Date().toISOString()}] Backup completed for ${namespace}/${pvc}\n`);
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
    if (!/^[A-Za-z0-9._-]+$/.test(archive) || archive.includes('..') || !archive.endsWith(`.${config.archiveExtension}`)) {
      return res.status(400).json({ error: 'Invalid archive name.' });
    }
    const [namespace, pvcName] = String(pvc).split('/');
    if (!namespace || !pvcName) return res.status(400).json({ error: 'Invalid PVC.' });
    const job = createAsyncJob('restore', async ({ append }) => {
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

app.get('/api/jobs/:id', requireAuth(), (req, res) => {
  const job = jobs.get(req.params.id);
  if (!job) return res.status(404).json({ error: 'Job not found.' });
  res.json(job);
});

app.get('/events/jobs/:id', requireAuth(), (req, res) => {
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
    const nextOutput = job.output.slice(sent);
    sent = job.output.length;
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
});
