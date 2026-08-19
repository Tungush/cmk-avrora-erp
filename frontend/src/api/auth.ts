import api from './client';

export const authApi = {
  login: (email: string, roles?: string[]) =>
    api.post<{
      token?: string;
      accessToken?: string;
      user: { userId: string; email: string; roles: string[] };
      permissions?: string[];
      family?: string;
    }>(
      '/auth/login',
      { email, roles }
    ),
};
