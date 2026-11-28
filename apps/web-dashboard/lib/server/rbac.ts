/**
 * The account role model and its permission matrix.
 *
 * Roles are stored on `users.role`, and every resource is scoped to the account
 * (the user id). The matrix below is the single source of truth for what a role
 * may do, so routes ask it instead of comparing role strings by hand.
 *
 *   owner   full control of the account, including SSO, OAuth clients and team
 *   member  read and write the account's own resources (no admin surfaces)
 *   viewer  read-only: every mutation outside self-service is refused
 *
 * An unknown or missing role is treated as the least-privileged role, so a bad
 * row can never widen access.
 */

export type Role = "owner" | "member" | "viewer";

export type Permission = "account.read" | "resources.write" | "sso.manage" | "oauth.manage" | "team.manage";

export const ROLES: readonly Role[] = ["owner", "member", "viewer"];

const MATRIX: Record<Role, readonly Permission[]> = {
  owner: ["account.read", "resources.write", "sso.manage", "oauth.manage", "team.manage"],
  member: ["account.read", "resources.write"],
  viewer: ["account.read"],
};

export function normalizeRole(value: unknown): Role {
  const raw = typeof value === "string" ? value.trim().toLowerCase() : "";
  return (ROLES as readonly string[]).includes(raw) ? (raw as Role) : "viewer";
}

export function hasPermission(role: unknown, permission: Permission): boolean {
  return MATRIX[normalizeRole(role)].includes(permission);
}

export function roleLabel(role: unknown): string {
  const normalized = normalizeRole(role);
  return normalized.charAt(0).toUpperCase() + normalized.slice(1);
}

/**
 * The mutations a read-only viewer may still perform: everything under the
 * user's own credentials, profile and notification preferences. These never
 * touch account resources.
 */
export function viewerMayMutate(parts: string[]): boolean {
  const head = parts[0] ?? "";
  return head === "auth" || head === "profile" || head === "notifications";
}

/** The least-privileged role that holds a permission; used for error messages. */
export function roleFor(permission: Permission): Role {
  for (let i = ROLES.length - 1; i >= 0; i -= 1) if (MATRIX[ROLES[i]].includes(permission)) return ROLES[i];
  return "owner";
}
