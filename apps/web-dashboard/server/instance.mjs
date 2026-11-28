/**
 * Per-instance runtime identity.
 *
 * The console runs in more than one place at a time on a developer machine:
 * the operator's own instance, a demo instance with its own database, and a
 * production instance behind a tunnel. `next build` and `next dev` both write
 * into the same output directory, so two instances sharing one directory
 * overwrite each other's chunk manifest — the HTML still answers 200 while
 * every `/_next/static` asset 404s and the page renders unstyled.
 *
 * Every instance therefore gets its own build directory, derived from the port
 * it listens on, and every build and start reads the same rule from here.
 */
import { join, resolve } from "node:path";

/** The ports the platform assigns to the known instances. */
export const INSTANCE_NAMES = {
  3210: "operator",
  3220: "demo",
  3230: "production",
};

/** The instance a process belongs to, from the port it serves. */
export function instanceName(mode, port) {
  if (mode === "start") return "production";
  return INSTANCE_NAMES[Number(port)] ?? `dev-${port}`;
}

/**
 * The build output directory for this instance.
 *
 * `MOBILECLOUD_NEXT_DIST_DIR` wins when it is set, so a deployment can point
 * anywhere. Otherwise the name follows the instance, so an operator dev server
 * can never overwrite the production build or the demo build.
 */
export function resolveDistDir({ mode = "dev", port = 3210, env = process.env } = {}) {
  const explicit = (env.MOBILECLOUD_NEXT_DIST_DIR ?? "").trim();
  if (explicit) return explicit;
  const name = instanceName(mode, port);
  return name === "production" ? ".next-production" : `.next-${name}`;
}

/**
 * The database this instance opens.
 *
 * This mirrors `lib/server/db.ts` exactly: an explicit `MOBILECLOUD_DB` wins,
 * otherwise the file sits in the data root. The path is logged at startup so
 * an operator can see that two instances are not sharing one database.
 */
export function resolveDatabasePath({ env = process.env, cwd = process.cwd() } = {}) {
  const explicit = (env.MOBILECLOUD_DB ?? "").trim();
  if (explicit) return resolve(explicit);
  const root = env.MOBILECLOUD_DATA_ROOT ? resolve(env.MOBILECLOUD_DATA_ROOT) : join(cwd, "data");
  return join(root, "mobilecloud.db");
}
