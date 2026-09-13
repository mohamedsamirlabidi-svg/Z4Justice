import { Request, Response, NextFunction } from 'express';
import jwt from 'jsonwebtoken';
import { prisma } from '../../prisma';
import { runAsSystem, runWithTenant } from '../../tenant-context';

const JWT_SECRET = process.env.JWT_SECRET ?? 'mini-erm-secret-change-me';

export interface JwtPayload {
  userId: string;
  email: string;
  role: string;
  tenantId?: string | null;
  platformAdmin?: boolean;
}

declare global {
  namespace Express {
    interface Request {
      user?: JwtPayload;
    }
  }
}

/**
 * Authenticates the request via Bearer JWT and starts the AsyncLocalStorage
 * tenant context so downstream Prisma queries are automatically tenant-scoped.
 *
 * If the JWT was minted before F6 (no tenantId/platformAdmin claim), we
 * hydrate those fields from the DB. That keeps pre-migration sessions alive.
 */
export async function authMiddleware(req: Request, res: Response, next: NextFunction) {
  const header = req.headers.authorization;
  if (!header?.startsWith('Bearer ')) {
    return res.status(401).json({ message: 'Token requis' });
  }

  let payload: JwtPayload;
  try {
    payload = jwt.verify(header.slice(7), JWT_SECRET) as JwtPayload;
  } catch {
    return res.status(401).json({ message: 'Token invalide ou expiré' });
  }

  // Hydrate missing multi-tenancy claims from DB for legacy tokens.
  if (!payload.tenantId && !payload.platformAdmin) {
    const user = await runAsSystem('auth-hydrate', () =>
      prisma.user.findUnique({
        where: { id: payload.userId },
        select: { tenantId: true, platformAdmin: true },
      }),
    );
    if (!user) {
      return res.status(401).json({ message: 'Utilisateur introuvable' });
    }
    payload = { ...payload, tenantId: user.tenantId ?? null, platformAdmin: user.platformAdmin };
  }

  req.user = payload;

  if (payload.platformAdmin) {
    return runAsSystem(`platform-admin:${payload.userId}`, () => next());
  }

  if (!payload.tenantId) {
    return res
      .status(403)
      .json({ message: 'Ce compte n’est associé à aucun tenant.' });
  }

  return runWithTenant(payload.tenantId, () => next(), { userId: payload.userId });
}

export function requireRole(...roles: string[]) {
  return (req: Request, res: Response, next: NextFunction) => {
    if (!req.user) {
      return res.status(401).json({ message: 'Non authentifié' });
    }
    if (!roles.includes(req.user.role)) {
      return res.status(403).json({ message: 'Accès refusé' });
    }
    next();
  };
}

export function requirePlatformAdmin(req: Request, res: Response, next: NextFunction) {
  if (!req.user?.platformAdmin) {
    return res.status(403).json({ message: 'Platform admin only' });
  }
  next();
}

export function signToken(payload: JwtPayload): string {
  return jwt.sign(payload, JWT_SECRET, { expiresIn: '7d' });
}
