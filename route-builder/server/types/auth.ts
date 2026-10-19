import 'fastify';

export interface AuthUser {
  sub: string;
  email: string;
  name: string;
  picture?: string;
}

export interface AuthStatusResponse {
  authEnabled: boolean;
  authenticated: boolean;
  authorized: boolean;
  user: AuthUser | null;
  message?: string;
}

export interface MobileGoogleAuthRequest {
  idToken?: string;
  id_token?: string;
}

export interface MobileGoogleAuthResponse {
  token: string;
  user: AuthUser;
}

declare module 'fastify' {
  interface FastifyRequest {
    authUser?: AuthUser;
  }
}
