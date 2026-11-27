import { createHash, generateKeyPairSync, randomBytes, sign } from "node:crypto";

/**
 * A software WebAuthn authenticator, for tests only.
 *
 * It behaves like a platform authenticator: it holds a P-256 key pair, it
 * produces attested credential data when it registers, and it signs an
 * assertion over `authenticatorData || SHA-256(clientDataJSON)` with the DER
 * encoded ECDSA signature WebAuthn expects.
 *
 * The CBOR encoder here is the mirror of the decoder in `cbor.ts`, so a test
 * can build the exact byte strings a real authenticator would send.
 */

export type CredentialResponse = {
  id: string;
  type: string;
  response: {
    clientDataJSON: string;
    attestationObject?: string;
    authenticatorData?: string;
    signature?: string;
    transports?: string[];
  };
};

export type Authenticator = {
  credentialId: string;
  registration(challengeB64: string): CredentialResponse;
  assertion(challengeB64: string): CredentialResponse;
  setSignCount(value: number): void;
};

function head(major: number, length: number): Buffer {
  if (length < 24) return Buffer.from([(major << 5) | length]);
  if (length < 256) return Buffer.from([(major << 5) | 24, length]);
  if (length < 65536) {
    const bytes = Buffer.alloc(3);
    bytes[0] = (major << 5) | 25;
    bytes.writeUInt16BE(length, 1);
    return bytes;
  }
  const bytes = Buffer.alloc(5);
  bytes[0] = (major << 5) | 26;
  bytes.writeUInt32BE(length, 1);
  return bytes;
}

/** Encodes the CBOR subset an authenticator produces. */
export function cborEncode(value: unknown): Buffer {
  if (typeof value === "number") {
    return value >= 0 ? head(0, value) : head(1, -1 - value);
  }
  if (typeof value === "string") {
    const bytes = Buffer.from(value, "utf8");
    return Buffer.concat([head(3, bytes.length), bytes]);
  }
  if (Buffer.isBuffer(value)) {
    return Buffer.concat([head(2, value.length), value]);
  }
  if (Array.isArray(value)) {
    return Buffer.concat([head(4, value.length), ...value.map((entry) => cborEncode(entry))]);
  }
  if (value instanceof Map) {
    const entries: Buffer[] = [];
    for (const [key, entry] of value) {
      entries.push(cborEncode(key), cborEncode(entry));
    }
    return Buffer.concat([head(5, value.size), ...entries]);
  }
  throw new Error("Unsupported CBOR value in the test authenticator");
}

export function createAuthenticator(rpId: string, origin: string): Authenticator {
  const { publicKey, privateKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
  const jwk = publicKey.export({ format: "jwk" }) as { x: string; y: string };
  const credentialId = randomBytes(16);
  let signCount = 0;

  const coseKey = () =>
    cborEncode(
      new Map<number, unknown>([
        [1, 2],
        [3, -7],
        [-1, 1],
        [-2, Buffer.from(jwk.x, "base64url")],
        [-3, Buffer.from(jwk.y, "base64url")],
      ]),
    );

  const authenticatorData = (flags: number, attested: boolean) => {
    const rpIdHash = createHash("sha256").update(rpId).digest();
    const counter = Buffer.alloc(4);
    counter.writeUInt32BE(signCount, 0);
    if (!attested) return Buffer.concat([rpIdHash, Buffer.from([flags]), counter]);
    const length = Buffer.alloc(2);
    length.writeUInt16BE(credentialId.length, 0);
    // AT (0x40) is set because attested credential data follows.
    return Buffer.concat([rpIdHash, Buffer.from([flags]), counter, Buffer.alloc(16), length, credentialId, coseKey()]);
  };

  const clientData = (type: string, challenge: string) =>
    JSON.stringify({ type, challenge, origin, crossOrigin: false });

  return {
    credentialId: credentialId.toString("base64url"),
    setSignCount(value: number) {
      signCount = value;
    },
    registration(challengeB64: string): CredentialResponse {
      // AT | UP | UV
      const authData = authenticatorData(0x45, true);
      const attestationObject = cborEncode(
        new Map<string, unknown>([
          ["fmt", "none"],
          ["attStmt", new Map()],
          ["authData", authData],
        ]),
      );
      return {
        id: credentialId.toString("base64url"),
        type: "public-key",
        response: {
          clientDataJSON: clientData("webauthn.create", challengeB64),
          attestationObject: attestationObject.toString("base64url"),
          transports: ["internal", "hybrid"],
        },
      };
    },
    assertion(challengeB64: string): CredentialResponse {
      signCount += 1;
      const authData = authenticatorData(0x05, false);
      const clientDataJSON = clientData("webauthn.get", challengeB64);
      const signature = sign(
        "sha256",
        Buffer.concat([authData, createHash("sha256").update(clientDataJSON).digest()]),
        privateKey,
      );
      return {
        id: credentialId.toString("base64url"),
        type: "public-key",
        response: {
          clientDataJSON,
          authenticatorData: authData.toString("base64url"),
          signature: signature.toString("base64url"),
        },
      };
    },
  };
}
