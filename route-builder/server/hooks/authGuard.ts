import type { FastifyReply, FastifyRequest } from 'fastify';
import '@fastify/cookie';
import { AuthService, LOCAL_DEV_USER, SESSION_COOKIE_NAME } from '../services/authService.js';
import '../types/auth.js';

export function createAuthGuard(authService: AuthService) {
  return async function authGuard(request: FastifyRequest, reply: FastifyReply): Promise<void> {
    if (!authService.isAuthEnabled()) {
      request.authUser = LOCAL_DEV_USER;
      return;
    }

    const path = request.url.split('?')[0];
    if (
      request.method === 'OPTIONS' ||
      path === '/api/health' ||
      path.startsWith('/api/auth/') ||
      !path.startsWith('/api/')
    ) {
      return;
    }

    await authService.ensureConfigLoaded();

    let token: string | undefined;
    const cookieToken = request.cookies?.[SESSION_COOKIE_NAME];
    if (cookieToken) {
      token = cookieToken;
    } else {
      const authHeader = request.headers.authorization;
      if (authHeader) {
        const match = authHeader.match(/^Bearer\s+(.+)$/i);
        if (match) {
          token = match[1];
        }
      }
    }

    if (!token) {
      return reply.status(401).send({
        error: 'Unauthorized',
        message: 'Authentication required',
      });
    }

    const user = authService.verifySessionToken(token);
    if (!user) {
      return reply.status(401).send({
        error: 'Unauthorized',
        message: 'Invalid or expired authentication token',
      });
    }

    if (!authService.isEmailAllowed(user.email)) {
      return reply.status(403).send({
        error: 'Forbidden',
        message:
          'Roadtrip Co-Pilot is in private preview. Your account is not on the authorized allowlist.',
      });
    }

    request.authUser = user;
  };
}
