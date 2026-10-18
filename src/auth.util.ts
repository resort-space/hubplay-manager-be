import { createHmac, timingSafeEqual } from 'crypto';
import { AdminRole } from '@prisma/client';

export type SessionPayload = {
  sub: string;
  kind: 'user' | 'admin';
  role?: AdminRole;
  roles?: AdminRole[];
  phone?: string;
};

export function sessionRoles(session: SessionPayload | null): AdminRole[] {
  if (session?.roles?.length) return session.roles;
  if (session?.role) return [session.role];
  return [];
}

export function isSystemAdmin(session: SessionPayload | null) {
  return sessionRoles(session).includes(AdminRole.system_admin);
}

const secret = () => process.env.JWT_SECRET || 'hubplay-dev-secret';

function b64url(input: Buffer | string) {
  return Buffer.from(input)
    .toString('base64')
    .replace(/=/g, '')
    .replace(/\+/g, '-')
    .replace(/\//g, '_');
}

export function signSession(payload: SessionPayload) {
  const body = b64url(JSON.stringify({ ...payload, exp: Date.now() + 1000 * 60 * 60 * 24 * 7 }));
  const sig = createHmac('sha256', secret()).update(body).digest();
  return `${body}.${b64url(sig)}`;
}

function fromB64url(value: string) {
  const pad = value.length % 4 === 0 ? '' : '='.repeat(4 - (value.length % 4));
  return Buffer.from(value.replace(/-/g, '+').replace(/_/g, '/') + pad, 'base64');
}

export function readSession(token?: string): SessionPayload | null {
  if (!token) return null;
  const [body, sig] = token.split('.');
  if (!body || !sig) return null;
  const expected = b64url(createHmac('sha256', secret()).update(body).digest());
  const a = Buffer.from(sig);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
  const data = JSON.parse(fromB64url(body).toString('utf8')) as SessionPayload & { exp: number };
  if (!data.exp || data.exp < Date.now()) return null;
  return data;
}
