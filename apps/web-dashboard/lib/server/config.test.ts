import assert from "node:assert/strict";
import test from "node:test";
import { assertRuntimeConfig, keyProviderMode, validateRuntimeConfig } from "./config.ts";

const base = {
  NODE_ENV: "production",
  MOBILECLOUD_PUBLIC_ORIGIN: "https://auth.furlpay.com",
  MOBILECLOUD_ISSUER: "https://auth.furlpay.com",
  MOBILECLOUD_BOOTSTRAP_PASSWORD: "a-long-unique-operator-password",
} as NodeJS.ProcessEnv;

function failed(env: NodeJS.ProcessEnv) {
  return validateRuntimeConfig(env).filter((check) => !check.ok).map((check) => check.name);
}

test("a complete production identity configuration passes", () => {
  assert.deepEqual(failed(base), []);
  assert.doesNotThrow(() => assertRuntimeConfig(base));
});

test("production refuses a missing, non-HTTPS or path-bearing origin", () => {
  assert.ok(failed({ ...base, MOBILECLOUD_PUBLIC_ORIGIN: "" }).includes("public_origin"));
  assert.ok(failed({ ...base, MOBILECLOUD_PUBLIC_ORIGIN: "http://auth.furlpay.com" }).includes("public_origin"));
  assert.ok(failed({ ...base, MOBILECLOUD_ISSUER: "https://auth.furlpay.com/tenant" }).includes("issuer"));
});

test("known default credentials are rejected in production", () => {
  assert.ok(failed({ ...base, MOBILECLOUD_BOOTSTRAP_PASSWORD: "changeme" }).includes("bootstrap_password"));
  assert.ok(failed({ ...base, MOBILECLOUD_BOOTSTRAP_PASSWORD: "short" }).includes("bootstrap_password"));
});

test("an unimplemented KMS provider blocks production instead of silently using the database", () => {
  assert.equal(keyProviderMode({ MOBILECLOUD_KEY_PROVIDER: "database" } as unknown as NodeJS.ProcessEnv), "database");
  assert.ok(failed({ ...base, MOBILECLOUD_KEY_PROVIDER: "kms" }).includes("kms_provider"));
  assert.throws(() => keyProviderMode({ MOBILECLOUD_KEY_PROVIDER: "vault" } as unknown as NodeJS.ProcessEnv), /database or kms/);
  assert.throws(() => assertRuntimeConfig({ ...base, MOBILECLOUD_KEY_PROVIDER: "kms" }), /not production-safe/);
});

test("enabling FurlPay requires a client id, HTTPS redirect and issuer", () => {
  const enabled = failed({
    ...base,
    FURLPAY_OIDC_ENABLED: "1",
    FURLPAY_OIDC_CLIENT_ID: "furlpay",
    FURLPAY_OIDC_REDIRECT_URI: "http://furlpay.com/cb",
    FURLPAY_OIDC_ISSUER: "https://auth.furlpay.com",
  });
  assert.ok(enabled.includes("furlpay_redirect"));
});
