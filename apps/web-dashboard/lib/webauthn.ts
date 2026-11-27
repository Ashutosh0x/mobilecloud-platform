/**
 * Browser WebAuthn helpers.
 *
 * The server speaks base64url JSON (the WebAuthn serialization); the browser
 * API speaks ArrayBuffers. These functions are the only place that conversion
 * happens, so registration, login and step-up cannot drift apart.
 */

export function b64urlToBytes(value: string): Uint8Array {
  const normalised = value.replace(/-/g, "+").replace(/_/g, "/");
  const padded = normalised.padEnd(Math.ceil(normalised.length / 4) * 4, "=");
  const binary = atob(padded);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return bytes;
}

export function bytesToB64url(value: ArrayBuffer | Uint8Array): string {
  const bytes = value instanceof Uint8Array ? value : new Uint8Array(value);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

type CreationOptions = Record<string, unknown> & {
  challenge: string;
  user: { id: string; [key: string]: unknown };
  excludeCredentials?: { id: string; [key: string]: unknown }[];
};

type RequestOptions = Record<string, unknown> & {
  challenge: string;
  allowCredentials?: { id: string; [key: string]: unknown }[];
};

export function prepareCreationOptions(options: CreationOptions): PublicKeyCredentialCreationOptions {
  return {
    ...options,
    challenge: b64urlToBytes(options.challenge),
    user: { ...options.user, id: b64urlToBytes(options.user.id) },
    excludeCredentials: (options.excludeCredentials ?? []).map((credential) => ({
      ...credential,
      id: b64urlToBytes(credential.id),
    })),
  } as unknown as PublicKeyCredentialCreationOptions;
}

export function prepareRequestOptions(options: RequestOptions): PublicKeyCredentialRequestOptions {
  return {
    ...options,
    challenge: b64urlToBytes(options.challenge),
    allowCredentials: (options.allowCredentials ?? []).map((credential) => ({
      ...credential,
      id: b64urlToBytes(credential.id),
    })),
  } as unknown as PublicKeyCredentialRequestOptions;
}

/** Serialises a browser credential into the JSON the server verifies. */
export function credentialToJson(credential: PublicKeyCredential): Record<string, unknown> {
  const response = credential.response as AuthenticatorAttestationResponse & AuthenticatorAssertionResponse;
  return {
    id: credential.id,
    rawId: bytesToB64url(credential.rawId),
    type: credential.type,
    response: {
      clientDataJSON: bytesToB64url(response.clientDataJSON),
      ...(response.attestationObject ? { attestationObject: bytesToB64url(response.attestationObject) } : {}),
      ...(response.authenticatorData ? { authenticatorData: bytesToB64url(response.authenticatorData) } : {}),
      ...(response.signature ? { signature: bytesToB64url(response.signature) } : {}),
      ...(response.userHandle ? { userHandle: bytesToB64url(response.userHandle) } : {}),
      transports: response.getTransports?.() ?? [],
    },
  };
}

export async function createPasskey(options: CreationOptions): Promise<PublicKeyCredential> {
  const credential = await navigator.credentials.create({ publicKey: prepareCreationOptions(options) });
  if (!credential || credential.type !== "public-key") throw new Error("The authenticator did not return a passkey.");
  return credential as PublicKeyCredential;
}

export async function getPasskey(
  options: RequestOptions,
  mediation?: CredentialMediationRequirement,
  signal?: AbortSignal,
): Promise<PublicKeyCredential> {
  const credential = await navigator.credentials.get({
    publicKey: prepareRequestOptions(options),
    mediation,
    signal,
  });
  if (!credential || credential.type !== "public-key") throw new Error("The authenticator did not return an assertion.");
  return credential as PublicKeyCredential;
}

export async function supportsConditionalUi(): Promise<boolean> {
  if (typeof window === "undefined" || !window.PublicKeyCredential) return false;
  const api = window.PublicKeyCredential as typeof PublicKeyCredential & {
    isConditionalMediationAvailable?: () => Promise<boolean>;
  };
  if (!api.isConditionalMediationAvailable) return false;
  return api.isConditionalMediationAvailable().catch(() => false);
}
