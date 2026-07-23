import type { SessionRecord } from '@jarvis/core';
import type { Db } from '@jarvis/db';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { AppConfig } from '../config.js';
import type { AuditService } from '../context.js';
import { badRequest, notFound, unauthorized } from '../lib/http-errors.js';
import {
  clearStateCookie,
  readStateCookie,
  setStateCookie,
  statesMatch,
  validateReturnTo,
} from '../lib/oauth.js';
import {
  buildStartRedirect,
  createLoginStatePayload,
  exchangeLoginCode,
  isLoginProvider,
  isProviderConfigured,
  resolveOauthLogin,
} from '../services/oauth/login-providers.js';
import { SESSION_TTL_DAYS, type SessionsService } from '../services/sessions.js';

/**
 * OAuth LOGIN routes (see docs/api-contract.md "OAuth login"): browser
 * navigations, not XHR — failures always 302 back to the web app's
 * /signin?error=<code>, never JSON. Also the linked-identities JSON endpoints
 * (GET/DELETE /api/auth/accounts).
 *
 * The start/callback routes are PUBLIC (no session yet during login); the
 * 'link' intent authenticates itself by validating the session cookie.
 * Authorization codes / tokens are never logged or echoed anywhere.
 */

const STATE_COOKIE = 'jarvis_oauth_login';
const SESSION_COOKIE = 'jarvis_session';

export interface AuthOauthDeps {
  db: Db;
  config: AppConfig;
  audit: AuditService;
  sessions: SessionsService;
}

/** Web-app redirect target: same-origin path when the API serves the web
 * build (JARVIS_PUBLIC_DIR), the web origin otherwise (dev split origins). */
export function webRedirect(config: AppConfig, path: string): string {
  if (config.env.JARVIS_PUBLIC_DIR) return path;
  return `${config.env.JARVIS_WEB_ORIGIN.replace(/\/$/, '')}${path}`;
}

export function registerAuthOauthRoutes(app: FastifyInstance, deps: AuthOauthDeps): void {
  const { db, config, audit, sessions } = deps;

  // Apple posts its form_post callback as application/x-www-form-urlencoded;
  // the app only registers json + multipart parsers, so add one when missing.
  // NOTE: the parser is app-wide (fastify makes route-scoping parsers
  // awkward), which makes every POST route reachable from a plain HTML form.
  // CSRF from such cross-site form posts is blocked by the Origin check in
  // auth.ts; only the OAuth callbacks are exempt there.
  if (!app.hasContentTypeParser('application/x-www-form-urlencoded')) {
    app.addContentTypeParser(
      'application/x-www-form-urlencoded',
      { parseAs: 'string' },
      (_request, body, done) => {
        try {
          done(null, Object.fromEntries(new URLSearchParams(String(body))));
        } catch (err) {
          done(err as Error);
        }
      },
    );
  }

  async function sessionFromCookie(request: FastifyRequest): Promise<SessionRecord | null> {
    const raw = request.cookies[SESSION_COOKIE];
    if (!raw) return null;
    const unsigned = request.unsignCookie(raw);
    if (!unsigned.valid || !unsigned.value) return null;
    return sessions.validate(unsigned.value);
  }

  function failRedirect(reply: FastifyReply, code: string): FastifyReply {
    return reply.redirect(webRedirect(config, `/signin?error=${code}`));
  }

  // -- Start: 302 to the provider consent screen -----------------------------

  app.get('/api/auth/oauth/:provider/start', async (request, reply) => {
    const { provider } = request.params as { provider: string };
    if (!isLoginProvider(provider)) throw badRequest('Unknown OAuth provider');
    if (!isProviderConfigured(provider, config)) {
      throw badRequest('This OAuth provider is not configured', 'not_configured');
    }
    const query = (request.query ?? {}) as Record<string, unknown>;
    const intent = String(query.link ?? '') === '1' ? 'link' : 'login';
    let userId: string | undefined;
    if (intent === 'link') {
      const session = await sessionFromCookie(request);
      if (!session) throw unauthorized();
      userId = session.userId;
    }
    const payload = createLoginStatePayload(provider, { intent, returnTo: query.returnTo, userId });
    setStateCookie(reply, STATE_COOKIE, payload, {
      // Apple's form_post callback is a cross-site POST: Lax cookies are
      // dropped there, so the state cookie must be SameSite=None.
      sameSite: provider === 'apple' ? 'none' : 'lax',
      secure: config.env.JARVIS_COOKIE_SECURE,
    });
    return reply.redirect(buildStartRedirect(provider, config, payload));
  });

  // -- Callback (GET for google/facebook, POST form_post for apple) ----------

  const callback = async (request: FastifyRequest, reply: FastifyReply): Promise<FastifyReply> => {
    const { provider } = request.params as { provider: string };
    if (!isLoginProvider(provider) || !isProviderConfigured(provider, config)) {
      clearStateCookie(reply, STATE_COOKIE);
      return failRedirect(reply, 'oauth_failed');
    }
    const params = ((request.method === 'POST' ? request.body : request.query) ?? {}) as Record<
      string,
      unknown
    >;
    const state = readStateCookie(request, STATE_COOKIE);
    clearStateCookie(reply, STATE_COOKIE); // single-use, success or not
    if (typeof params.error === 'string' && params.error.length > 0) {
      return failRedirect(reply, 'oauth_denied');
    }
    if (!state || !statesMatch(params.state, state.state)) {
      return failRedirect(reply, 'oauth_state_mismatch');
    }
    const code = params.code;
    if (typeof code !== 'string' || code.length === 0) return failRedirect(reply, 'oauth_failed');

    let profile;
    try {
      profile = await exchangeLoginCode(provider, config, code, {
        state,
        userField: typeof params.user === 'string' ? params.user : undefined,
      });
    } catch {
      // Deliberately swallowed: exchange errors may reference codes/tokens.
      return failRedirect(reply, 'oauth_failed');
    }

    const resolveCtx = {
      // Local mode is single-user: self-service signup is never enabled there
      // (same derivation as /api/auth/methods in auth.ts).
      signupEnabled: config.env.JARVIS_AUTH_MODE === 'password' && config.env.JARVIS_ALLOW_SIGNUP,
      authMode: config.env.JARVIS_AUTH_MODE,
    };

    if (state.intent === 'link') {
      const session = await sessionFromCookie(request);
      if (!session || !state.userId || session.userId !== state.userId) {
        return failRedirect(reply, 'oauth_failed');
      }
      const outcome = await resolveOauthLogin(db, profile, {
        ...resolveCtx,
        intent: 'link',
        userId: session.userId,
      });
      if (outcome.status === 'error') {
        // The user is already signed in — bounce back to where they linked
        // from with the error, not to /signin (a dead end for live sessions).
        const returnTo = validateReturnTo(state.returnTo ?? '/settings');
        const sep = returnTo.includes('?') ? '&' : '?';
        return reply.redirect(webRedirect(config, `${returnTo}${sep}linkError=${outcome.code}`));
      }
      if (outcome.linkedAccount) {
        await audit.log({
          workspaceId: session.workspaceId,
          userId: session.userId,
          eventType: 'auth.oauth_linked',
          actor: 'user',
          summary: `Linked ${provider} as a sign-in method`,
          metadata: { provider },
        });
      }
      return reply.redirect(webRedirect(config, validateReturnTo(state.returnTo ?? '/settings')));
    }

    const outcome = await resolveOauthLogin(db, profile, { ...resolveCtx, intent: 'login' });
    if (outcome.status === 'error') return failRedirect(reply, outcome.code);
    if (!outcome.workspaceId) return failRedirect(reply, 'oauth_failed');
    const { user, workspaceId } = outcome;

    if (outcome.createdUser) {
      await audit.log({
        workspaceId,
        userId: user.id,
        eventType: 'auth.register',
        actor: 'user',
        summary: `${user.email} registered via ${provider}`,
        metadata: { method: provider },
      });
    }
    if (outcome.linkedAccount) {
      await audit.log({
        workspaceId,
        userId: user.id,
        eventType: 'auth.oauth_linked',
        actor: 'user',
        summary: `Linked ${provider} as a sign-in method`,
        metadata: { provider },
      });
    }

    const { token } = await sessions.create(user.id, workspaceId, {
      userAgent: request.headers['user-agent'] ?? null,
      ip: request.ip,
    });
    reply.setCookie(SESSION_COOKIE, token, {
      path: '/',
      httpOnly: true,
      sameSite: 'lax',
      secure: config.env.JARVIS_COOKIE_SECURE,
      signed: true,
      maxAge: SESSION_TTL_DAYS * 24 * 60 * 60,
    });
    await audit.log({
      workspaceId,
      userId: user.id,
      eventType: 'auth.login',
      actor: 'user',
      summary: `${user.email} signed in with ${provider}`,
      metadata: { method: provider },
    });
    return reply.redirect(webRedirect(config, validateReturnTo(state.returnTo)));
  };

  app.get('/api/auth/oauth/:provider/callback', callback);
  app.post('/api/auth/oauth/:provider/callback', callback);

  // -- Linked login identities (JSON; authed by the global session hook) -----

  app.get('/api/auth/accounts', async (request) => {
    if (!request.userId) throw unauthorized();
    const rows = await db
      .selectFrom('authAccounts')
      .selectAll()
      .where('userId', '=', request.userId)
      .orderBy('createdAt', 'asc')
      .execute();
    // No token fields exist on authAccounts by design — login identities only.
    return {
      items: rows.map((row) => ({
        id: row.id,
        provider: row.provider,
        email: row.email,
        displayName: row.displayName,
        avatarUrl: row.avatarUrl,
        emailVerified: row.emailVerified === 1,
        createdAt: row.createdAt,
        lastLoginAt: row.lastLoginAt,
      })),
    };
  });

  app.delete('/api/auth/accounts/:id', async (request) => {
    if (!request.userId) throw unauthorized();
    const { id } = request.params as { id: string };
    const account = await db
      .selectFrom('authAccounts')
      .select(['id', 'provider'])
      .where('id', '=', id)
      .where('userId', '=', request.userId)
      .executeTakeFirst();
    if (!account) throw notFound('Linked account not found');

    const user = await db
      .selectFrom('users')
      .select(['passwordHash'])
      .where('id', '=', request.userId)
      .executeTakeFirst();
    const linked = await db
      .selectFrom('authAccounts')
      .select(['id'])
      .where('userId', '=', request.userId)
      .execute();
    if (!user?.passwordHash && linked.length <= 1) {
      throw badRequest(
        'This is your only way to sign in — set a password first',
        'last_login_method',
      );
    }

    await db.deleteFrom('authAccounts').where('id', '=', account.id).execute();
    await audit.log({
      workspaceId: request.workspaceId,
      userId: request.userId,
      eventType: 'auth.oauth_unlinked',
      actor: 'user',
      summary: `Unlinked ${account.provider} sign-in method`,
      metadata: { provider: account.provider },
    });
    return { ok: true };
  });
}
