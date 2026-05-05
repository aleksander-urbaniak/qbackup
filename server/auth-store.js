import bcrypt from 'bcryptjs';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const dataDir = path.join(process.env.XDG_DATA_HOME || path.join(os.homedir(), '.local', 'share'), 'qbackup');
const dataFile = path.join(dataDir, 'auth.json');
const legacyDataFile = path.join(process.env.XDG_DATA_HOME || path.join(os.homedir(), '.local', 'share'), 'k3s-pvc-backup-ui', 'auth.json');
const sessionTtlMs = 7 * 24 * 60 * 60 * 1000;
let dbWriteQueue = Promise.resolve();

export const roles = ['admin', 'manager', 'operator', 'auditor', 'viewer'];

const rolePermissions = {
  viewer: ['dashboard.read'],
  operator: ['dashboard.read', 'backups.run', 'restore.run', 'schedules.manage'],
  manager: ['dashboard.read', 'backups.run', 'restore.run', 'schedules.manage', 'settings.write'],
  auditor: ['dashboard.read', 'audit.read'],
  admin: ['dashboard.read', 'backups.run', 'restore.run', 'schedules.manage', 'settings.write', 'users.manage', 'audit.read', 'files.manage']
};

function emptyDb() {
  return { users: [], sessions: [], audit: [] };
}

function parseJsonPrefix(content) {
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let index = 0; index < content.length; index += 1) {
    const char = content[index];
    if (inString) {
      if (escaped) escaped = false;
      else if (char === '\\') escaped = true;
      else if (char === '"') inString = false;
      continue;
    }
    if (char === '"') inString = true;
    else if (char === '{' || char === '[') depth += 1;
    else if (char === '}' || char === ']') {
      depth -= 1;
      if (depth === 0) {
        const prefix = content.slice(0, index + 1);
        JSON.parse(prefix);
        return prefix;
      }
    }
  }
  return null;
}

function normalizeRole(role) {
  return roles.includes(role) ? role : 'viewer';
}

export function permissionsForRole(role) {
  return rolePermissions[normalizeRole(role)] || rolePermissions.viewer;
}

export function toPublicUser(user) {
  if (!user) return null;
  return {
    id: user.id,
    username: user.username,
    firstName: user.firstName || '',
    lastName: user.lastName || '',
    email: user.email || '',
    role: normalizeRole(user.role),
    permissions: permissionsForRole(user.role),
    createdAt: user.createdAt,
    updatedAt: user.updatedAt
  };
}

async function readDb() {
  try {
    let content;
    try {
      content = await fs.readFile(dataFile, 'utf8');
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
      content = await fs.readFile(legacyDataFile, 'utf8');
    }
    let parsed;
    try {
      parsed = JSON.parse(content);
    } catch (error) {
      const prefix = parseJsonPrefix(content);
      if (!prefix) throw error;
      parsed = JSON.parse(prefix);
      const backupFile = `${dataFile}.corrupt-${Date.now()}`;
      await fs.copyFile(dataFile, backupFile).catch(() => null);
      await writeDb({ ...emptyDb(), ...parsed });
    }
    return { ...emptyDb(), ...parsed };
  } catch (error) {
    if (error.code === 'ENOENT') return emptyDb();
    throw error;
  }
}

async function writeDb(db) {
  await fs.mkdir(dataDir, { recursive: true });
  const tempFile = `${dataFile}.${process.pid}.${Date.now()}.tmp`;
  await fs.writeFile(tempFile, `${JSON.stringify(db, null, 2)}\n`, { mode: 0o600 });
  await fs.rename(tempFile, dataFile);
  await fs.chmod(dataFile, 0o600).catch(() => null);
}

async function mutateDb(mutator) {
  const run = dbWriteQueue.then(async () => {
    const db = await readDb();
    const result = await mutator(db);
    await writeDb(db);
    return result;
  });
  dbWriteQueue = run.catch(() => null);
  return run;
}

export async function authMeta() {
  const db = await readDb();
  return { dataFile, userCount: db.users.length };
}

export async function countUsers() {
  const db = await readDb();
  return db.users.length;
}

export async function createUser(input) {
  return mutateDb((db) => {
    const username = String(input.username || '').trim();
    if (!username) throw new Error('Username is required.');
    if (db.users.some((user) => user.username.toLowerCase() === username.toLowerCase())) {
      const error = new Error('Username already exists.');
      error.status = 409;
      throw error;
    }
    const password = String(input.password || '');
    if (password.length < 8) {
      const error = new Error('Password must be at least 8 characters.');
      error.status = 400;
      throw error;
    }
    const now = new Date().toISOString();
    const user = {
      id: crypto.randomUUID(),
      username,
      firstName: String(input.firstName || '').trim(),
      lastName: String(input.lastName || '').trim(),
      email: String(input.email || '').trim(),
      passwordHash: bcrypt.hashSync(password, 10),
      role: normalizeRole(input.role),
      createdAt: now,
      updatedAt: now
    };
    db.users.push(user);
    return user;
  });
}

export async function listUsers() {
  const db = await readDb();
  return db.users.sort((a, b) => a.username.localeCompare(b.username));
}

export async function getUserByUsername(username) {
  const db = await readDb();
  return db.users.find((user) => user.username.toLowerCase() === String(username || '').trim().toLowerCase()) || null;
}

export async function getUserById(id) {
  const db = await readDb();
  return db.users.find((user) => user.id === id) || null;
}

export async function updateUser(id, updates) {
  return mutateDb((db) => {
    const user = db.users.find((entry) => entry.id === id);
    if (!user) {
      const error = new Error('User not found.');
      error.status = 404;
      throw error;
    }
    const nextUsername = String(updates.username ?? user.username).trim();
    if (!nextUsername) {
      const error = new Error('Username is required.');
      error.status = 400;
      throw error;
    }
    if (db.users.some((entry) => entry.id !== id && entry.username.toLowerCase() === nextUsername.toLowerCase())) {
      const error = new Error('Username already exists.');
      error.status = 409;
      throw error;
    }
    user.username = nextUsername;
    user.firstName = String(updates.firstName ?? user.firstName ?? '').trim();
    user.lastName = String(updates.lastName ?? user.lastName ?? '').trim();
    user.email = String(updates.email ?? user.email ?? '').trim();
    if (updates.role) user.role = normalizeRole(updates.role);
    if (updates.password) {
      const password = String(updates.password);
      if (password.length < 8) {
        const error = new Error('Password must be at least 8 characters.');
        error.status = 400;
        throw error;
      }
      user.passwordHash = bcrypt.hashSync(password, 10);
    }
    user.updatedAt = new Date().toISOString();
    return user;
  });
}

export async function deleteUser(id) {
  return mutateDb((db) => {
    const user = db.users.find((entry) => entry.id === id);
    if (!user) {
      const error = new Error('User not found.');
      error.status = 404;
      throw error;
    }
    db.users = db.users.filter((entry) => entry.id !== id);
    db.sessions = db.sessions.filter((session) => session.userId !== id);
    return user;
  });
}

export async function verifyPassword(username, password) {
  const user = await getUserByUsername(username);
  if (!user) return null;
  return bcrypt.compareSync(String(password || ''), user.passwordHash) ? user : null;
}

export async function createSession(userId) {
  return mutateDb((db) => {
    const session = {
      token: crypto.randomBytes(32).toString('hex'),
      userId,
      expiresAt: Date.now() + sessionTtlMs,
      createdAt: new Date().toISOString()
    };
    db.sessions.push(session);
    return session;
  });
}

export async function getUserBySession(token) {
  if (!token) return null;
  const db = await readDb();
  const session = db.sessions.find((entry) => entry.token === token);
  if (!session) return null;
  if (session.expiresAt < Date.now()) {
    await deleteSession(token);
    return null;
  }
  return db.users.find((user) => user.id === session.userId) || null;
}

export async function deleteSession(token) {
  if (!token) return;
  await mutateDb((db) => {
    db.sessions = db.sessions.filter((session) => session.token !== token);
  });
}

export async function logAudit(action, userId, details = {}) {
  await mutateDb((db) => {
    db.audit.unshift({
      id: crypto.randomUUID(),
      action,
      userId,
      details,
      createdAt: new Date().toISOString()
    });
    db.audit = db.audit.slice(0, 500);
  });
}

export async function listAudit() {
  const db = await readDb();
  return db.audit.slice(0, 200).map((entry) => ({
    ...entry,
    user: toPublicUser(db.users.find((user) => user.id === entry.userId))
  }));
}
