import QRCode from "qrcode";

/**
 * The payload a MobileCloud QR code carries.
 *
 * `mobilecloud://pair` is an app-scheme URI, so the Android node can recognise
 * its own codes and a generic scanner cannot mistake one for a URL it should
 * open. The payload is safe to show on screen: it contains the single-use
 * pairing secret, which is exactly what the scanning device must prove it
 * holds, and nothing else — no session cookie, no durable credential.
 */
export type PairingTicket = {
  /** Control-plane origin the phone must call back on, e.g. `http://192.168.1.20:3210`. */
  api: string;
  /** Pairing session id. */
  id: string;
  /** 256-bit single-use secret, base64url. */
  secret: string;
  /** Six-character code shown on both screens so the human can compare them. */
  code: string;
};

export const PAIRING_SCHEME = "mobilecloud";
export const PAIRING_HOST = "pair";
export const PAIRING_VERSION = "1";

/** Encodes a pairing ticket into the exact string rendered as the QR image. */
export function encodePairingTicket(ticket: PairingTicket): string {
  const params = new URLSearchParams({
    v: PAIRING_VERSION,
    api: ticket.api,
    id: ticket.id,
    secret: ticket.secret,
    code: ticket.code,
  });
  return `${PAIRING_SCHEME}://${PAIRING_HOST}?${params.toString()}`;
}

/**
 * Parses a scanned payload back into a ticket. Returns null for anything that
 * is not a well-formed MobileCloud pairing code, so the scanner can reject a
 * foreign QR instead of sending a half-built request.
 */
export function decodePairingTicket(payload: string): PairingTicket | null {
  let url: URL;
  try {
    url = new URL(payload.trim());
  } catch {
    return null;
  }
  if (url.protocol !== `${PAIRING_SCHEME}:` || url.hostname !== PAIRING_HOST) return null;
  const api = url.searchParams.get("api") ?? "";
  const id = url.searchParams.get("id") ?? "";
  const secret = url.searchParams.get("secret") ?? "";
  const code = url.searchParams.get("code") ?? "";
  // `api` becomes the base URL every subsequent call is sent to, so refuse
  // anything that is not plainly http(s) rather than trusting the QR blindly.
  if (!/^https?:\/\/[^\s]+$/.test(api)) return null;
  if (id.length < 8 || secret.length < 32) return null;
  return { api: api.replace(/\/+$/, ""), id, secret, code: code.replace(/[^A-Za-z0-9]/g, "").toUpperCase() };
}

/** Renders a pairing ticket as a PNG data URL for the web console. */
export async function renderPairingQr(payload: string): Promise<string> {
  return QRCode.toDataURL(payload, {
    errorCorrectionLevel: "M",
    margin: 1,
    width: 320,
    color: { dark: "#0b1220", light: "#ffffff" },
  });
}
