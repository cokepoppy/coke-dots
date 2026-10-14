import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

const lifetimeMs = 5 * 60_000;
const signingKey = randomBytes(32);

interface ArtifactPreviewClaims {
  tenantId: string;
  taskId: string;
  expiresAt: number;
}

export function createArtifactPreviewTicket(tenantId: string, taskId: string, now = Date.now()) {
  const claims: ArtifactPreviewClaims = { tenantId, taskId, expiresAt: now + lifetimeMs };
  const payload = Buffer.from(JSON.stringify(claims)).toString('base64url');
  return `${payload}.${sign(payload)}`;
}

export function verifyArtifactPreviewTicket(ticket: string, now = Date.now()): ArtifactPreviewClaims | null {
  if (typeof ticket !== 'string' || ticket.length > 2048) return null;
  const [payload, signature, extra] = ticket.split('.');
  if (!payload || !signature || extra !== undefined) return null;
  const expected = Buffer.from(sign(payload));
  const received = Buffer.from(signature);
  if (expected.length !== received.length || !timingSafeEqual(expected, received)) return null;
  try {
    const claims = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as Partial<ArtifactPreviewClaims>;
    if (typeof claims.tenantId !== 'string' || !claims.tenantId || !/^[a-f0-9-]{36}$/i.test(claims.taskId || '')
      || !Number.isSafeInteger(claims.expiresAt) || (claims.expiresAt || 0) <= now || (claims.expiresAt || 0) > now + lifetimeMs) return null;
    return claims as ArtifactPreviewClaims;
  } catch { return null; }
}

function sign(payload: string) {
  return createHmac('sha256', signingKey).update(payload).digest('base64url');
}
