// Admin authentication: a single admin account whose password is stored as a
// salted scrypt hash in db.json, plus random session tokens held in memory
// (a server restart simply logs the admin out).
import crypto from 'crypto';
import { data, save } from './store.js';

const COOKIE = 'nv_admin';
const SESSION_TTL_MS = 8 * 60 * 60 * 1000;
const sessions = new Map(); // token -> expiresAt

// Login rate limiting: 5 failures per IP locks that IP out for 15 minutes.
const MAX_FAILURES = 5;
const LOCKOUT_MS = 15 * 60 * 1000;
const failures = new Map(); // ip -> { count, lockedUntil }

export function hashPassword(password, salt = crypto.randomBytes(16).toString('hex')) {
  const hash = crypto.scryptSync(password, salt, 64).toString('hex');
  return { salt, hash };
}

function verifyPassword(password, { salt, hash }) {
  const candidate = Buffer.from(hashPassword(password, salt).hash, 'hex');
  const expected = Buffer.from(hash, 'hex');
  return candidate.length === expected.length && crypto.timingSafeEqual(candidate, expected);
}

// Creates the admin account on first start from ADMIN_USERNAME/ADMIN_PASSWORD.
// If no password is configured a random one is generated and printed once.
export function ensureAdmin() {
  const db = data();
  if (db.admin) return;
  const username = process.env.ADMIN_USERNAME || 'admin';
  let password = process.env.ADMIN_PASSWORD;
  if (!password) {
    password = crypto.randomBytes(6).toString('base64url');
    console.log('\n================================================================');
    console.log(' No ADMIN_PASSWORD set - generated an admin account:');
    console.log(`   username: ${username}`);
    console.log(`   password: ${password}`);
    console.log(' Change it from the admin panel (Account tab) after logging in.');
    console.log('================================================================\n');
  }
  db.admin = { username, ...hashPassword(password) };
  save();
}

export function isLockedOut(ip) {
  const entry = failures.get(ip);
  return Boolean(entry && entry.lockedUntil > Date.now());
}

export function login(ip, username, password) {
  const admin = data().admin;
  const ok =
    typeof username === 'string' &&
    typeof password === 'string' &&
    username === admin.username &&
    verifyPassword(password, admin);
  if (!ok) {
    const entry = failures.get(ip) || { count: 0, lockedUntil: 0 };
    entry.count += 1;
    if (entry.count >= MAX_FAILURES) {
      entry.count = 0;
      entry.lockedUntil = Date.now() + LOCKOUT_MS;
    }
    failures.set(ip, entry);
    return null;
  }
  failures.delete(ip);
  const token = crypto.randomBytes(32).toString('hex');
  sessions.set(token, Date.now() + SESSION_TTL_MS);
  return token;
}

export function changePassword(current, next) {
  const db = data();
  if (!verifyPassword(current, db.admin)) return false;
  db.admin = { username: db.admin.username, ...hashPassword(next) };
  save();
  return true;
}

function tokenFrom(req) {
  for (const part of (req.headers.cookie || '').split(';')) {
    const [name, ...rest] = part.trim().split('=');
    if (name === COOKIE) return rest.join('=');
  }
  return null;
}

export function isAdmin(req) {
  const token = tokenFrom(req);
  const expires = token && sessions.get(token);
  if (!expires) return false;
  if (expires < Date.now()) {
    sessions.delete(token);
    return false;
  }
  return true;
}

export function logout(req) {
  const token = tokenFrom(req);
  if (token) sessions.delete(token);
}

export function sessionCookie(token, secure) {
  return `${COOKIE}=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${SESSION_TTL_MS / 1000}${secure ? '; Secure' : ''}`;
}

export function clearCookie() {
  return `${COOKIE}=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0`;
}

export function requireAdmin(req, res, next) {
  if (!isAdmin(req)) return res.status(401).json({ error: 'Not logged in' });
  next();
}
