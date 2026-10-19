import crypto from 'node:crypto';
import type { FastifyRequest } from 'fastify';
import type { AuthUser } from '../types/auth.js';

export const SESSION_COOKIE_NAME = 'copilot_session';
export const OAUTH_STATE_COOKIE_NAME = 'copilot_oauth_state';

export const LOCAL_DEV_USER: AuthUser = {
  sub: 'local-dev',
  email: 'local-dev@localhost',
  name: 'Local Developer',
};

export interface SsmParamNames {
  googleClientId?: string;
  googleClientSecret?: string;
  jwtSecret?: string;
  allowedEmails?: string;
  publicBaseUrl?: string;
}

export interface AuthServiceOptions {
  authEnabled?: boolean;
  allowedEmails?: string | string[];
  googleClientId?: string;
  googleClientSecret?: string;
  jwtSecret?: string;
  publicBaseUrl?: string;
  originVerifySecret?: string;
  allowedHosts?: string | string[];
  ssmParamNames?: SsmParamNames;
  ssmLoader?: (paramNames: string[]) => Promise<Record<string, string>>;
  verifyGoogleIdTokenFn?: (idToken: string, clientId: string) => Promise<AuthUser>;
  exchangeGoogleCodeFn?: (params: {
    code: string;
    codeVerifier: string;
    redirectUri: string;
    clientId: string;
    clientSecret: string;
  }) => Promise<{ idToken: string }>;
}

interface OAuthStatePayload {
  state: string;
  codeVerifier: string;
  typ: 'oauth_state';
  iat: number;
  exp: number;
}

export class AuthService {
  private options: AuthServiceOptions;
  private authEnabled?: boolean;
  private allowedEmails: string | string[];
  private googleClientId: string;
  private googleClientSecret: string;
  private jwtSecret: string;
  private publicBaseUrl: string;
  private originVerifySecret: string;
  private allowedHosts: string | string[];
  private configLoaded = false;
  private configLoadedAt = 0;
  private lastLoadAttemptAt = 0;
  private loadPromise: Promise<void> | null = null;

  public static readonly CONFIG_CACHE_TTL_MS = 15 * 60 * 1000; // 15-minute cache TTL for warm Lambda instances
  public static readonly LOAD_RETRY_COOLDOWN_MS = 30 * 1000; // 30-second cooldown on SSM resolution failure
  private static readonly SAFE_HOST_PATTERN =
    /^(localhost|127\.0\.0\.1)(:[0-9]+)?$|^[a-z0-9-]+\.cloudfront\.net$/i;

  constructor(options: AuthServiceOptions = {}) {
    this.options = options;
    this.authEnabled = options.authEnabled;
    this.allowedEmails = options.allowedEmails ?? process.env.ALLOWED_EMAILS ?? '';
    this.googleClientId = options.googleClientId ?? process.env.GOOGLE_CLIENT_ID ?? '';
    this.googleClientSecret = options.googleClientSecret ?? process.env.GOOGLE_CLIENT_SECRET ?? '';
    this.jwtSecret = options.jwtSecret ?? process.env.JWT_SECRET ?? '';
    this.publicBaseUrl = options.publicBaseUrl ?? process.env.PUBLIC_BASE_URL ?? '';
    this.originVerifySecret =
      options.originVerifySecret ?? process.env.ORIGIN_VERIFY_SECRET ?? '';
    this.allowedHosts = options.allowedHosts ?? process.env.ALLOWED_HOSTS ?? '';
  }

  isAuthEnabled(): boolean {
    if (this.options.authEnabled !== undefined) {
      return this.options.authEnabled;
    }
    if (this.authEnabled !== undefined) {
      return this.authEnabled;
    }
    return process.env.AUTH_ENABLED === 'true';
  }

  getGoogleClientId(): string {
    return this.googleClientId || process.env.GOOGLE_CLIENT_ID || '';
  }

  getGoogleClientSecret(): string {
    return this.googleClientSecret || process.env.GOOGLE_CLIENT_SECRET || '';
  }

  getJwtSecret(): string {
    const secret = this.jwtSecret || process.env.JWT_SECRET || '';
    if (secret) return secret;
    if (!this.isAuthEnabled()) return 'dev-insecure-jwt-secret-roadtrip-copilot';
    return '';
  }

  getAllowedEmails(): string | string[] {
    if (this.allowedEmails !== undefined && this.allowedEmails !== '') {
      return this.allowedEmails;
    }
    return process.env.ALLOWED_EMAILS || '';
  }

  private parseAllowedEmails(raw: string | string[]): Set<string> {
    const set = new Set<string>();
    if (Array.isArray(raw)) {
      for (const e of raw) {
        const trimmed = e.trim().toLowerCase();
        if (trimmed) set.add(trimmed);
      }
    } else if (typeof raw === 'string') {
      const parts = raw.split(/[,;\s]+/);
      for (const part of parts) {
        const trimmed = part.trim().toLowerCase();
        if (trimmed) set.add(trimmed);
      }
    }
    return set;
  }

  isEmailAllowed(email: string): boolean {
    if (!email || typeof email !== 'string') return false;
    const raw = this.getAllowedEmails();
    const set = this.parseAllowedEmails(raw);
    if (set.size === 0) return false;
    return set.has(email.trim().toLowerCase());
  }

  isConfigLoaded(): boolean {
    return this.configLoaded;
  }

  private parseAllowedHosts(): Set<string> {
    const set = new Set<string>();
    const raw = this.allowedHosts;
    if (Array.isArray(raw)) {
      for (const h of raw) {
        const trimmed = h.trim().toLowerCase();
        if (trimmed) set.add(trimmed);
      }
    } else if (typeof raw === 'string') {
      const parts = raw.split(/[,;\s]+/);
      for (const part of parts) {
        const trimmed = part.trim().toLowerCase();
        if (trimmed) set.add(trimmed);
      }
    }
    return set;
  }

  isHostAllowed(host: string): boolean {
    if (!host || typeof host !== 'string') return false;
    const trimmed = host.trim();
    if (AuthService.SAFE_HOST_PATTERN.test(trimmed)) return true;
    return this.parseAllowedHosts().has(trimmed.toLowerCase());
  }

  async ensureConfigLoaded(): Promise<void> {
    const now = Date.now();
    if (this.configLoaded && now - this.configLoadedAt < AuthService.CONFIG_CACHE_TTL_MS) {
      return;
    }
    if (this.loadPromise) return this.loadPromise;
    // Enforce cooldown between retry attempts whether initial load or refresh after TTL
    if (now - this.lastLoadAttemptAt < AuthService.LOAD_RETRY_COOLDOWN_MS) {
      return;
    }

    this.loadPromise = (async () => {
      try {
        if (!this.isAuthEnabled()) {
          this.configLoaded = true;
          this.configLoadedAt = Date.now();
          return;
        }

        const needed: {
          key: 'googleClientId' | 'googleClientSecret' | 'jwtSecret' | 'allowedEmails' | 'publicBaseUrl';
          paramName: string;
        }[] = [];

        const clientIdParam =
          this.options.ssmParamNames?.googleClientId || process.env.GOOGLE_CLIENT_ID_SSM_PARAM;
        const staticClientId = this.options.googleClientId ?? process.env.GOOGLE_CLIENT_ID;
        if (!staticClientId && clientIdParam) {
          needed.push({ key: 'googleClientId', paramName: clientIdParam });
        }

        const clientSecretParam =
          this.options.ssmParamNames?.googleClientSecret ||
          process.env.GOOGLE_CLIENT_SECRET_SSM_PARAM;
        const staticClientSecret =
          this.options.googleClientSecret ?? process.env.GOOGLE_CLIENT_SECRET;
        if (!staticClientSecret && clientSecretParam) {
          needed.push({ key: 'googleClientSecret', paramName: clientSecretParam });
        }

        const jwtSecretParam =
          this.options.ssmParamNames?.jwtSecret || process.env.JWT_SECRET_SSM_PARAM;
        const staticJwtSecret = this.options.jwtSecret ?? process.env.JWT_SECRET;
        if (!staticJwtSecret && jwtSecretParam) {
          needed.push({ key: 'jwtSecret', paramName: jwtSecretParam });
        }

        const allowedEmailsParam =
          this.options.ssmParamNames?.allowedEmails || process.env.ALLOWED_EMAILS_SSM_PARAM;
        const staticAllowed = this.options.allowedEmails ?? process.env.ALLOWED_EMAILS;
        const hasStaticAllowed =
          staticAllowed !== undefined &&
          (Array.isArray(staticAllowed) ? staticAllowed.length > 0 : Boolean(staticAllowed.trim()));
        if (!hasStaticAllowed && allowedEmailsParam) {
          needed.push({ key: 'allowedEmails', paramName: allowedEmailsParam });
        }

        const publicBaseUrlParam =
          this.options.ssmParamNames?.publicBaseUrl || process.env.PUBLIC_BASE_URL_SSM_PARAM;
        const staticPublicBaseUrl = this.options.publicBaseUrl ?? process.env.PUBLIC_BASE_URL;
        if (!staticPublicBaseUrl && publicBaseUrlParam) {
          needed.push({ key: 'publicBaseUrl', paramName: publicBaseUrlParam });
        }

        if (needed.length > 0) {
          const paramNames = Array.from(new Set(needed.map((n) => n.paramName)));
          let allLoaded = true;
          try {
            const loader = this.options.ssmLoader || this.defaultSsmLoader.bind(this);
            const loaded = await loader(paramNames);
            for (const item of needed) {
              const val = loaded[item.paramName];
              if (val !== undefined) {
                if (item.key === 'googleClientId') this.googleClientId = val;
                else if (item.key === 'googleClientSecret') this.googleClientSecret = val;
                else if (item.key === 'jwtSecret') this.jwtSecret = val;
                else if (item.key === 'allowedEmails') this.allowedEmails = val;
                else if (item.key === 'publicBaseUrl') this.publicBaseUrl = val;
              } else {
                allLoaded = false;
              }
            }
            if (allLoaded) {
              this.configLoaded = true;
              this.configLoadedAt = Date.now();
            } else {
              console.warn(
                `[AuthService] Partial SSM parameter load; some required parameters were missing.${
                  this.configLoaded
                    ? ' Serving with existing cached credentials for next cooldown period.'
                    : ''
                }`
              );
            }
          } catch (err: unknown) {
            const msg = err instanceof Error ? err.message : String(err);
            console.warn(
              `[AuthService] Failed to load parameters from SSM: ${msg}.${
                this.configLoaded
                  ? ' Serving with existing cached credentials for next cooldown period.'
                  : ''
              }`
            );
          }
        } else {
          this.configLoaded = true;
          this.configLoadedAt = Date.now();
        }
      } finally {
        this.lastLoadAttemptAt = Date.now();
        this.loadPromise = null;
      }
    })();

    return this.loadPromise;
  }

  private async defaultSsmLoader(paramNames: string[]): Promise<Record<string, string>> {
    if (paramNames.length === 0) return {};
    const { SSMClient, GetParametersCommand } = await import('@aws-sdk/client-ssm');
    const client = new SSMClient({});
    const command = new GetParametersCommand({
      Names: paramNames,
      WithDecryption: true,
    });
    const response = await client.send(command);
    const result: Record<string, string> = {};
    if (response.Parameters) {
      for (const param of response.Parameters) {
        if (param.Name && param.Value !== undefined) {
          result[param.Name] = param.Value;
        }
      }
    }
    return result;
  }

  signSessionToken(user: AuthUser, expiresInSeconds = 7 * 24 * 3600): string {
    const secret = this.getJwtSecret();
    if (!secret) {
      throw new Error('JWT secret is not configured');
    }

    const header = { alg: 'HS256', typ: 'JWT' };
    const now = Math.floor(Date.now() / 1000);
    const payload = {
      sub: user.sub,
      email: user.email,
      name: user.name,
      picture: user.picture,
      iat: now,
      exp: now + expiresInSeconds,
    };

    const headerB64 = Buffer.from(JSON.stringify(header)).toString('base64url');
    const payloadB64 = Buffer.from(JSON.stringify(payload)).toString('base64url');
    const signature = crypto
      .createHmac('sha256', secret)
      .update(`${headerB64}.${payloadB64}`)
      .digest('base64url');

    return `${headerB64}.${payloadB64}.${signature}`;
  }

  verifySessionToken(token: string): AuthUser | null {
    if (!token || typeof token !== 'string') return null;
    const secret = this.getJwtSecret();
    if (!secret) return null;

    const parts = token.split('.');
    if (parts.length !== 3) return null;

    const [headerB64, payloadB64, signatureB64] = parts;

    const expectedSignature = crypto
      .createHmac('sha256', secret)
      .update(`${headerB64}.${payloadB64}`)
      .digest('base64url');

    const sigBuf = Buffer.from(signatureB64);
    const expectedBuf = Buffer.from(expectedSignature);

    if (sigBuf.length !== expectedBuf.length || !crypto.timingSafeEqual(sigBuf, expectedBuf)) {
      return null;
    }

    try {
      const headerJson = Buffer.from(headerB64, 'base64url').toString('utf8');
      const header = JSON.parse(headerJson) as { alg?: unknown; typ?: unknown };
      if (header.alg !== 'HS256') {
        return null;
      }

      const payloadJson = Buffer.from(payloadB64, 'base64url').toString('utf8');
      const payload = JSON.parse(payloadJson) as {
        sub?: unknown;
        email?: unknown;
        name?: unknown;
        picture?: unknown;
        typ?: unknown;
        exp?: unknown;
      };

      if (payload.typ === 'oauth_state') {
        return null;
      }

      const now = Math.floor(Date.now() / 1000);
      if (typeof payload.exp !== 'number' || payload.exp <= now) {
        return null;
      }

      if (
        typeof payload.sub !== 'string' ||
        !payload.sub ||
        typeof payload.email !== 'string' ||
        !payload.email
      ) {
        return null;
      }

      return {
        sub: payload.sub,
        email: payload.email,
        name: typeof payload.name === 'string' ? payload.name : payload.email.split('@')[0],
        picture: typeof payload.picture === 'string' ? payload.picture : undefined,
      };
    } catch {
      return null;
    }
  }

  createOAuthStateAndChallenge(): {
    state: string;
    codeVerifier: string;
    codeChallenge: string;
    stateCookieToken: string;
  } {
    const secret = this.getJwtSecret();
    if (!secret) {
      throw new Error('JWT secret is not configured');
    }

    const state = crypto.randomBytes(32).toString('base64url');
    const codeVerifier = crypto.randomBytes(32).toString('base64url');
    const codeChallenge = crypto.createHash('sha256').update(codeVerifier).digest('base64url');

    const now = Math.floor(Date.now() / 1000);
    const payload: OAuthStatePayload = {
      state,
      codeVerifier,
      typ: 'oauth_state',
      iat: now,
      exp: now + 600,
    };

    const headerB64 = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url');
    const payloadB64 = Buffer.from(JSON.stringify(payload)).toString('base64url');
    const signature = crypto
      .createHmac('sha256', secret)
      .update(`${headerB64}.${payloadB64}`)
      .digest('base64url');

    const stateCookieToken = `${headerB64}.${payloadB64}.${signature}`;

    return {
      state,
      codeVerifier,
      codeChallenge,
      stateCookieToken,
    };
  }

  verifyOAuthStateCookie(
    cookieToken: string | undefined,
    queryState: string | undefined
  ): { codeVerifier: string } | null {
    if (
      !cookieToken ||
      !queryState ||
      typeof cookieToken !== 'string' ||
      typeof queryState !== 'string'
    ) {
      return null;
    }

    const secret = this.getJwtSecret();
    if (!secret) return null;

    const parts = cookieToken.split('.');
    if (parts.length !== 3) return null;

    const [headerB64, payloadB64, signatureB64] = parts;

    const expectedSignature = crypto
      .createHmac('sha256', secret)
      .update(`${headerB64}.${payloadB64}`)
      .digest('base64url');

    const sigBuf = Buffer.from(signatureB64);
    const expectedBuf = Buffer.from(expectedSignature);

    if (sigBuf.length !== expectedBuf.length || !crypto.timingSafeEqual(sigBuf, expectedBuf)) {
      return null;
    }

    try {
      const headerJson = Buffer.from(headerB64, 'base64url').toString('utf8');
      const header = JSON.parse(headerJson) as { alg?: unknown; typ?: unknown };
      if (header.alg !== 'HS256') {
        return null;
      }

      const payloadJson = Buffer.from(payloadB64, 'base64url').toString('utf8');
      const payload = JSON.parse(payloadJson) as OAuthStatePayload;

      const now = Math.floor(Date.now() / 1000);
      if (typeof payload.exp !== 'number' || payload.exp <= now) {
        return null;
      }

      if (payload.typ !== 'oauth_state') {
        return null;
      }

      if (payload.state !== queryState) {
        return null;
      }

      if (typeof payload.codeVerifier !== 'string' || !payload.codeVerifier) {
        return null;
      }

      return { codeVerifier: payload.codeVerifier };
    } catch {
      return null;
    }
  }

  resolvePublicBaseUrl(request: FastifyRequest): string {
    if (this.publicBaseUrl) {
      return this.publicBaseUrl.replace(/\/+$/, '');
    }
    if (process.env.PUBLIC_BASE_URL) {
      return process.env.PUBLIC_BASE_URL.replace(/\/+$/, '');
    }

    const rawOriginVerify = request.headers['x-copilot-origin-verify'];
    const originVerifyHeader = Array.isArray(rawOriginVerify)
      ? rawOriginVerify[0]
      : rawOriginVerify;
    const isOriginVerified = Boolean(
      this.originVerifySecret &&
        originVerifyHeader &&
        originVerifyHeader === this.originVerifySecret
    );

    const rawProto = request.headers['x-forwarded-proto'];
    const protoStr = Array.isArray(rawProto) ? rawProto[0] : rawProto;
    const protoCandidate =
      (protoStr ? protoStr.split(',')[0].trim() : '') || request.protocol || 'http';
    const proto = isOriginVerified
      ? 'https'
      : protoCandidate === 'https'
        ? 'https'
        : 'http';

    const rawHost = request.headers['x-forwarded-host'];
    const hostStr = Array.isArray(rawHost) ? rawHost[0] : rawHost;
    const fallbackHost = Array.isArray(request.headers.host)
      ? request.headers.host[0]
      : request.headers.host;
    const candidateHost =
      (hostStr ? hostStr.split(',')[0].trim() : '') || fallbackHost || 'localhost:3001';

    // If request is authenticated via CloudFront edge origin verification, trust candidateHost
    // provided it conforms to valid hostname syntax (alphanumeric, dots, dashes, optional port).
    const isSyntacticallyValidHost = /^[a-z0-9.-]+(:[0-9]+)?$/i.test(candidateHost);
    const isCandidateSafe =
      (isOriginVerified && isSyntacticallyValidHost) || this.isHostAllowed(candidateHost);

    // Re-validate fallback host to prevent attacker-controlled Host header injection
    const isFallbackSafe = Boolean(fallbackHost && this.isHostAllowed(fallbackHost));
    const safeFallback = isFallbackSafe ? fallbackHost! : 'localhost:3001';

    const host = isCandidateSafe ? candidateHost : safeFallback;

    return `${proto}://${host}`.replace(/\/+$/, '');
  }

  async verifyGoogleIdToken(idToken: string): Promise<AuthUser> {
    const clientId = this.getGoogleClientId();
    if (this.options.verifyGoogleIdTokenFn) {
      return this.options.verifyGoogleIdTokenFn(idToken, clientId);
    }

    const { OAuth2Client } = await import('google-auth-library');
    const client = new OAuth2Client(clientId);
    const ticket = await client.verifyIdToken({
      idToken,
      audience: clientId,
    });
    const payload = ticket.getPayload();
    if (!payload || !payload.sub || !payload.email || payload.email_verified !== true) {
      throw new Error('Invalid or unverified Google ID token payload');
    }

    return {
      sub: payload.sub,
      email: payload.email,
      name: payload.name || payload.email.split('@')[0],
      picture: payload.picture,
    };
  }

  async exchangeGoogleCode(params: {
    code: string;
    codeVerifier: string;
    redirectUri: string;
  }): Promise<{ idToken: string }> {
    const clientId = this.getGoogleClientId();
    const clientSecret = this.getGoogleClientSecret();

    if (this.options.exchangeGoogleCodeFn) {
      return this.options.exchangeGoogleCodeFn({
        ...params,
        clientId,
        clientSecret,
      });
    }

    const body = new URLSearchParams({
      code: params.code,
      client_id: clientId,
      client_secret: clientSecret,
      redirect_uri: params.redirectUri,
      grant_type: 'authorization_code',
      code_verifier: params.codeVerifier,
    });

    const res = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: body.toString(),
    });

    if (!res.ok) {
      const errText = await res.text();
      throw new Error(`Google token exchange failed (${res.status}): ${errText}`);
    }

    const data = (await res.json()) as { id_token?: string };
    if (!data.id_token) {
      throw new Error('Google token response did not contain id_token');
    }

    return { idToken: data.id_token };
  }

  getGoogleAuthorizationUrl(params: {
    redirectUri: string;
    state: string;
    codeChallenge: string;
  }): string {
    const url = new URL('https://accounts.google.com/o/oauth2/v2/auth');
    url.searchParams.set('client_id', this.getGoogleClientId());
    url.searchParams.set('redirect_uri', params.redirectUri);
    url.searchParams.set('response_type', 'code');
    url.searchParams.set('scope', 'openid email profile');
    url.searchParams.set('state', params.state);
    url.searchParams.set('code_challenge', params.codeChallenge);
    url.searchParams.set('code_challenge_method', 'S256');
    url.searchParams.set('prompt', 'select_account');
    return url.toString();
  }
}

export const defaultAuthService = new AuthService();
