import type { NextFunction, Request, Response, RequestHandler } from 'express';
import { ZodError } from 'zod';
import { AuthError, authorOf, type User } from '../auth/users.js';
import { ProjectError } from '../projects/service.js';
import { ToolError } from '../mcp/registry.js';
import { OpError } from '@omnix/core';
import type { Services } from '../services.js';

export const SESSION_COOKIE = 'omnix_session';

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      user?: User;
      /** Set when the request authenticated with a personal access token. */
      viaToken?: boolean;
    }
  }
}

/** Resolve the signed-in user from the session cookie or a bearer access token. */
export function attachUser(services: Services): RequestHandler {
  return async (req, _res, next) => {
    try {
      const cookie = (req as Request & { cookies?: Record<string, string> }).cookies?.[SESSION_COOKIE];
      let user = await services.users.userForSession(cookie);
      if (!user) {
        const h = req.headers.authorization;
        if (h?.startsWith('Bearer omx_')) {
          const r = await services.users.resolveAccessToken(h.slice(7).trim());
          if (r) {
            user = r.user;
            req.viaToken = true;
          }
        }
      }
      if (user) req.user = user;
      next();
    } catch (e) {
      next(e);
    }
  };
}

export function requireUser(req: Request): User {
  if (!req.user) throw new AuthError('Sign in to continue');
  return req.user;
}

export const author = (req: Request) => authorOf(requireUser(req));

/** Wrap async handlers so thrown errors reach the error middleware (Express 5 also does this). */
export function h(fn: (req: Request, res: Response) => Promise<unknown>): RequestHandler {
  return (req, res, next) => {
    fn(req, res).catch(next);
  };
}

export function errorHandler(dev: boolean) {
  return (err: unknown, _req: Request, res: Response, _next: NextFunction) => {
    if (res.headersSent) return;
    if (err instanceof AuthError) return void res.status(err.status).json({ error: err.message });
    if (err instanceof ProjectError) return void res.status(err.status).json({ error: err.message, details: err.details });
    if (err instanceof ToolError) return void res.status(400).json({ error: err.message });
    if (err instanceof OpError) return void res.status(400).json({ error: err.message });
    if (err instanceof ZodError) return void res.status(400).json({ error: 'Invalid request', details: err.issues });
    const e = err as { type?: string; status?: number; message?: string };
    if (e?.type === 'entity.too.large') return void res.status(413).json({ error: 'Request too large' });
    if (e?.type === 'entity.parse.failed') return void res.status(400).json({ error: 'Malformed JSON' });
    if (dev) console.error('[http] unhandled error', err);
    res.status(500).json({ error: dev && e?.message ? e.message : 'Something went wrong on the Omnix server' });
  };
}
