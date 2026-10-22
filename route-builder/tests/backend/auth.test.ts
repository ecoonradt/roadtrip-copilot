import { describe, it, expect, vi } from 'vitest';
import type { FastifyRequest } from 'fastify';
import { createApp } from '../../server/app.js';
import { AuthService, SESSION_COOKIE_NAME, OAUTH_STATE_COOKIE_NAME } from '../../server/services/authService.js';
import type { AuthStatusResponse, MobileGoogleAuthResponse } from '../../server/types/auth.js';

describe('Stateless Dual-Mode Google OIDC Auth & Allowlist Gating (Milestone 1)', () => {
  describe('1. Local Dev Bypass (AUTH_ENABLED !== "true")', () => {
    it('GET /api/auth/status reports local dev bypass user and authenticated/authorized', async () => {
      const authService = new AuthService({ authEnabled: false });
      const app = createApp({ authService });

      const res = await app.inject({
        method: 'GET',
        url: '/api/auth/status',
      });

      expect(res.statusCode).toBe(200);
      const data = res.json<AuthStatusResponse>();
      expect(data).toEqual({
        authEnabled: false,
        authenticated: true,
        authorized: true,
        user: {
          sub: 'local-dev',
          email: 'local-dev@localhost',
          name: 'Local Developer',
        },
      });
    });

    it('protected endpoints (/api/itineraries and /api/ai/status) allow access without credentials', async () => {
      const authService = new AuthService({ authEnabled: false });
      const app = createApp({
        authService,
        aiService: { getStatus: async () => ({ available: true }) } as never,
      });

      const itinsRes = await app.inject({
        method: 'GET',
        url: '/api/itineraries',
      });
      expect(itinsRes.statusCode).toBe(200);

      const aiRes = await app.inject({
        method: 'GET',
        url: '/api/ai/status',
      });
      expect(aiRes.statusCode).toBe(200);
    });
  });

  describe('2. Enforced Mode (authEnabled: true)', () => {
    const jwtSecret = 'test-jwt-secret-for-oidc-auth-milestone1-testing!';
    const allowedEmails = 'eric@example.com, alice@partner.org';

    it('GET /api/health remains publicly accessible without credentials', async () => {
      const authService = new AuthService({
        authEnabled: true,
        jwtSecret,
        allowedEmails,
      });
      const app = createApp({ authService });

      const res = await app.inject({
        method: 'GET',
        url: '/api/health',
      });

      expect(res.statusCode).toBe(200);
      expect(res.json().status).toBe('ok');
    });

    it('GET /api/auth/status without credentials reports unauthenticated and unauthorized', async () => {
      const authService = new AuthService({
        authEnabled: true,
        jwtSecret,
        allowedEmails,
      });
      const app = createApp({ authService });

      const res = await app.inject({
        method: 'GET',
        url: '/api/auth/status',
      });

      expect(res.statusCode).toBe(200);
      const data = res.json<AuthStatusResponse>();
      expect(data).toEqual({
        authEnabled: true,
        authenticated: false,
        authorized: false,
        user: null,
      });
    });

    it('unauthenticated requests to /api/itineraries and /api/ai/status return 401 Unauthorized', async () => {
      const authService = new AuthService({
        authEnabled: true,
        jwtSecret,
        allowedEmails,
      });
      const app = createApp({ authService });

      const itinsRes = await app.inject({
        method: 'GET',
        url: '/api/itineraries',
      });
      expect(itinsRes.statusCode).toBe(401);
      expect(itinsRes.json().error).toBe('Unauthorized');
      expect(itinsRes.json().message).toBe('Authentication required');

      const aiRes = await app.inject({
        method: 'GET',
        url: '/api/ai/status',
      });
      expect(aiRes.statusCode).toBe(401);
      expect(aiRes.json().error).toBe('Unauthorized');
    });

    it('tampered or invalid tokens return 401 Unauthorized', async () => {
      const authService = new AuthService({
        authEnabled: true,
        jwtSecret,
        allowedEmails,
      });
      const app = createApp({ authService });

      // Tampered cookie
      const cookieRes = await app.inject({
        method: 'GET',
        url: '/api/itineraries',
        cookies: {
          [SESSION_COOKIE_NAME]: 'invalid.header.signature',
        },
      });
      expect(cookieRes.statusCode).toBe(401);
      expect(cookieRes.json().message).toBe('Invalid or expired authentication token');

      // Tampered Bearer header
      const bearerRes = await app.inject({
        method: 'GET',
        url: '/api/itineraries',
        headers: {
          authorization: 'Bearer bad.token.value',
        },
      });
      expect(bearerRes.statusCode).toBe(401);
      expect(bearerRes.json().message).toBe('Invalid or expired authentication token');
    });

    it('expired session token returns 401 Unauthorized', async () => {
      const authService = new AuthService({
        authEnabled: true,
        jwtSecret,
        allowedEmails,
      });
      const app = createApp({ authService });

      // Generate a token expired 10 seconds ago
      const expiredToken = authService.signSessionToken(
        { sub: 'usr-1', email: 'eric@example.com', name: 'Eric' },
        -10
      );

      const res = await app.inject({
        method: 'GET',
        url: '/api/itineraries',
        cookies: {
          [SESSION_COOKIE_NAME]: expiredToken,
        },
      });

      expect(res.statusCode).toBe(401);
      expect(res.json().message).toBe('Invalid or expired authentication token');
    });

    it('verifySessionToken rejects tokens with invalid or unexpected alg header', async () => {
      const authService = new AuthService({ authEnabled: true, jwtSecret });

      // Create token with forged alg: 'none'
      const header = Buffer.from(JSON.stringify({ alg: 'none', typ: 'JWT' })).toString('base64url');
      const payload = Buffer.from(
        JSON.stringify({
          sub: 'hacker',
          email: 'eric@example.com',
          exp: Math.floor(Date.now() / 1000) + 3600,
        })
      ).toString('base64url');
      // Sign with secret so HMAC signature matches, but header has alg: 'none'
      const crypto = await import('node:crypto');
      const sig = crypto.createHmac('sha256', jwtSecret).update(`${header}.${payload}`).digest('base64url');
      const forgedToken = `${header}.${payload}.${sig}`;

      expect(authService.verifySessionToken(forgedToken)).toBeNull();
    });

    it('valid token for non-allowlisted email returns 403 Forbidden', async () => {
      const authService = new AuthService({
        authEnabled: true,
        jwtSecret,
        allowedEmails,
      });
      const app = createApp({ authService });

      const intruderToken = authService.signSessionToken({
        sub: 'intruder-1',
        email: 'intruder@example.com',
        name: 'Intruder',
      });

      // Cookie check on protected route
      const cookieRes = await app.inject({
        method: 'GET',
        url: '/api/itineraries',
        cookies: {
          [SESSION_COOKIE_NAME]: intruderToken,
        },
      });
      expect(cookieRes.statusCode).toBe(403);
      expect(cookieRes.json().error).toBe('Forbidden');
      expect(cookieRes.json().message).toContain('private preview');

      // Bearer check on protected route
      const bearerRes = await app.inject({
        method: 'GET',
        url: '/api/itineraries',
        headers: {
          authorization: `Bearer ${intruderToken}`,
        },
      });
      expect(bearerRes.statusCode).toBe(403);

      // Status endpoint reports authenticated: true, authorized: false with message
      const statusRes = await app.inject({
        method: 'GET',
        url: '/api/auth/status',
        cookies: {
          [SESSION_COOKIE_NAME]: intruderToken,
        },
      });
      expect(statusRes.statusCode).toBe(200);
      const statusData = statusRes.json<AuthStatusResponse>();
      expect(statusData.authenticated).toBe(true);
      expect(statusData.authorized).toBe(false);
      expect(statusData.user?.email).toBe('intruder@example.com');
      expect(statusData.message).toContain('private preview');
    });

    it('valid token for allowlisted email succeeds with case-insensitive matching', async () => {
      const authService = new AuthService({
        authEnabled: true,
        jwtSecret,
        allowedEmails,
      });
      const app = createApp({ authService });

      // Token has mixed-case email matching 'eric@example.com'
      const validToken = authService.signSessionToken({
        sub: 'usr-eric',
        email: 'Eric@Example.COM',
        name: 'Eric Developer',
      });

      // Via Session Cookie
      const cookieRes = await app.inject({
        method: 'GET',
        url: '/api/itineraries',
        cookies: {
          [SESSION_COOKIE_NAME]: validToken,
        },
      });
      expect(cookieRes.statusCode).toBe(200);
      expect(cookieRes.json().itineraries).toBeDefined();

      // Via Bearer Header
      const bearerRes = await app.inject({
        method: 'GET',
        url: '/api/itineraries',
        headers: {
          authorization: `Bearer ${validToken}`,
        },
      });
      expect(bearerRes.statusCode).toBe(200);

      // Status endpoint reports authenticated: true, authorized: true
      const statusRes = await app.inject({
        method: 'GET',
        url: '/api/auth/status',
        cookies: {
          [SESSION_COOKIE_NAME]: validToken,
        },
      });
      expect(statusRes.statusCode).toBe(200);
      const statusData = statusRes.json<AuthStatusResponse>();
      expect(statusData.authenticated).toBe(true);
      expect(statusData.authorized).toBe(true);
      expect(statusData.user?.email).toBe('Eric@Example.COM');
      expect(statusData.message).toBeUndefined();
    });

    it('enforces authentication on encoded paths and preserves public access on encoded public routes', async () => {
      const authService = new AuthService({
        authEnabled: true,
        jwtSecret,
        allowedEmails,
      });
      const app = createApp({ authService });

      // GET /%61pi/itineraries without credentials returns 401 Unauthorized
      const unauthGetRes = await app.inject({
        method: 'GET',
        url: '/%61pi/itineraries',
      });
      expect(unauthGetRes.statusCode).toBe(401);
      expect(unauthGetRes.json().error).toBe('Unauthorized');
      expect(unauthGetRes.json().message).toBe('Authentication required');

      // POST /%61pi/itineraries/sample.json without credentials returns 401 Unauthorized
      const unauthPostRes = await app.inject({
        method: 'POST',
        url: '/%61pi/itineraries/sample.json',
        payload: { tripName: 'Exploit Attempt' },
      });
      expect(unauthPostRes.statusCode).toBe(401);
      expect(unauthPostRes.json().error).toBe('Unauthorized');

      // GET /api/%68ealth returns 200 OK (health check remains public)
      const healthRes = await app.inject({
        method: 'GET',
        url: '/api/%68ealth',
      });
      expect(healthRes.statusCode).toBe(200);
      expect(healthRes.json().status).toBe('ok');

      // Valid credentials with GET /%61pi/itineraries succeed
      const validToken = authService.signSessionToken({
        sub: 'usr-eric',
        email: 'eric@example.com',
        name: 'Eric Developer',
      });
      const authGetRes = await app.inject({
        method: 'GET',
        url: '/%61pi/itineraries',
        cookies: {
          [SESSION_COOKIE_NAME]: validToken,
        },
      });
      expect(authGetRes.statusCode).toBe(200);
      expect(authGetRes.json().itineraries).toBeDefined();
    });
  });

  describe('3. Web OAuth2 PKCE + State Flow', () => {
    const jwtSecret = 'oauth2-pkce-jwt-secret-testing-key-12345';
    const googleClientId = 'test-google-client-id.apps.googleusercontent.com';
    const googleClientSecret = 'test-google-client-secret';
    const allowedEmails = 'driver@example.com';

    it('GET /api/auth/google respects x-forwarded-host/proto and sets PKCE cookie and redirect', async () => {
      const authService = new AuthService({
        authEnabled: true,
        jwtSecret,
        googleClientId,
        googleClientSecret,
        allowedEmails,
      });
      const app = createApp({ authService });

      const res = await app.inject({
        method: 'GET',
        url: '/api/auth/google',
        headers: {
          'x-forwarded-host': 'd123.cloudfront.net',
          'x-forwarded-proto': 'https',
        },
      });

      expect(res.statusCode).toBe(302);
      const location = res.headers.location;
      expect(location).toBeDefined();
      expect(location).toContain('https://accounts.google.com/o/oauth2/v2/auth');

      const redirectUrl = new URL(location!);
      expect(redirectUrl.searchParams.get('client_id')).toBe(googleClientId);
      expect(redirectUrl.searchParams.get('redirect_uri')).toBe(
        'https://d123.cloudfront.net/api/auth/callback/google'
      );
      expect(redirectUrl.searchParams.get('response_type')).toBe('code');
      expect(redirectUrl.searchParams.get('code_challenge_method')).toBe('S256');
      expect(redirectUrl.searchParams.get('prompt')).toBe('select_account');
      expect(redirectUrl.searchParams.get('state')).toBeTruthy();
      expect(redirectUrl.searchParams.get('code_challenge')).toBeTruthy();

      // Check copilot_oauth_state cookie
      const setCookie = res.headers['set-cookie'];
      expect(setCookie).toBeDefined();
      const cookieStr = Array.isArray(setCookie) ? setCookie.join(';') : String(setCookie);
      expect(cookieStr).toContain(`${OAUTH_STATE_COOKIE_NAME}=`);
      expect(cookieStr.toLowerCase()).toContain('httponly');
      expect(cookieStr.toLowerCase()).toContain('samesite=lax');
      expect(cookieStr.toLowerCase()).toContain('secure');
    });

    it('GET /api/auth/callback/google rejects mismatched or tampered state with 400', async () => {
      const authService = new AuthService({
        authEnabled: true,
        jwtSecret,
        googleClientId,
        googleClientSecret,
        allowedEmails,
      });
      const app = createApp({ authService });

      // 1. Missing cookie & state
      const res1 = await app.inject({
        method: 'GET',
        url: '/api/auth/callback/google',
      });
      expect(res1.statusCode).toBe(400);

      // 2. Mismatched state in query vs cookie
      const { stateCookieToken } = authService.createOAuthStateAndChallenge();
      const res2 = await app.inject({
        method: 'GET',
        url: '/api/auth/callback/google?code=fake-code&state=different-state',
        cookies: {
          [OAUTH_STATE_COOKIE_NAME]: stateCookieToken,
        },
      });
      expect(res2.statusCode).toBe(400);
      expect(res2.json().error).toContain('Invalid OAuth state');
    });

    it('GET /api/auth/callback/google completes OAuth exchange, sets session cookie and redirects', async () => {
      let codeExchanged = false;
      let idTokenVerified = false;

      const authService = new AuthService({
        authEnabled: true,
        jwtSecret,
        googleClientId,
        googleClientSecret,
        allowedEmails,
        exchangeGoogleCodeFn: async (params) => {
          codeExchanged = true;
          expect(params.code).toBe('test-auth-code-123');
          expect(params.clientId).toBe(googleClientId);
          expect(params.clientSecret).toBe(googleClientSecret);
          expect(params.redirectUri).toBe('https://d123.cloudfront.net/api/auth/callback/google');
          expect(params.codeVerifier).toBeTruthy();
          return { idToken: 'mock-google-id-token' };
        },
        verifyGoogleIdTokenFn: async (idToken, clientId) => {
          idTokenVerified = true;
          expect(idToken).toBe('mock-google-id-token');
          expect(clientId).toBe(googleClientId);
          return {
            sub: 'google-uid-1',
            email: 'driver@example.com',
            name: 'Road Driver',
            picture: 'https://example.com/pic.jpg',
          };
        },
      });
      const app = createApp({ authService });

      // Step 1: Initiate OAuth flow to get state and state cookie
      const initRes = await app.inject({
        method: 'GET',
        url: '/api/auth/google',
        headers: {
          'x-forwarded-host': 'd123.cloudfront.net',
          'x-forwarded-proto': 'https',
        },
      });
      expect(initRes.statusCode).toBe(302);
      const initUrl = new URL(initRes.headers.location!);
      const state = initUrl.searchParams.get('state')!;

      // Extract oauth state cookie
      const cookieHeader = initRes.headers['set-cookie'];
      const cookieStr = Array.isArray(cookieHeader) ? cookieHeader[0] : String(cookieHeader);
      const stateCookieMatch = cookieStr.match(new RegExp(`${OAUTH_STATE_COOKIE_NAME}=([^;]+)`));
      expect(stateCookieMatch).toBeTruthy();
      const stateCookieValue = stateCookieMatch![1];

      // Step 2: Callback with valid code and state
      const callbackRes = await app.inject({
        method: 'GET',
        url: `/api/auth/callback/google?code=test-auth-code-123&state=${state}`,
        headers: {
          'x-forwarded-host': 'd123.cloudfront.net',
          'x-forwarded-proto': 'https',
        },
        cookies: {
          [OAUTH_STATE_COOKIE_NAME]: stateCookieValue,
        },
      });

      expect(codeExchanged).toBe(true);
      expect(idTokenVerified).toBe(true);
      expect(callbackRes.statusCode).toBe(302);
      expect(callbackRes.headers.location).toBe('https://d123.cloudfront.net/');

      // Session cookie is set and oauth state cookie is cleared
      const setCookies = callbackRes.headers['set-cookie'];
      const setCookieArr = Array.isArray(setCookies) ? setCookies : [String(setCookies)];
      const sessionCookie = setCookieArr.find((c) => c.startsWith(`${SESSION_COOKIE_NAME}=`));
      expect(sessionCookie).toBeDefined();
      expect(sessionCookie!.toLowerCase()).toContain('httponly');
      expect(sessionCookie!.toLowerCase()).toContain('samesite=lax');
      expect(sessionCookie!.toLowerCase()).toContain('secure');
    });

    it('GET /api/auth/callback/google redirects to /?auth_error=forbidden when email is not allowlisted', async () => {
      const authService = new AuthService({
        authEnabled: true,
        jwtSecret,
        googleClientId,
        googleClientSecret,
        allowedEmails: 'allowed-only@example.com',
        exchangeGoogleCodeFn: async () => ({ idToken: 'valid-id-token' }),
        verifyGoogleIdTokenFn: async () => ({
          sub: 'unauthorized-user',
          email: 'not-allowed@example.com',
          name: 'Not Allowed',
        }),
      });
      const app = createApp({ authService });

      const { state, stateCookieToken } = authService.createOAuthStateAndChallenge();

      const callbackRes = await app.inject({
        method: 'GET',
        url: `/api/auth/callback/google?code=test-code&state=${state}`,
        headers: {
          'x-forwarded-host': 'd123.cloudfront.net',
          'x-forwarded-proto': 'https',
        },
        cookies: {
          [OAUTH_STATE_COOKIE_NAME]: stateCookieToken,
        },
      });

      expect(callbackRes.statusCode).toBe(302);
      expect(callbackRes.headers.location).toBe('https://d123.cloudfront.net/?auth_error=forbidden');

      // Still sets session cookie so /api/auth/status knows who they are and shows 403 preview screen
      const setCookies = callbackRes.headers['set-cookie'];
      const setCookieArr = Array.isArray(setCookies) ? setCookies : [String(setCookies)];
      const sessionCookie = setCookieArr.find((c) => c.startsWith(`${SESSION_COOKIE_NAME}=`));
      expect(sessionCookie).toBeDefined();
    });

    it('GET /api/auth/callback/google clears state cookie and redirects to / when query.error is present', async () => {
      const authService = new AuthService({
        authEnabled: true,
        jwtSecret,
        googleClientId,
        googleClientSecret,
      });
      const app = createApp({ authService });

      const res = await app.inject({
        method: 'GET',
        url: '/api/auth/callback/google?error=access_denied&error_description=User+cancelled',
        headers: {
          'x-forwarded-host': 'd123.cloudfront.net',
          'x-forwarded-proto': 'https',
        },
        cookies: {
          [OAUTH_STATE_COOKIE_NAME]: 'mock-oauth-state-cookie',
        },
      });

      expect(res.statusCode).toBe(302);
      expect(res.headers.location).toBe('https://d123.cloudfront.net/');
      const setCookies = res.headers['set-cookie'];
      const setCookieArr = Array.isArray(setCookies) ? setCookies : [String(setCookies)];
      const clearedStateCookie = setCookieArr.find((c) => c.startsWith(`${OAUTH_STATE_COOKIE_NAME}=`));
      expect(clearedStateCookie).toBeDefined();
      expect(clearedStateCookie).toContain('Max-Age=0');
    });

    it('GET /api/auth/google returns 503 Service Unavailable when OAuth credentials are not configured', async () => {
      const authService = new AuthService({ authEnabled: true }); // missing googleClientId and jwtSecret
      const app = createApp({ authService });

      const res = await app.inject({
        method: 'GET',
        url: '/api/auth/google',
      });

      expect(res.statusCode).toBe(503);
      expect(res.json().error).toBe('Service Unavailable');
      expect(res.json().message).toContain('missing OAuth credentials');
    });

    it('resolvePublicBaseUrl rejects untrusted host and re-validates fallback host', async () => {
      const authService = new AuthService({ authEnabled: true, jwtSecret, googleClientId });
      const app = createApp({ authService });

      // Direct caller attempting host header poisoning on both forwarded host and host header
      const res = await app.inject({
        method: 'GET',
        url: '/api/auth/google',
        headers: {
          'x-forwarded-host': 'evil-attacker.com',
          host: 'evil-host.com',
          'x-forwarded-proto': 'https',
        },
      });

      expect(res.statusCode).toBe(302);
      const location = res.headers.location as string;
      // Must not redirect to evil-attacker.com or evil-host.com
      expect(location).not.toContain('evil-attacker.com');
      expect(location).not.toContain('evil-host.com');
      expect(location).toContain(encodeURIComponent('/api/auth/callback/google'));
      expect(decodeURIComponent(location)).toContain('localhost:3001');
    });

    it('resolvePublicBaseUrl trusts custom domain when verified by edge origin header', async () => {
      const authService = new AuthService({
        authEnabled: true,
        jwtSecret,
        googleClientId,
        originVerifySecret: 'test-strong-origin-verify-secret-token',
      });
      const app = createApp({ authService });

      const res = await app.inject({
        method: 'GET',
        url: '/api/auth/google',
        headers: {
          'x-forwarded-host': 'copilot.roadtrip.com',
          'x-copilot-origin-verify': 'test-strong-origin-verify-secret-token',
        },
      });

      expect(res.statusCode).toBe(302);
      const location = res.headers.location as string;
      expect(location).toContain(
        encodeURIComponent('https://copilot.roadtrip.com/api/auth/callback/google')
      );
    });

    it('resolvePublicBaseUrl rejects custom domain when edge origin secret does not match or differs in length', async () => {
      const authService = new AuthService({
        authEnabled: true,
        jwtSecret,
        googleClientId,
        originVerifySecret: 'correct-secret-12345678',
      });
      const app = createApp({ authService });

      // Wrong secret (different length)
      const res1 = await app.inject({
        method: 'GET',
        url: '/api/auth/google',
        headers: {
          'x-forwarded-host': 'attacker-domain.com',
          host: 'attacker-domain.com',
          'x-copilot-origin-verify': 'wrong',
        },
      });
      expect(res1.statusCode).toBe(302);
      expect(res1.headers.location).not.toContain('attacker-domain.com');
      expect(decodeURIComponent(res1.headers.location as string)).toContain('localhost:3001');

      // Wrong secret (same length)
      const res2 = await app.inject({
        method: 'GET',
        url: '/api/auth/google',
        headers: {
          'x-forwarded-host': 'attacker-domain.com',
          host: 'attacker-domain.com',
          'x-copilot-origin-verify': 'incorrect-secret-9999',
        },
      });
      expect(res2.statusCode).toBe(302);
      expect(res2.headers.location).not.toContain('attacker-domain.com');
      expect(decodeURIComponent(res2.headers.location as string)).toContain('localhost:3001');
    });

    it('resolvePublicBaseUrl trusts custom domain when listed in allowedHosts', async () => {
      const authService = new AuthService({
        authEnabled: true,
        jwtSecret,
        googleClientId,
        allowedHosts: 'custom.roadtrip.com',
      });
      const app = createApp({ authService });

      const res = await app.inject({
        method: 'GET',
        url: '/api/auth/google',
        headers: {
          'x-forwarded-host': 'custom.roadtrip.com',
          'x-forwarded-proto': 'https',
        },
      });

      expect(res.statusCode).toBe(302);
      const location = res.headers.location as string;
      expect(location).toContain(
        encodeURIComponent('https://custom.roadtrip.com/api/auth/callback/google')
      );
    });

    it('resolvePublicBaseUrl uses publicBaseUrl unconditionally when configured', async () => {
      const authService = new AuthService({
        authEnabled: true,
        jwtSecret,
        googleClientId,
        publicBaseUrl: 'https://authoritative.roadtrip.com',
      });
      const app = createApp({ authService });

      const res = await app.inject({
        method: 'GET',
        url: '/api/auth/google',
        headers: {
          'x-forwarded-host': 'd123.cloudfront.net',
        },
      });

      expect(res.statusCode).toBe(302);
      const location = res.headers.location as string;
      expect(location).toContain(
        encodeURIComponent('https://authoritative.roadtrip.com/api/auth/callback/google')
      );
    });
  });

  describe('4. Android Mobile OIDC Flow (POST /api/auth/mobile/google)', () => {
    const jwtSecret = 'android-mobile-oidc-jwt-secret-testing-12345';
    const googleClientId = 'android-client-id.apps.googleusercontent.com';
    const allowedEmails = 'mobile-pilot@example.com';

    it('returns 503 Service Unavailable when OAuth credentials are not configured', async () => {
      const authService = new AuthService({ authEnabled: true });
      const app = createApp({ authService });

      const res = await app.inject({
        method: 'POST',
        url: '/api/auth/mobile/google',
        payload: { idToken: 'some-token' },
      });

      expect(res.statusCode).toBe(503);
      expect(res.json().error).toBe('Service Unavailable');
    });

    it('returns 400 Bad Request when idToken is missing in request body', async () => {
      const authService = new AuthService({
        authEnabled: true,
        jwtSecret,
        googleClientId,
        allowedEmails,
      });
      const app = createApp({ authService });

      const res = await app.inject({
        method: 'POST',
        url: '/api/auth/mobile/google',
        payload: {},
      });

      expect(res.statusCode).toBe(400);
      expect(res.json().message).toContain('Missing idToken');
    });

    it('returns 401 Unauthorized when Google ID token verification fails', async () => {
      const authService = new AuthService({
        authEnabled: true,
        jwtSecret,
        googleClientId,
        allowedEmails,
        verifyGoogleIdTokenFn: async () => {
          throw new Error('Token expired or invalid signature');
        },
      });
      const app = createApp({ authService });

      const res = await app.inject({
        method: 'POST',
        url: '/api/auth/mobile/google',
        payload: { idToken: 'invalid-id-token' },
      });

      expect(res.statusCode).toBe(401);
      expect(res.json().message).toContain('Token expired or invalid signature');
    });

    it('returns 403 Forbidden when authenticated Google account is not on allowlist', async () => {
      const authService = new AuthService({
        authEnabled: true,
        jwtSecret,
        googleClientId,
        allowedEmails,
        verifyGoogleIdTokenFn: async () => ({
          sub: 'intruder-id',
          email: 'random@gmail.com',
          name: 'Random User',
        }),
      });
      const app = createApp({ authService });

      const res = await app.inject({
        method: 'POST',
        url: '/api/auth/mobile/google',
        payload: { idToken: 'valid-token-for-unauthorized-email' },
      });

      expect(res.statusCode).toBe(403);
      expect(res.json().message).toContain('private preview');
    });

    it('returns 200 with Bearer token when allowlisted, and token authenticates /api/itineraries', async () => {
      const authService = new AuthService({
        authEnabled: true,
        jwtSecret,
        googleClientId,
        allowedEmails,
        verifyGoogleIdTokenFn: async (idToken) => {
          expect(idToken).toBe('valid-android-id-token');
          return {
            sub: 'google-android-sub-1',
            email: 'Mobile-Pilot@Example.com', // test case-insensitivity
            name: 'Mobile Pilot',
          };
        },
      });
      const app = createApp({ authService });

      // 1. Authenticate mobile client
      const authRes = await app.inject({
        method: 'POST',
        url: '/api/auth/mobile/google',
        payload: { idToken: 'valid-android-id-token' },
      });

      expect(authRes.statusCode).toBe(200);
      const data = authRes.json<MobileGoogleAuthResponse>();
      expect(data.token).toBeTruthy();
      expect(data.user.email).toBe('Mobile-Pilot@Example.com');

      // 2. Use returned token to access protected /api/itineraries
      const itinsRes = await app.inject({
        method: 'GET',
        url: '/api/itineraries',
        headers: {
          authorization: `Bearer ${data.token}`,
        },
      });

      expect(itinsRes.statusCode).toBe(200);
      expect(itinsRes.json().itineraries).toBeDefined();
    });
  });

  describe('5. Logout (POST /api/auth/logout)', () => {
    it('clears copilot_session cookie and returns success: true', async () => {
      const authService = new AuthService({ authEnabled: true, jwtSecret: 'logout-test-secret' });
      const app = createApp({ authService });

      const res = await app.inject({
        method: 'POST',
        url: '/api/auth/logout',
      });

      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual({ success: true });

      const setCookies = res.headers['set-cookie'];
      expect(setCookies).toBeDefined();
      const cookieStr = Array.isArray(setCookies) ? setCookies.join(';') : String(setCookies);
      expect(cookieStr).toContain(`${SESSION_COOKIE_NAME}=`);
      // Cookie is expired/cleared
      expect(cookieStr).toMatch(/expires=thu, 01 jan 1970|max-age=0/i);
    });
  });

  describe('6. SSM Parameter Store Lazy Loading', () => {
    it('calls ssmLoader once and caches loaded secrets in memory', async () => {
      const mockLoader = vi.fn().mockResolvedValue({
        '/roadtrip/jwt-secret': 'loaded-jwt-secret-from-ssm',
        '/roadtrip/allowed-emails': 'ssm-user@example.com',
        '/roadtrip/google-client-id': 'ssm-client-id',
      });

      const authService = new AuthService({
        authEnabled: true,
        ssmParamNames: {
          jwtSecret: '/roadtrip/jwt-secret',
          allowedEmails: '/roadtrip/allowed-emails',
          googleClientId: '/roadtrip/google-client-id',
        },
        ssmLoader: mockLoader,
      });

      const app = createApp({ authService });

      // First call triggers SSM load
      const res1 = await app.inject({
        method: 'GET',
        url: '/api/auth/status',
      });
      expect(res1.statusCode).toBe(200);
      expect(mockLoader).toHaveBeenCalledTimes(1);
      expect(mockLoader).toHaveBeenCalledWith([
        '/roadtrip/google-client-id',
        '/roadtrip/jwt-secret',
        '/roadtrip/allowed-emails',
      ]);

      // Second call uses cached config and does not invoke SSM again
      const res2 = await app.inject({
        method: 'GET',
        url: '/api/auth/status',
      });
      expect(res2.statusCode).toBe(200);
      expect(mockLoader).toHaveBeenCalledTimes(1);

      // Verify the loaded values function properly
      expect(authService.getJwtSecret()).toBe('loaded-jwt-secret-from-ssm');
      expect(authService.isEmailAllowed('ssm-user@example.com')).toBe(true);
      expect(authService.isEmailAllowed('other@example.com')).toBe(false);
    });

    it('never calls ssmLoader when auth is disabled', async () => {
      const mockLoader = vi.fn().mockResolvedValue({});
      const authService = new AuthService({
        authEnabled: false,
        ssmParamNames: {
          jwtSecret: '/roadtrip/jwt-secret',
        },
        ssmLoader: mockLoader,
      });

      const app = createApp({ authService });
      await app.inject({ method: 'GET', url: '/api/auth/status' });

      expect(mockLoader).not.toHaveBeenCalled();
    });

    it('honors retry cooldown on SSM failure and re-queries after 15-minute TTL', async () => {
      let callCount = 0;
      const mockLoader = vi.fn().mockImplementation(async () => {
        callCount++;
        if (callCount === 1) {
          // First attempt: missing parameter
          return {};
        }
        return {
          '/roadtrip/jwt-secret': 'loaded-after-retry',
        };
      });

      const authService = new AuthService({
        authEnabled: true,
        ssmParamNames: {
          jwtSecret: '/roadtrip/jwt-secret',
        },
        ssmLoader: mockLoader,
      });

      const app = createApp({ authService });

      // First call attempts load and fails (missing parameter)
      await app.inject({ method: 'GET', url: '/api/auth/status' });
      expect(mockLoader).toHaveBeenCalledTimes(1);

      // Immediate second call should be suppressed by 30-second cooldown
      await app.inject({ method: 'GET', url: '/api/auth/status' });
      expect(mockLoader).toHaveBeenCalledTimes(1);

      // Advance clock past 30-second cooldown
      const realNow = Date.now;
      try {
        Date.now = () => realNow() + 31 * 1000;
        await app.inject({ method: 'GET', url: '/api/auth/status' });
        expect(mockLoader).toHaveBeenCalledTimes(2);
        expect(authService.getJwtSecret()).toBe('loaded-after-retry');

        // Within 15-minute TTL, further requests are cached
        await app.inject({ method: 'GET', url: '/api/auth/status' });
        expect(mockLoader).toHaveBeenCalledTimes(2);

        // Advance clock past 15-minute TTL (31s + 902s = 933s)
        Date.now = () => realNow() + (31 + 902) * 1000;
        await app.inject({ method: 'GET', url: '/api/auth/status' });
        expect(mockLoader).toHaveBeenCalledTimes(3);
      } finally {
        Date.now = realNow;
      }
    });

    it('honors retry cooldown if SSM refresh fails after 15-minute TTL expires', async () => {
      let callCount = 0;
      const mockLoader = vi.fn().mockImplementation(async () => {
        callCount++;
        if (callCount === 1) {
          return { '/roadtrip/jwt-secret': 'initial-cached-secret' };
        }
        // Refresh after TTL fails
        throw new Error('SSM service unreachable or KMS error');
      });

      const authService = new AuthService({
        authEnabled: true,
        ssmParamNames: {
          jwtSecret: '/roadtrip/jwt-secret',
        },
        ssmLoader: mockLoader,
      });

      const app = createApp({ authService });

      // Initial successful load
      await app.inject({ method: 'GET', url: '/api/auth/status' });
      expect(mockLoader).toHaveBeenCalledTimes(1);
      expect(authService.getJwtSecret()).toBe('initial-cached-secret');

      const realNow = Date.now;
      try {
        // Advance clock past 15-minute TTL (16 minutes)
        Date.now = () => realNow() + 16 * 60 * 1000;

        // First call after TTL expiry attempts refresh and encounters error; serves cached secret
        await app.inject({ method: 'GET', url: '/api/auth/status' });
        expect(mockLoader).toHaveBeenCalledTimes(2);
        expect(authService.getJwtSecret()).toBe('initial-cached-secret');

        // Immediate subsequent request within 30-second cooldown: suppressed!
        await app.inject({ method: 'GET', url: '/api/auth/status' });
        expect(mockLoader).toHaveBeenCalledTimes(2);
        expect(authService.getJwtSecret()).toBe('initial-cached-secret');
      } finally {
        Date.now = realNow;
      }
    });

    it('loads publicBaseUrl from SSM parameter store when configured', async () => {
      const mockLoader = vi.fn().mockResolvedValue({
        '/roadtrip/public-base-url': 'https://custom-ssm.roadtrip.com',
        '/roadtrip/jwt-secret': 'some-secret',
      });

      const authService = new AuthService({
        authEnabled: true,
        ssmParamNames: {
          publicBaseUrl: '/roadtrip/public-base-url',
          jwtSecret: '/roadtrip/jwt-secret',
        },
        ssmLoader: mockLoader,
      });

      const app = createApp({ authService });
      await app.inject({ method: 'GET', url: '/api/auth/status' });

      // FastifyRequest mock for resolvePublicBaseUrl
      const mockReq = {
        headers: {},
        protocol: 'http',
      } as unknown as FastifyRequest;
      expect(authService.resolvePublicBaseUrl(mockReq)).toBe('https://custom-ssm.roadtrip.com');
    });

    it('caches configuration and does not trigger repeated SSM reloads when optional publicBaseUrl is absent from SSM', async () => {
      const mockLoader = vi.fn().mockResolvedValue({
        '/roadtrip/jwt-secret': 'jwt-secret-val',
        '/roadtrip/google-client-id': 'client-id-val',
        '/roadtrip/google-client-secret': 'client-secret-val',
        '/roadtrip/allowed-emails': 'allowed@example.com',
        // Note: '/roadtrip/public-base-url' is deliberately omitted from SSM results
      });

      const authService = new AuthService({
        authEnabled: true,
        ssmParamNames: {
          jwtSecret: '/roadtrip/jwt-secret',
          googleClientId: '/roadtrip/google-client-id',
          googleClientSecret: '/roadtrip/google-client-secret',
          allowedEmails: '/roadtrip/allowed-emails',
          publicBaseUrl: '/roadtrip/public-base-url',
        },
        ssmLoader: mockLoader,
      });

      const app = createApp({ authService });

      // First request triggers initial SSM load
      const res1 = await app.inject({ method: 'GET', url: '/api/auth/status' });
      expect(res1.statusCode).toBe(200);
      expect(mockLoader).toHaveBeenCalledTimes(1);
      expect(authService.isConfigLoaded()).toBe(true);

      // Subsequent requests within cache TTL must use cached configuration without calling SSM
      const res2 = await app.inject({ method: 'GET', url: '/api/auth/status' });
      expect(res2.statusCode).toBe(200);
      expect(mockLoader).toHaveBeenCalledTimes(1);

      const res3 = await app.inject({ method: 'GET', url: '/api/health' });
      expect(res3.statusCode).toBe(200);
      expect(mockLoader).toHaveBeenCalledTimes(1);
    });

    it('loads originVerifySecret from SSM parameter store and validates edge requests', async () => {
      const mockLoader = vi.fn().mockResolvedValue({
        '/roadtrip/origin-verify-secret': 'ssm-loaded-edge-secret-xyz',
        '/roadtrip/jwt-secret': 'some-secret-key',
        '/roadtrip/google-client-id': 'ssm-google-client-id',
      });

      const authService = new AuthService({
        authEnabled: true,
        ssmParamNames: {
          originVerifySecret: '/roadtrip/origin-verify-secret',
          jwtSecret: '/roadtrip/jwt-secret',
          googleClientId: '/roadtrip/google-client-id',
        },
        ssmLoader: mockLoader,
      });

      const app = createApp({ authService });

      const res = await app.inject({
        method: 'GET',
        url: '/api/auth/google',
        headers: {
          'x-forwarded-host': 'ssm-custom-domain.roadtrip.com',
          'x-copilot-origin-verify': 'ssm-loaded-edge-secret-xyz',
        },
      });

      expect(res.statusCode).toBe(302);
      expect(res.headers.location).toContain(
        encodeURIComponent('https://ssm-custom-domain.roadtrip.com/api/auth/callback/google')
      );
    });

    it('logs warning when originVerifySecret is absent in auth-enabled mode', async () => {
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
      const authService = new AuthService({
        authEnabled: true,
        jwtSecret: 'some-secret',
        googleClientId: 'client-id',
      });
      await authService.ensureConfigLoaded();

      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining('Edge origin verification secret is not configured or failed to load')
      );
      warnSpy.mockRestore();
    });
  });
});

