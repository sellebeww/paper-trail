// Copyright (c) 2026 Vassel Goleyu. SPDX-License-Identifier: Apache-2.0
// A deliberately tiny history router: a dozen routes, no nesting, no loaders. Keeps the owner bundle small.
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type AnchorHTMLAttributes,
  type MouseEvent,
  type ReactNode,
} from 'react';

type Navigate = (to: string, opts?: { replace?: boolean }) => void;
type RouterState = { path: string; navigate: Navigate };

const RouterContext = createContext<RouterState>({ path: '/', navigate: () => undefined });

export function Router({ children }: { children: ReactNode }) {
  const [path, setPath] = useState(() => window.location.pathname);
  useEffect(() => {
    const onPop = () => setPath(window.location.pathname);
    window.addEventListener('popstate', onPop);
    return () => window.removeEventListener('popstate', onPop);
  }, []);
  const navigate = useCallback<Navigate>((to, opts) => {
    if (opts?.replace) window.history.replaceState(null, '', to);
    else window.history.pushState(null, '', to);
    setPath(new URL(to, window.location.origin).pathname);
    window.scrollTo(0, 0);
  }, []);
  const value = useMemo(() => ({ path, navigate }), [path, navigate]);
  return <RouterContext value={value}>{children}</RouterContext>;
}

export const useNavigate = () => useContext(RouterContext).navigate;
export const usePath = () => useContext(RouterContext).path;

export type Params = Record<string, string>;
export type Route = { path: string; render: (params: Params) => ReactNode };

const match = (pattern: string, path: string): Params | null => {
  const a = pattern.split('/').filter(Boolean);
  const b = path.split('/').filter(Boolean);
  if (a.length !== b.length) return null;
  const params: Params = {};
  for (const [i, seg] of a.entries()) {
    const actual = b[i]!;
    if (seg.startsWith(':')) params[seg.slice(1)] = decodeURIComponent(actual);
    else if (seg !== actual) return null;
  }
  return params;
};

export function Routes({ routes, fallback }: { routes: Route[]; fallback: ReactNode }) {
  const path = usePath();
  for (const route of routes) {
    const params = match(route.path, path);
    if (params) return <>{route.render(params)}</>;
  }
  return <>{fallback}</>;
}

type LinkProps = Omit<AnchorHTMLAttributes<HTMLAnchorElement>, 'href'> & { to: string };

export function Link({ to, onClick, ...rest }: LinkProps) {
  const navigate = useNavigate();
  const handle = (e: MouseEvent<HTMLAnchorElement>) => {
    onClick?.(e);
    if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey) return;
    e.preventDefault();
    navigate(to);
  };
  return <a href={to} onClick={handle} {...rest} />;
}
