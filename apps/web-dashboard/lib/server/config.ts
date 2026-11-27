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
