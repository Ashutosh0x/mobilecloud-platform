import { defineConfig, loadEnv, type ProxyOptions } from 'vite';

/**
 * Development proxy for the browser CloudShell.
 *
 * The page runs on the Vite dev server; the phone's engine runs on another
 * port. Two things have to happen at this hop:
 *
 *  1. The operator credential is attached. The browser never holds it — it
 *     cannot, because any credential it can read is a credential another page
 *     can read too. The engine therefore stays a private API and this proxy
 *     is the trust boundary.
 *
 *  2. `Host` is left untouched (`changeOrigin: false`). The engine compares
 *     the browser's `Origin` against `Host` to decide whether a request is
 *     same-origin; rewriting the host would make every browser request look
 *     cross-origin.
 *
 * In production the same role is played by the reverse proxy in front of the
 * engine — see `docs/CLOUDSHELL.md`.
 */
const DEFAULT_ENGINE = 'http://127.0.0.1:3000';

/** Routes that need the operator credential attached. */
const OPERATOR_ROUTES = ['/terminal/ticket', '/api/v1/terminal', '/api/v1/preview'];

/** Routes the browser reaches directly; they carry their own credential. */
const PASS_THROUGH_ROUTES = ['/preview'];

function operatorProxy(engineTarget: string, operatorToken: string): ProxyOptions {
  return {
    target: engineTarget,
    changeOrigin: false,
    headers: operatorToken ? { authorization: `Bearer ${operatorToken}` } : {},
  };
}

function buildProxy(engineTarget: string, operatorToken: string): Record<string, ProxyOptions> {
  const proxy: Record<string, ProxyOptions> = {
    // The terminal WebSocket authenticates with a one-use ticket, so it
    // needs no operator credential.
    '/terminal/ws': {
      target: engineTarget.replace(/^http/, 'ws'),
      changeOrigin: false,
      ws: true,
    },
  };
  for (const route of OPERATOR_ROUTES) {
    proxy[route] = operatorProxy(engineTarget, operatorToken);
  }
  for (const route of PASS_THROUGH_ROUTES) {
    proxy[route] = { target: engineTarget, changeOrigin: false };
  }
  return proxy;
}

export default defineConfig(({ mode }) => {
  // `loadEnv` merges the shell environment with any `.env` file, so the
  // engine address and the operator credential can be supplied either way.
  const env = loadEnv(mode, '.', 'MOBILECLOUD_');
  const engineTarget = env.MOBILECLOUD_ENGINE || DEFAULT_ENGINE;
  const operatorToken = env.MOBILECLOUD_OPERATOR_TOKEN || '';

  return {
    server: {
      port: 5173,
      proxy: buildProxy(engineTarget, operatorToken),
    },
    preview: {
      port: 4173,
      proxy: buildProxy(engineTarget, operatorToken),
    },
    build: {
      outDir: 'dist',
      target: 'es2022',
    },
  };
});
