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

test("external integrations stay off until their enable flag is set", () => {
  const names = failed(base);
  const optional = [
    "push_provider",
    "push_fcm_credentials",
    "push_apns_credentials",
    "social_providers",
    "social_github_oauth",
    "magic_link_smtp",
    "sms_otp_provider",
    "sms_otp_api_key",
    "payments_provider",
    "payments_stripe_secrets",
    "payments_paddle_secrets",
  ];
  for (const name of optional) {
    assert.ok(!names.includes(name), `${name} must not be required while its feature is disabled`);
  }
});

test("enabling push notifications requires a supported provider and its credentials", () => {
  assert.ok(failed({ ...base, MOBILECLOUD_PUSH_ENABLED: "1" }).includes("push_provider"));
  assert.ok(failed({ ...base, MOBILECLOUD_PUSH_ENABLED: "1", MOBILECLOUD_PUSH_PROVIDER: "onesignal" }).includes("push_provider"));
  assert.ok(failed({ ...base, MOBILECLOUD_PUSH_ENABLED: "1", MOBILECLOUD_PUSH_PROVIDER: "fcm" }).includes("push_fcm_credentials"));
  assert.ok(failed({ ...base, MOBILECLOUD_PUSH_ENABLED: "1", MOBILECLOUD_PUSH_PROVIDER: "apns" }).includes("push_apns_credentials"));
});

test("an fcm push configuration with credentials passes", () => {
  assert.deepEqual(
    failed({
      ...base,
      MOBILECLOUD_PUSH_ENABLED: "1",
      MOBILECLOUD_PUSH_PROVIDER: "fcm",
      MOBILECLOUD_FCM_CREDENTIALS: "service-account-json",
    }),
    [],
  );
});

test("enabling social login requires each provider's OAuth secrets", () => {
  const missing = failed({ ...base, MOBILECLOUD_SOCIAL_LOGIN_ENABLED: "1", MOBILECLOUD_SOCIAL_PROVIDERS: "github" });
  assert.ok(missing.includes("social_github_oauth"));
  assert.ok(missing.includes("social_providers") === false);
  assert.ok(failed({ ...base, MOBILECLOUD_SOCIAL_LOGIN_ENABLED: "1", MOBILECLOUD_SOCIAL_PROVIDERS: "facebook" }).includes("social_providers"));
});

test("a complete github social login configuration passes", () => {
  assert.deepEqual(
    failed({
      ...base,
      MOBILECLOUD_SOCIAL_LOGIN_ENABLED: "1",
      MOBILECLOUD_SOCIAL_PROVIDERS: "github",
      GITHUB_OAUTH_CLIENT_ID: "client-id",
      GITHUB_OAUTH_CLIENT_SECRET: "client-secret",
    }),
    [],
  );
});

test("enabling payments requires a supported provider and its keys", () => {
  assert.ok(failed({ ...base, MOBILECLOUD_PAYMENTS_ENABLED: "1" }).includes("payments_provider"));
  assert.ok(failed({ ...base, MOBILECLOUD_PAYMENTS_ENABLED: "1", MOBILECLOUD_PAYMENTS_PROVIDER: "braintree" }).includes("payments_provider"));
  assert.ok(failed({ ...base, MOBILECLOUD_PAYMENTS_ENABLED: "1", MOBILECLOUD_PAYMENTS_PROVIDER: "stripe" }).includes("payments_stripe_secrets"));
  assert.ok(failed({ ...base, MOBILECLOUD_PAYMENTS_ENABLED: "1", MOBILECLOUD_PAYMENTS_PROVIDER: "paddle" }).includes("payments_paddle_secrets"));
});

test("a complete stripe payments configuration passes", () => {
  assert.deepEqual(
    failed({
      ...base,
      MOBILECLOUD_PAYMENTS_ENABLED: "1",
      MOBILECLOUD_PAYMENTS_PROVIDER: "stripe",
      MOBILECLOUD_STRIPE_SECRET_KEY: "sk_live_x",
      MOBILECLOUD_STRIPE_WEBHOOK_SECRET: "whsec_x",
    }),
    [],
  );
});

test("kms signing without a key id fails closed", () => {
  const names = failed({ ...base, MOBILECLOUD_KEY_PROVIDER: "kms" });
  assert.ok(names.includes("kms_provider"));
  assert.ok(names.includes("kms_key_id"));
  assert.ok(!failed({ ...base, MOBILECLOUD_KEY_PROVIDER: "kms", MOBILECLOUD_KMS_KEY_ID: "arn:aws:kms:key" }).includes("kms_key_id"));
});
