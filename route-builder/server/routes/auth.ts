import type { FastifyPluginAsync, FastifyRequest } from 'fastify';
import '@fastify/cookie';
import {
  AuthService,
  defaultAuthService,
  LOCAL_DEV_USER,
  SESSION_COOKIE_NAME,
  OAUTH_STATE_COOKIE_NAME,
} from '../services/authService.js';
import type {
  AuthStatusResponse,
  MobileGoogleAuthRequest,
  MobileGoogleAuthResponse,
} from '../types/auth.js';

export interface AuthPluginOptions {
  authService?: AuthService;
}

function extractToken(request: FastifyRequest): string | undefined {
  const cookieToken = request.cookies?.[SESSION_COOKIE_NAME];
  if (cookieToken) return cookieToken;

  const authHeader = request.headers.authorization;
  if (authHeader) {
    const match = authHeader.match(/^Bearer\s+(.+)$/i);
    if (match) return match[1];
  }
  return undefined;
}

export const authRoutes: FastifyPluginAsync<AuthPluginOptions> = async (fastify, options) => {
  const authService = options.authService || defaultAuthService;

  // GET /api/auth/status - Check current authentication and authorization status
  fastify.get('/api/auth/status', async (request, reply) => {
    if (!authService.isAuthEnabled()) {
      const response: AuthStatusResponse = {
        authEnabled: false,
        authenticated: true,
        authorized: true,
        user: LOCAL_DEV_USER,
      };
      return reply.status(200).send(response);
    }

    await authService.ensureConfigLoaded();

    const token = extractToken(request);
    if (!token) {
      const response: AuthStatusResponse = {
        authEnabled: true,
        authenticated: false,
        authorized: false,
        user: null,
      };
      return reply.status(200).send(response);
    }

    const user = authService.verifySessionToken(token);
    if (!user) {
      const response: AuthStatusResponse = {
        authEnabled: true,
        authenticated: false,
        authorized: false,
        user: null,
      };
      return reply.status(200).send(response);
    }

    const authorized = authService.isEmailAllowed(user.email);
    const response: AuthStatusResponse = {
      authEnabled: true,
      authenticated: true,
      authorized,
      user,
      ...(authorized
        ? {}
        : {
            message:
              'Roadtrip Co-Pilot is in private preview. Your account is not on the authorized allowlist.',
          }),
    };
    return reply.status(200).send(response);
  });

  // GET /api/auth/google - Initiate Google OAuth2 PKCE login flow
  fastify.get('/api/auth/google', async (request, reply) => {
    await authService.ensureConfigLoaded();

    const { state, codeChallenge, stateCookieToken } =
      authService.createOAuthStateAndChallenge();
    const baseUrl = authService.resolvePublicBaseUrl(request);
    const redirectUri = `${baseUrl}/api/auth/callback/google`;
    const isSecure = baseUrl.startsWith('https://');

    reply.setCookie(OAUTH_STATE_COOKIE_NAME, stateCookieToken, {
      httpOnly: true,
      sameSite: 'lax',
      secure: isSecure,
      path: '/',
      maxAge: 600,
    });

    const authUrl = authService.getGoogleAuthorizationUrl({
      redirectUri,
      state,
      codeChallenge,
    });

    return reply.redirect(authUrl, 302);
  });

  // GET /api/auth/callback/google - Handle Google OAuth2 callback
  fastify.get('/api/auth/callback/google', async (request, reply) => {
    await authService.ensureConfigLoaded();
    const baseUrl = authService.resolvePublicBaseUrl(request);
    const isSecure = baseUrl.startsWith('https://');

    const query = request.query as { code?: string; state?: string; error?: string };
    if (query.error) {
      reply.clearCookie(OAUTH_STATE_COOKIE_NAME, {
        path: '/',
        httpOnly: true,
        sameSite: 'lax',
        secure: isSecure,
      });
      return reply.redirect(`${baseUrl}/`, 302);
    }

    if (!query.code || !query.state) {
      reply.clearCookie(OAUTH_STATE_COOKIE_NAME, {
        path: '/',
        httpOnly: true,
        sameSite: 'lax',
        secure: isSecure,
      });
      return reply.status(400).send({
        error: 'Invalid OAuth state or missing authorization code',
      });
    }

    const oauthCookie = request.cookies?.[OAUTH_STATE_COOKIE_NAME];
    const verifiedState = authService.verifyOAuthStateCookie(oauthCookie, query.state);
    if (!verifiedState) {
      reply.clearCookie(OAUTH_STATE_COOKIE_NAME, {
        path: '/',
        httpOnly: true,
        sameSite: 'lax',
        secure: isSecure,
      });
      return reply.status(400).send({
        error: 'Invalid OAuth state or missing authorization code',
      });
    }

    reply.clearCookie(OAUTH_STATE_COOKIE_NAME, {
      path: '/',
      httpOnly: true,
      sameSite: 'lax',
      secure: isSecure,
    });

    const redirectUri = `${baseUrl}/api/auth/callback/google`;
    try {
      const { idToken } = await authService.exchangeGoogleCode({
        code: query.code,
        codeVerifier: verifiedState.codeVerifier,
        redirectUri,
      });

      const user = await authService.verifyGoogleIdToken(idToken);
      const sessionToken = authService.signSessionToken(user);

      reply.setCookie(SESSION_COOKIE_NAME, sessionToken, {
        httpOnly: true,
        sameSite: 'lax',
        secure: isSecure,
        path: '/',
        maxAge: 7 * 24 * 3600,
      });

      const isAllowed = authService.isEmailAllowed(user.email);
      const targetUrl = isAllowed ? `${baseUrl}/` : `${baseUrl}/?auth_error=forbidden`;
      return reply.redirect(targetUrl, 302);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : 'OAuth exchange failed';
      return reply.status(500).send({
        error: 'OAuth exchange failed',
        message: msg,
      });
    }
  });

  // POST /api/auth/mobile/google - Exchange Google ID token for Android native clients
  fastify.post('/api/auth/mobile/google', async (request, reply) => {
    await authService.ensureConfigLoaded();

    const body = (request.body || {}) as MobileGoogleAuthRequest;
    const idToken = body.idToken || body.id_token;
    if (!idToken || typeof idToken !== 'string') {
      return reply.status(400).send({
        error: 'Bad Request',
        message: 'Missing idToken in request body',
      });
    }

    let user;
    try {
      user = await authService.verifyGoogleIdToken(idToken);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : 'Invalid Google ID token';
      return reply.status(401).send({
        error: 'Unauthorized',
        message: msg,
      });
    }

    if (!authService.isEmailAllowed(user.email)) {
      return reply.status(403).send({
        error: 'Forbidden',
        message:
          'Roadtrip Co-Pilot is in private preview. Your account is not on the authorized allowlist.',
      });
    }

    const token = authService.signSessionToken(user);
    const response: MobileGoogleAuthResponse = {
      token,
      user,
    };
    return reply.status(200).send(response);
  });

  // POST /api/auth/logout - Clear session cookie
  fastify.post('/api/auth/logout', async (request, reply) => {
    const baseUrl = authService.resolvePublicBaseUrl(request);
    const isSecure = baseUrl.startsWith('https://');
    reply.clearCookie(SESSION_COOKIE_NAME, {
      path: '/',
      httpOnly: true,
      sameSite: 'lax',
      secure: isSecure,
    });
    return reply.status(200).send({ success: true });
  });
};
