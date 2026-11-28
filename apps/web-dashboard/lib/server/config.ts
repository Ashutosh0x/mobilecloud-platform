/**
 * Runtime configuration validation.
 *
 * The identity provider must not start in production with a development
 * issuer, a known password, or a signing mode it cannot actually use. These
 * checks run when the singleton database opens, before any route serves a
 * request, and fail closed with a list of every problem rather than one at a
 * time.
 */

export type KeyProviderMode = "database" | "kms";

export type ConfigCheck = { name: string; ok: boolean; detail: string };

const WEAK_PASSWORDS = new Set(["changeme", "password", "admin", "secret", "test-operator-password", "mobilecloud"]);

function isOrigin(value: string, allowHttp: boolean): boolean {
  try {
    const url = new URL(value);
    if (url.username || url.password || url.search || url.hash) return false;
    if (url.pathname !== "/" && url.pathname !== "") return false;
    return url.protocol === "https:" || (allowHttp && url.protocol === "http:");
  } catch {
    return false;
  }
}

/** The opt-in flag convention shared by every optional integration. */
function enabled(value: string | undefined): boolean {
  return Boolean((value ?? "").match(/^(1|true|yes|on)$/i));
}

function isUrl(value: string): boolean {
  if (!value) return false;
  try {
    new URL(value);
    return true;
  } catch {
    return false;
  }
}

/** The missing-variable names from a list, used to name every absent env var in one message. */
function missing(env: NodeJS.ProcessEnv, names: string[]): string[] {
  return names.filter((name) => !(env[name] ?? "").trim());
}

export function keyProviderMode(env: NodeJS.ProcessEnv = process.env): KeyProviderMode {
  const raw = (env.MOBILECLOUD_KEY_PROVIDER ?? "database").trim().toLowerCase();
  if (raw === "database" || raw === "kms") return raw;
  throw new Error("MOBILECLOUD_KEY_PROVIDER must be database or kms");
}

/** Returns every configuration problem; an empty array means valid. */
export function validateRuntimeConfig(env: NodeJS.ProcessEnv = process.env): ConfigCheck[] {
  const production = env.NODE_ENV === "production";
  const checks: ConfigCheck[] = [];
  const add = (name: string, ok: boolean, detail: string) => checks.push({ name, ok, detail });

  const origin = (env.MOBILECLOUD_PUBLIC_ORIGIN ?? "").trim();
  add(
    "public_origin",
    !production || isOrigin(origin, false),
    production ? "MOBILECLOUD_PUBLIC_ORIGIN must be a bare HTTPS origin" : "development origin (optional)",
  );

  const issuerValue = (env.MOBILECLOUD_ISSUER ?? origin).trim();
  add(
    "issuer",
    !production || isOrigin(issuerValue, false),
    production ? "MOBILECLOUD_ISSUER must be a bare HTTPS origin (defaults to the public origin)" : "development issuer",
  );

  const password = env.MOBILECLOUD_BOOTSTRAP_PASSWORD;
  if (password) {
    add(
      "bootstrap_password",
      !production || (password.length >= 12 && !WEAK_PASSWORDS.has(password.toLowerCase())),
      production ? "The bootstrap password must be at least 12 characters and not a known default" : "development bootstrap password",
    );
  }

  let provider: KeyProviderMode | null = null;
  try {
    provider = keyProviderMode(env);
    add("key_provider", true, provider);
  } catch (error) {
    add("key_provider", false, error instanceof Error ? error.message : "invalid key provider");
  }
  if (production && provider === "kms") {
    add(
      "kms_provider",
      false,
      "MOBILECLOUD_KEY_PROVIDER=kms is not implemented in this build; configure a KMS-backed signer before production (see docs/KEY-MANAGEMENT.md)",
    );
    add(
      "kms_key_id",
      Boolean((env.MOBILECLOUD_KMS_KEY_ID ?? "").trim()),
      "MOBILECLOUD_KMS_KEY_ID is required when MOBILECLOUD_KEY_PROVIDER=kms",
    );
  }

  if (production && (env.FURLPAY_OIDC_ENABLED ?? "").match(/^(1|true|yes|on)$/i)) {
    add("furlpay_client_id", Boolean((env.FURLPAY_OIDC_CLIENT_ID ?? "").trim()), "FURLPAY_OIDC_CLIENT_ID is required");
    const redirect = (env.FURLPAY_OIDC_REDIRECT_URI ?? "").trim();
    add("furlpay_redirect", /^https:\/\/[^\s]+$/.test(redirect), "FURLPAY_OIDC_REDIRECT_URI must be an HTTPS callback URL");
    add(
      "furlpay_issuer",
      isOrigin((env.FURLPAY_OIDC_ISSUER ?? "").trim(), false),
      "FURLPAY_OIDC_ISSUER must be the HTTPS issuer origin",
    );
  }

  if (production && enabled(env.MOBILECLOUD_PUSH_ENABLED)) {
    const push = (env.MOBILECLOUD_PUSH_PROVIDER ?? "").trim().toLowerCase();
    add("push_provider", push === "fcm" || push === "apns", "MOBILECLOUD_PUSH_PROVIDER must be fcm or apns");
    if (push === "fcm") {
      add(
        "push_fcm_credentials",
        Boolean((env.MOBILECLOUD_FCM_CREDENTIALS ?? "").trim()),
        "MOBILECLOUD_FCM_CREDENTIALS is required for the fcm push provider",
      );
    }
    if (push === "apns") {
      const absent = missing(env, ["MOBILECLOUD_APNS_KEY_ID", "MOBILECLOUD_APNS_TEAM_ID", "MOBILECLOUD_APNS_BUNDLE_ID"]);
      add(
        "push_apns_credentials",
        absent.length === 0,
        `The apns push provider requires ${absent.join(", ")}`,
      );
    }
  }

  if (production && enabled(env.MOBILECLOUD_SOCIAL_LOGIN_ENABLED)) {
    const supported = ["github", "google", "microsoft"];
    const providers = (env.MOBILECLOUD_SOCIAL_PROVIDERS ?? "")
      .split(",")
      .map((name) => name.trim().toLowerCase())
      .filter(Boolean);
    if (providers.length === 0) {
      add("social_providers", false, "MOBILECLOUD_SOCIAL_PROVIDERS must list at least one of github, google or microsoft");
    } else {
      const unknown = providers.filter((name) => !supported.includes(name));
      add(
        "social_providers",
        unknown.length === 0,
        `MOBILECLOUD_SOCIAL_PROVIDERS contains an unsupported provider: ${unknown.join(", ")} (expected github, google or microsoft)`,
      );
    }
    for (const name of providers.filter((value) => supported.includes(value))) {
      const prefix = name.toUpperCase();
      const absent = missing(env, [`${prefix}_OAUTH_CLIENT_ID`, `${prefix}_OAUTH_CLIENT_SECRET`]);
      add(`social_${name}_oauth`, absent.length === 0, `${name} login requires ${absent.join(", ")}`);
    }
    if (enabled(env.MOBILECLOUD_MAGIC_LINK_ENABLED)) {
      add(
        "magic_link_smtp",
        isUrl((env.MOBILECLOUD_SMTP_URL ?? "").trim()),
        "MOBILECLOUD_SMTP_URL must be a non-empty SMTP URL for magic-link email delivery",
      );
    }
    if (enabled(env.MOBILECLOUD_SMS_OTP_ENABLED)) {
      add("sms_otp_provider", Boolean((env.MOBILECLOUD_SMS_PROVIDER ?? "").trim()), "MOBILECLOUD_SMS_PROVIDER is required for SMS OTP");
      add("sms_otp_api_key", Boolean((env.MOBILECLOUD_SMS_API_KEY ?? "").trim()), "MOBILECLOUD_SMS_API_KEY is required for SMS OTP");
    }
  }

  if (production && enabled(env.MOBILECLOUD_PAYMENTS_ENABLED)) {
    const payments = (env.MOBILECLOUD_PAYMENTS_PROVIDER ?? "").trim().toLowerCase();
    add("payments_provider", payments === "stripe" || payments === "paddle", "MOBILECLOUD_PAYMENTS_PROVIDER must be stripe or paddle");
    if (payments === "stripe") {
      const absent = missing(env, ["MOBILECLOUD_STRIPE_SECRET_KEY", "MOBILECLOUD_STRIPE_WEBHOOK_SECRET"]);
      add("payments_stripe_secrets", absent.length === 0, `The stripe payment provider requires ${absent.join(", ")}`);
    }
    if (payments === "paddle") {
      const absent = missing(env, ["MOBILECLOUD_PADDLE_API_KEY", "MOBILECLOUD_PADDLE_WEBHOOK_SECRET"]);
      add("payments_paddle_secrets", absent.length === 0, `The paddle payment provider requires ${absent.join(", ")}`);
    }
  }

  return checks;
}

/** Throws one error listing every production blocker. */
export function assertRuntimeConfig(env: NodeJS.ProcessEnv = process.env): void {
  if (env.NODE_ENV !== "production") return;
  const failed = validateRuntimeConfig(env).filter((check) => !check.ok);
  if (failed.length) {
    throw new Error(`Identity configuration is not production-safe:\n${failed.map((check) => `- ${check.name}: ${check.detail}`).join("\n")}`);
  }
}
