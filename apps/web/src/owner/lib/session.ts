// Copyright (c) 2026 Vassel Goleyu. SPDX-License-Identifier: Apache-2.0
import { api, ApiError, type User } from './api';
import { useQuery } from './query';

/** The signed-in user, or `null` when anonymous (a 401 is an answer here, not an error). */
export const useMe = () =>
  useQuery<User | null>(['me'], async () => {
    try {
      return (await api.get<{ user: User }>('/auth/me')).user;
    } catch (e) {
      if (e instanceof ApiError && e.status === 401) return null;
      throw e;
    }
  });
