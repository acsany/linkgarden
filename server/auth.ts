import {
  randomBytes,
  scrypt as scryptCallback,
  timingSafeEqual,
  createHash,
  randomUUID,
} from 'node:crypto';
import type { Database } from './db.js';
import type { Config } from './config.js';
import { AppError } from './errors.js';
const scrypt = (password: string, salt: string) =>
  new Promise<Buffer>((resolve, reject) =>
    scryptCallback(
      password,
      salt,
      64,
      { N: 32768, r: 8, p: 1, maxmem: 64 * 1024 * 1024 },
      (err, result) => (err ? reject(err) : resolve(result)),
    ),
  );
export const digest = (v: string) => createHash('sha256').update(v).digest('hex');
export async function hashPassword(password: string) {
  const salt = randomBytes(16).toString('hex');
  const result = await scrypt(password, salt);
  return `scrypt$32768$8$1$${salt}$${result.toString('hex')}`;
}
export async function verifyPassword(password: string, encoded: string) {
  try {
    const [algo, n, r, p, salt, hash] = encoded.split('$');
    if (
      algo !== 'scrypt' ||
      Number(n) !== 32768 ||
      Number(r) !== 8 ||
      Number(p) !== 1 ||
      !/^[a-f0-9]{128}$/.test(hash)
    )
      return false;
    const actual = await scrypt(password, salt);
    return timingSafeEqual(actual, Buffer.from(hash, 'hex'));
  } catch {
    return false;
  }
}
export async function seedAdmin(db: Database, config: Config) {
  if (!config.adminEmail || !config.adminPasswordHash) return;
  if (!/^scrypt\$32768\$8\$1\$[a-f0-9]{32}\$[a-f0-9]{128}$/.test(config.adminPasswordHash))
    throw new Error('ADMIN_PASSWORD_HASH is invalid. Use npm run admin:setup -- --hash-only.');
  const existing = (await db.query('SELECT * FROM admin WHERE id=1')).rows[0];
  if (
    existing?.password_hash === config.adminPasswordHash &&
    existing?.email === config.adminEmail.toLowerCase()
  )
    return;
  await db.transaction(async (tx) => {
    await tx.query(
      'INSERT INTO admin(id,email,password_hash) VALUES(1,$1,$2) ON CONFLICT(id) DO UPDATE SET email=$1,password_hash=$2',
      [config.adminEmail!.toLowerCase(), config.adminPasswordHash],
    );
    await tx.query('DELETE FROM sessions');
  });
}
export async function login(db: Database, email: string, password: string) {
  const admin = (await db.query('SELECT * FROM admin WHERE id=1')).rows[0];
  // Do the same costly hash even for unknown emails.
  const hash =
    admin?.password_hash || 'scrypt$32768$8$1$00000000000000000000000000000000$' + '0'.repeat(128);
  const valid = await verifyPassword(password, hash);
  if (!admin || admin.email !== email.toLowerCase() || !valid)
    throw new AppError(401, 'Incorrect email or password.');
  const token = randomBytes(32).toString('base64url');
  const csrfToken = randomBytes(32).toString('base64url');
  await db.query('INSERT INTO sessions(token_hash,csrf_token,expires_at) VALUES($1,$2,$3)', [
    digest(token),
    csrfToken,
    new Date(Date.now() + 12 * 3600000),
  ]);
  return { token, csrfToken, email: admin.email };
}
export async function session(db: Database, token?: string) {
  if (!token || token.length > 100) return null;
  return (
    (
      await db.query('SELECT csrf_token FROM sessions WHERE token_hash=$1 AND expires_at>now()', [
        digest(token),
      ])
    ).rows[0] || null
  );
}
export async function createAgentToken(
  db: Database,
  name: string,
  scope: 'read' | 'write',
  days: number,
) {
  const id = randomUUID();
  const token = `lg_${randomBytes(32).toString('base64url')}`;
  const expiresAt = new Date(Date.now() + days * 86400000);
  await db.query(
    'INSERT INTO agent_tokens(id,name,token_hash,scope,expires_at) VALUES($1,$2,$3,$4,$5)',
    [id, name, digest(token), scope, expiresAt],
  );
  return { id, token, scope, expiresAt };
}
export async function agentAuth(db: Database, header?: string) {
  if (!header?.startsWith('Bearer ') || header.length > 200)
    throw new AppError(401, 'A valid agent bearer token is required.');
  const row = (
    await db.query('SELECT id,scope FROM agent_tokens WHERE token_hash=$1 AND expires_at>now()', [
      digest(header.slice(7)),
    ])
  ).rows[0];
  if (!row) throw new AppError(401, 'The agent token is invalid, expired, or revoked.');
  await db.query('UPDATE agent_tokens SET last_used_at=now() WHERE id=$1', [row.id]);
  return row as { id: string; scope: 'read' | 'write' };
}
