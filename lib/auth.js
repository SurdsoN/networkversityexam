// Admin authentication: one admin account whose password is stored as a
// salted scrypt hash, and a signed session cookie (no server-side session
// list, so it works across serverless instances). Changing the password
// invalidates every existing session.
import crypto from 'crypto';
import store from './store.js';

const COOKIE = 'nv_admin';
const SESSION_TTL_MS = 8 * 60 * 60 * 1000;

// Login rate limiting: 5 failures per IP locks that IP out for 15 minutes.
const MAX_FAILURES = 5;
const LOCKOUT_MS = 15 * 60 * 1000;

export function hashPassword(password, salt = crypto.randomBytes(16).toString('hex')) {
  const hash = crypto.scryptSync(password, salt, 64).toString('hex');
  return { salt, hash };
}

function verifyPassword(password, { salt, hash }) {
  const candidate = Buffer.from(hashPassword(password, salt).hash, 'hex');
  const expected = Buffer.from(hash, 'hex');
  return candidate.length === expected.length && crypto.timingSafeEqual(candidate, expected);
}

// Creates the admin account on first start from ADMIN_USERNAME/ADMIN_PASSWORD
// and the cookie-signing secret. Off Vercel, a missing password is generated
// and printed once; on Vercel ADMIN_PASSWORD must be set.
export async function ensureAdmin() {
  await store.addKvIfMissing('secret', process.env.SESSION_SECRET || crypto.randomBytes(32).toString('hex'));
  if (await store.getKv('admin')) return;
  const username = process.env.ADMIN_USERNAME || 'admin';
  let password = process.env.ADMIN_PASSWORD;
  if (!password) {
    if (process.env.VERCEL) return;
    password = crypto.randomBytes(6).toString('base64url');
    console.log('\n================================================================');
    console.log(' No ADMIN_PASSWORD set - generated an admin account:');
    console.log(`   username: ${username}`);
    console.log(`   password: ${password}`);
    console.log(' Change it from the admin panel (Account tab) after logging in.');
    console.log('================================================================\n');
  }
  if (await store.addKvIfMissing('admin', { username, ...hashPassword(password) })) {
    console.log(`Admin account "${username}" created.`);
  }
}

async function sign(value) {
  const secret = await store.getKv('secret');
  return crypto.createHmac('sha256', secret).update(value).digest('hex');
}

// The token embeds part of the password hash, so it stops working as soon as
// the password changes.
async function makeToken(admin, expires) {
  const payload = `${expires}.${admin.hash.slice(0, 16)}`;
  return `${expires}.${await sign(payload)}`;
}

export async function isLockedOut(ip) {
  const entry = await store.getFailure(ip);
  return Boolean(entry && entry.lockedUntil > Date.now());
}

// Returns a session token, or an error string.
export async function login(ip, username, password) {
  let admin = await store.getKv('admin');
  if (!admin) {
    // e.g. the account row was deleted to recover a forgotten password
    await ensureAdmin();
    admin = await store.getKv('admin');
  }
  if (!admin) return { error: 'The admin account is not set up yet. Set the ADMIN_PASSWORD environment variable and redeploy.' };
  const ok =
    typeof username === 'string' &&
    typeof password === 'string' &&
    username === admin.username &&
    verifyPassword(password, admin);
  if (!ok) {
    const entry = (await store.getFailure(ip)) || { count: 0, lockedUntil: 0 };
    entry.count += 1;
    if (entry.count >= MAX_FAILURES) {
      entry.count = 0;
      entry.lockedUntil = Date.now() + LOCKOUT_MS;
    }
    await store.setFailure(ip, entry);
    return { error: 'Incorrect username or password.' };
  }
  await store.setFailure(ip, null);
  return { token: await makeToken(admin, Date.now() + SESSION_TTL_MS) };
}

export async function changePassword(current, next) {
  const admin = await store.getKv('admin');
  if (!verifyPassword(current, admin)) return false;
  await store.setKv('admin', { username: admin.username, ...hashPassword(next) });
  return true;
}

function tokenFrom(req) {
  for (const part of (req.headers.cookie || '').split(';')) {
    const [name, ...rest] = part.trim().split('=');
    if (name === COOKIE) return rest.join('=');
  }
  return null;
}

// Returns the admin username for a valid session, otherwise null.
export async function sessionUser(req) {
  const token = tokenFrom(req);
  if (!token) return null;
  const [expires, signature] = token.split('.');
  if (!expires || !signature || Number(expires) < Date.now()) return null;
  const admin = await store.getKv('admin');
  if (!admin) return null;
  const expected = Buffer.from((await makeToken(admin, expires)).split('.')[1]);
  const given = Buffer.from(signature);
  return expected.length === given.length && crypto.timingSafeEqual(expected, given) ? admin.username : null;
}

export function sessionCookie(token, secure) {
  return `${COOKIE}=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${SESSION_TTL_MS / 1000}${secure ? '; Secure' : ''}`;
}

export function clearCookie() {
  return `${COOKIE}=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0`;
}

export async function requireAdmin(req, res, next) {
  if (!(await sessionUser(req))) return res.status(401).json({ error: 'Not logged in' });
  next();
}
