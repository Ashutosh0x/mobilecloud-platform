import assert from "node:assert/strict";
import test from "node:test";
import { ROLES, hasPermission, normalizeRole, roleFor, roleLabel, viewerMayMutate } from "./rbac.ts";

test("an unknown or missing role collapses to the least-privileged role", () => {
  assert.equal(normalizeRole("owner"), "owner");
  assert.equal(normalizeRole("MEMBER"), "member");
  assert.equal(normalizeRole(" viewer "), "viewer");
  assert.equal(normalizeRole("superuser"), "viewer");
  assert.equal(normalizeRole(undefined), "viewer");
  assert.equal(normalizeRole(null), "viewer");
  assert.equal(normalizeRole(42), "viewer");
});

test("only the owner holds the administrative permissions", () => {
  assert.ok(hasPermission("owner", "team.manage"));
  assert.ok(hasPermission("owner", "sso.manage"));
  assert.ok(hasPermission("owner", "oauth.manage"));
  assert.ok(!hasPermission("member", "team.manage"));
  assert.ok(!hasPermission("member", "sso.manage"));
  assert.ok(!hasPermission("member", "oauth.manage"));
  assert.ok(!hasPermission("viewer", "resources.write"));
});

test("members may write resources while viewers are read-only", () => {
  assert.ok(hasPermission("member", "resources.write"));
  assert.ok(hasPermission("viewer", "account.read"));
  assert.ok(!hasPermission("viewer", "resources.write"));
  // A bad role cannot widen access.
  assert.deepEqual(ROLES.filter((role) => hasPermission(role, "resources.write")), ["owner", "member"]);
});

test("viewers may still mutate their own credentials, profile and notifications", () => {
  assert.ok(viewerMayMutate(["profile"]));
  assert.ok(viewerMayMutate(["auth", "logout"]));
  assert.ok(viewerMayMutate(["notifications"]));
  assert.ok(!viewerMayMutate(["projects"]));
  assert.ok(!viewerMayMutate(["team"]));
  assert.ok(!viewerMayMutate(["billing"]));
  assert.ok(!viewerMayMutate([]));
});

test("roles are labelled and mapped back to the least-privileged holder", () => {
  assert.equal(roleLabel("owner"), "Owner");
  assert.equal(roleLabel("unknown"), "Viewer");
  assert.equal(roleFor("team.manage"), "owner");
  assert.equal(roleFor("resources.write"), "member");
  assert.equal(roleFor("account.read"), "viewer");
});
