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
