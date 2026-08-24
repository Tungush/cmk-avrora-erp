import api from './client';

export const authApi = {
  login: (email: string, password: string) =>
    api.post<{
      accessToken: string;
      user: { userId: string; email: string; roles: string[] };
      permissions?: string[];
      family?: string;
    }>(
      '/auth/login',
      { email, password }
    ),
};
