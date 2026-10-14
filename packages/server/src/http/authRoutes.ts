import express from 'express';
import { z } from 'zod';
import type { Services } from '../services.js';
import { h, requireUser, SESSION_COOKIE } from './middleware.js';
import { publicUser, SETUP_STEPS } from '../auth/users.js';
import { ALL_SCOPES } from '../mcp/registry.js';

export function authRoutes(services: Services): express.Router {
  const r = express.Router();
  const cookieOptions = () => ({
    httpOnly: true,
    sameSite: 'lax' as const,
    secure: services.config.publicUrl.startsWith('https://'),
    maxAge: 30 * 86400_000,
    path: '/',
  });

  r.get(
    '/status',
    h(async (req, res) => {
      res.json({ needsFirstAccount: (await services.users.count()) === 0, signedIn: !!req.user, openSignup: services.config.openSignup });
    }),
  );

  r.post(
    '/signup',
    h(async (req, res) => {
      const body = z.object({ email: z.string(), name: z.string().default(''), password: z.string() }).parse(req.body);
      const user = await services.users.signup(body);
      const token = await services.users.createSession(user.id);
      res.cookie(SESSION_COOKIE, token, cookieOptions());
      res.status(201).json({ user: publicUser(user) });
    }),
  );

  r.post(
    '/login',
    h(async (req, res) => {
      const body = z.object({ email: z.string(), password: z.string() }).parse(req.body);
      const user = await services.users.login(body.email, body.password);
      const token = await services.users.createSession(user.id);
      res.cookie(SESSION_COOKIE, token, cookieOptions());
      res.json({ user: publicUser(user) });
    }),
  );

  r.post(
    '/logout',
    h(async (req, res) => {
      await services.users.destroySession((req as express.Request & { cookies?: Record<string, string> }).cookies?.[SESSION_COOKIE]);
      res.clearCookie(SESSION_COOKIE, { path: '/' });
      res.json({ ok: true });
    }),
  );

  r.get(
    '/me',
    h(async (req, res) => {
      res.json({ user: publicUser(requireUser(req)) });
    }),
  );

  r.patch(
    '/me',
    h(async (req, res) => {
      const user = requireUser(req);
      const body = z
        .object({
          name: z.string().max(100).optional(),
          preferences: z
            .object({
              theme: z.enum(['system', 'light', 'dark', 'high-contrast']).optional(),
              reducedMotion: z.enum(['system', 'on', 'off']).optional(),
              locale: z.string().max(20).optional(),
              pressureGamma: z.number().min(0.2).max(5).optional(),
            })
            .optional(),
          setup: z
            .object({
              completed: z.array(z.enum(SETUP_STEPS)).optional(),
              current: z.enum(SETUP_STEPS).optional(),
              dismissed: z.boolean().optional(),
              preset: z.enum(['view', 'approve', 'autonomous']).optional(),
            })
            .optional(),
        })
        .parse(req.body);
      const next = await services.users.update(user.id, {
        ...(body.name ? { name: body.name } : {}),
        ...(body.preferences ? { preferences: { ...user.preferences, ...body.preferences } } : {}),
        ...(body.setup ? { setup: { ...user.setup, ...body.setup } } : {}),
      });
      res.json({ user: publicUser(next) });
    }),
  );

  r.post(
    '/password',
    h(async (req, res) => {
      const user = requireUser(req);
      const body = z.object({ current: z.string(), next: z.string() }).parse(req.body);
      await services.users.changePassword(user.id, body.current, body.next);
      res.json({ ok: true });
    }),
  );

  /* Personal access tokens (stdio bridge, scripts) */
  r.get(
    '/tokens',
    h(async (req, res) => {
      const user = requireUser(req);
      const tokens = await services.users.listAccessTokens(user.id);
      res.json({ tokens: tokens.map(({ id, name, scopes, createdAt, lastUsedAt, prefix }) => ({ id, name, scopes, createdAt, lastUsedAt, prefix })) });
    }),
  );

  r.post(
    '/tokens',
    h(async (req, res) => {
      const user = requireUser(req);
      if (req.viaToken) {
        res.status(403).json({ error: 'Access tokens cannot create new tokens. Sign in to Omnix to create one.' });
        return;
      }
      const body = z.object({ name: z.string().min(1).max(80), scopes: z.array(z.enum(ALL_SCOPES as [string, ...string[]])).min(1) }).parse(req.body);
      const { token, record } = await services.users.createAccessToken(user.id, body.name, body.scopes);
      res.status(201).json({ token, record: { id: record.id, name: record.name, scopes: record.scopes, prefix: record.prefix, createdAt: record.createdAt } });
    }),
  );

  r.delete(
    '/tokens/:id',
    h(async (req, res) => {
      const user = requireUser(req);
      await services.users.revokeAccessToken(user.id, String(req.params.id));
      res.json({ ok: true });
    }),
  );

  return r;
}
