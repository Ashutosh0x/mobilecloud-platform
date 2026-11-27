import { createHash, createSign, generateKeyPairSync, randomBytes, X509Certificate } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { inflateRawSync, inflateSync } from "node:zlib";
import { DOMParser, XMLSerializer } from "@xmldom/xmldom";
import type { Document as XmlDocument, Element as XmlElement } from "@xmldom/xmldom";
import { SignedXml } from "xml-crypto";
import { newId } from "./db.ts";

/**
 * SAML 2.0 Identity Provider for the custom SSO system.
 *
 * The control plane is the identity provider: it publishes metadata, accepts
 * AuthnRequests from registered service providers over the HTTP-Redirect and
 * HTTP-POST bindings, and returns a signed bearer assertion through the
 * registered Assertion Consumer Service.
 *
 * Security properties this module enforces:
 *   - the response target is always the ACS stored for the service provider,
 *     never the `AssertionConsumerServiceURL` an incoming request carries, so a
 *     stolen request cannot redirect an assertion;
 *   - requests are only accepted for registered entity ids, and when a
 *     certificate is registered the request signature must verify against that
 *     pinned certificate (the certificate in the request's own KeyInfo is never
 *     trusted);
 *   - `Destination` must match this IdP's SSO endpoint, and the assertion
 *     audience is the registered entity id;
 *   - DOCTYPE/ENTITY declarations are refused before parsing (XXE guard), the
 *     XML parser is configured to abort on any parse diagnostic, and request
 *     bodies are size-capped;
 *   - assertions are signed over a strict exclusive-canonicalization digest
 *     with RSA-SHA256 and carry the IdP certificate in KeyInfo.
 */

const SAML_PROTOCOL_NS = "urn:oasis:names:tc:SAML:2.0:protocol";
const SAML_ASSERTION_NS = "urn:oasis:names:tc:SAML:2.0:assertion";
const SAML_METADATA_NS = "urn:oasis:names:tc:SAML:2.0:metadata";
const DSIG_NS = "http://www.w3.org/2000/09/xmldsig#";
const XML_SCHEMA_NS = "http://www.w3.org/2001/XMLSchema";
const XML_SCHEMA_INSTANCE_NS = "http://www.w3.org/2001/XMLSchema-instance";

const NAME_ID_EMAIL = "urn:oasis:names:tc:SAML:1.1:nameid-format:emailAddress";
const ATTR_NAME_FORMAT_BASIC = "urn:oasis:names:tc:SAML:2.0:attrname-format:basic";
const BEARER_CONFIRMATION = "urn:oasis:names:tc:SAML:2.0:cm:bearer";
const PASSWORD_PROTECTED_TRANSPORT = "urn:oasis:names:tc:SAML:2.0:ac:classes:PasswordProtectedTransport";
const HTTP_REDIRECT_BINDING = "urn:oasis:names:tc:SAML:2.0:bindings:HTTP-Redirect";
const HTTP_POST_BINDING = "urn:oasis:names:tc:SAML:2.0:bindings:HTTP-POST";
const STATUS_SUCCESS = "urn:oasis:names:tc:SAML:2.0:status:Success";

const EXCLUSIVE_C14N = "http://www.w3.org/2001/10/xml-exc-c14n#";
const ENVELOPED_SIGNATURE = "http://www.w3.org/2000/09/xmldsig#enveloped-signature";
const RSA_SHA256 = "http://www.w3.org/2001/04/xmldsig-more#rsa-sha256";
const SHA256_DIGEST = "http://www.w3.org/2001/04/xmlenc#sha256";

/** An assertion is usable for five minutes; a minute of clock skew is allowed. */
const ASSERTION_TTL_MS = 5 * 60_000;
const CLOCK_SKEW_MS = 60_000;

/** Requests are bounded before and after decompression to stop a zip bomb. */
const MAX_REQUEST_BYTES = 256 * 1024;
const MAX_REQUEST_PARAMETER = 512 * 1024;
const MAX_RELAY_STATE = 4_096;

const IDP_COMMON_NAME = "mobilecloud-idp";
const CERTIFICATE_VALIDITY_DAYS = 3_650;
/** XML `xs:ID` / NCName, which SAML request ids must satisfy. */
const XML_ID = /^[A-Za-z_][A-Za-z0-9._-]{0,255}$/;

const SP_COLUMNS = "id, entity_id, acs_url, slo_url, certificate_pem, name_id_format";

export type SamlServiceProvider = {
  id: string;
  entityId: string;
  acsUrl: string;
  sloUrl: string | null;
  certificatePem: string | null;
  nameIdFormat: string;
};

export type SamlConfig = {
  issuer: string;
  ssoUrl: string;
  metadataUrl: string;
  certificatePem: string;
  privateKeyPem: string;
};

export type SamlAuthnRequest = {
  id: string;
  issuer: string;
  acsUrl: string;
  destination: string;
  relayState: string;
  forceAuthn: boolean;
};

type ServiceProviderRow = {
  id: string;
  entity_id: string;
  acs_url: string;
  slo_url: string | null;
  certificate_pem: string | null;
  name_id_format: string;
};

function toServiceProvider(row: ServiceProviderRow): SamlServiceProvider {
  return {
    id: row.id,
    entityId: row.entity_id,
    acsUrl: row.acs_url,
    sloUrl: row.slo_url,
    certificatePem: row.certificate_pem,
    nameIdFormat: row.name_id_format,
  };
}

/**
 * Returns the certificate and key the IdP signs assertions with, creating and
 * persisting a self-signed pair the first time SSO is used.
 *
 * The active key is selected by `alg = 'SAML'`, which keeps it separate from
 * the RS256 key OIDC uses. Rotation is explicit: publishing a new row makes the
 * old one inactive rather than deleting it.
 */
export function ensureSamlKey(db: DatabaseSync): { privatePem: string; certificatePem: string } {
  const selectActive = () =>
    db.prepare(
      "SELECT private_pem, certificate_pem FROM signing_keys WHERE alg = 'SAML' AND active = 1 ORDER BY created_at DESC LIMIT 1",
    ).get() as { private_pem: string; certificate_pem: string | null } | undefined;

  const existing = selectActive();
  if (existing?.certificate_pem) {
    return { privatePem: existing.private_pem, certificatePem: existing.certificate_pem };
  }

  const generated = generateSelfSignedCertificate(IDP_COMMON_NAME, CERTIFICATE_VALIDITY_DAYS);

  // Key generation takes a noticeable amount of time. Re-read after it so a
  // second process that won a concurrent first start is not overwritten.
  const raced = selectActive();
  if (raced?.certificate_pem) {
    return { privatePem: raced.private_pem, certificatePem: raced.certificate_pem };
  }
  db.prepare("UPDATE signing_keys SET active = 0 WHERE alg = 'SAML' AND active = 1").run();
  db.prepare(
    `INSERT INTO signing_keys (id, kid, alg, private_pem, public_jwk, certificate_pem, created_at, active)
     VALUES (?, ?, 'SAML', ?, '{}', ?, ?, 1)`,
  ).run(newId(), randomBytes(8).toString("hex"), generated.privatePem, generated.certificatePem, Date.now());
  return generated;
}

/** The IdP endpoints and signing material for a given public origin. */
export function samlConfig(db: DatabaseSync, origin: string): SamlConfig {
  const base = normalizeOrigin(origin);
  const { privatePem, certificatePem } = ensureSamlKey(db);
  return {
    issuer: base,
    // The standards paths are served by the Next.js rewrites; advertising the
    // /api destination would leak the implementation and break strict SPs that
    // compare Destination to the metadata they fetched.
    ssoUrl: `${base}/saml/sso`,
    metadataUrl: `${base}/saml/metadata`,
    certificatePem,
    privateKeyPem: privatePem,
  };
}

export function listServiceProviders(db: DatabaseSync): SamlServiceProvider[] {
  return (
    db.prepare(`SELECT ${SP_COLUMNS} FROM saml_service_providers ORDER BY created_at DESC`).all() as ServiceProviderRow[]
  ).map(toServiceProvider);
}

export function findServiceProvider(db: DatabaseSync, entityId: string): SamlServiceProvider | null {
  if (!entityId) return null;
  const row = db.prepare(`SELECT ${SP_COLUMNS} FROM saml_service_providers WHERE entity_id = ?`).get(entityId) as
    | ServiceProviderRow
    | undefined;
  return row ? toServiceProvider(row) : null;
}

/**
 * Registers a service provider.
 *
 * The entity id is the SAML trust anchor and the ACS is where assertions are
 * delivered, so both are validated before anything is stored. A certificate is
 * optional: without one the SP may send unsigned AuthnRequests (the original
 * SSO posture), with one every request must be signed.
 */
export function createServiceProvider(
  db: DatabaseSync,
  input: {
    entityId: string;
    acsUrl: string;
    sloUrl?: string | null;
    certificatePem?: string | null;
    nameIdFormat?: string | null;
  },
): SamlServiceProvider {
  const entityId = (input.entityId ?? "").trim();
  if (!isAbsoluteUri(entityId)) {
    throw new Error("The SAML entity id must be an absolute URI such as https://sp.example.com/metadata.");
  }
  const acsUrl = (input.acsUrl ?? "").trim();
  if (!isSafeServiceUrl(acsUrl)) {
    throw new Error("The assertion consumer service URL must use HTTPS (loopback HTTP is allowed for development).");
  }
  const sloUrl = input.sloUrl?.trim() || null;
  if (sloUrl && !isSafeServiceUrl(sloUrl)) {
    throw new Error("The single logout service URL must use HTTPS (loopback HTTP is allowed for development).");
  }
  const certificatePem = input.certificatePem?.trim() ? assertCertificatePem(input.certificatePem.trim()) : null;
  const nameIdFormat = input.nameIdFormat?.trim() || NAME_ID_EMAIL;
  if (!isAbsoluteUri(nameIdFormat)) throw new Error("The name id format must be an absolute URI.");

  const duplicate = `A service provider with the entity id ${entityId} is already registered.`;
  if (findServiceProvider(db, entityId)) throw new Error(duplicate);
  try {
    db.prepare(
      `INSERT INTO saml_service_providers (id, entity_id, acs_url, slo_url, certificate_pem, name_id_format, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).run(newId(), entityId, acsUrl, sloUrl, certificatePem, nameIdFormat, Date.now());
  } catch (error) {
    // Another process may have registered the same entity id between the check
    // above and this insert; report it as the same, actionable duplicate.
    if (error instanceof Error && /UNIQUE constraint failed/i.test(error.message)) throw new Error(duplicate);
    throw error;
  }
  const created = findServiceProvider(db, entityId);
  if (!created) throw new Error("The service provider could not be stored.");
  return created;
}

export function deleteServiceProvider(db: DatabaseSync, id: string): boolean {
  return Number(db.prepare("DELETE FROM saml_service_providers WHERE id = ?").run(id).changes) > 0;
}

/** The SAML 2.0 metadata document an SP imports to trust this IdP. */
export function buildMetadata(config: SamlConfig): string {
  assertHttpUrl(config.issuer, "The SAML issuer");
  assertHttpUrl(config.ssoUrl, "The SAML single sign-on URL");
  const certificate = certificateBase64(config.certificatePem);
  const entityId = escapeXml(config.issuer);
  const ssoUrl = escapeXml(config.ssoUrl);
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    `<md:EntityDescriptor xmlns:md="${SAML_METADATA_NS}" xmlns:ds="${DSIG_NS}" entityID="${entityId}">`,
    '  <md:IDPSSODescriptor protocolSupportEnumeration="urn:oasis:names:tc:SAML:2.0:protocol" WantAuthnRequestsSigned="false">',
    '    <md:KeyDescriptor use="signing">',
    "      <ds:KeyInfo>",
    "        <ds:X509Data>",
    `          <ds:X509Certificate>${certificate}</ds:X509Certificate>`,
    "        </ds:X509Data>",
    "      </ds:KeyInfo>",
    "    </md:KeyDescriptor>",
    `    <md:NameIDFormat>${NAME_ID_EMAIL}</md:NameIDFormat>`,
    `    <md:SingleSignOnService Binding="${HTTP_REDIRECT_BINDING}" Location="${ssoUrl}"/>`,
    `    <md:SingleSignOnService Binding="${HTTP_POST_BINDING}" Location="${ssoUrl}"/>`,
    "  </md:IDPSSODescriptor>",
    "</md:EntityDescriptor>",
    "",
  ].join("\n");
}

/**
 * Parses and authenticates an incoming AuthnRequest.
 *
 * Both bindings are accepted: a deflated (HTTP-Redirect) or plain XML (HTTP-POST)
 * `SAMLRequest` is decoded, checked against the registered entity id, its
 * `Destination` must name this IdP, and a signature is required and verified
 * whenever the SP has a certificate registered. The returned `acsUrl` is the
 * registered one — the value in the request is deliberately ignored.
 */
export function parseAuthnRequest(
  db: DatabaseSync,
  config: SamlConfig,
  params: { SAMLRequest?: string | null; RelayState?: string | null },
): SamlAuthnRequest {
  const xml = decodeSamlRequest(params.SAMLRequest);
  assertNoDoctype(xml);
  const doc = parseXml(xml);
  const root: XmlElement | null = doc.documentElement;
  if (!root) throw new Error("The SAML request has no root element.");
  if (root.namespaceURI !== SAML_PROTOCOL_NS || localNameOf(root) !== "AuthnRequest") {
    throw new Error("The SAML request is not a SAML 2.0 AuthnRequest.");
  }

  const id = attribute(root, "ID");
  if (!XML_ID.test(id)) throw new Error("The SAML request has no valid ID attribute.");
  const requestedDestination = attribute(root, "Destination");
  if (requestedDestination && requestedDestination !== config.ssoUrl) {
    throw new Error("The SAML request is addressed to a different destination.");
  }
  const issuerElement = findChild(root, SAML_ASSERTION_NS, "Issuer");
  if (!issuerElement) throw new Error("The SAML request has no Issuer.");
  const issuer = (issuerElement.textContent ?? "").trim();
  if (!issuer || issuer.length > 1_024) throw new Error("The SAML request has no valid Issuer.");
  const relayState = params.RelayState ?? "";
  if (relayState.length > MAX_RELAY_STATE) throw new Error("The RelayState parameter is too long.");
  const forceAuthn = /^(?:true|1)$/i.test(attribute(root, "ForceAuthn"));

  const sp = findServiceProvider(db, issuer);
  if (!sp) throw new Error("That service provider is not registered.");

  const signature = findChild(root, DSIG_NS, "Signature");
  if (signature) {
    if (!sp.certificatePem) {
      throw new Error("This service provider signed its request but has no certificate registered.");
    }
    assertRequestSignature(xml, signature, id, sp.certificatePem);
  } else if (sp.certificatePem) {
    // The SP told us it signs its requests; an unsigned request is not from it.
    throw new Error("this service provider must sign its requests");
  }

  return {
    id,
    issuer,
    // The registered ACS is the only address an assertion may be sent to.
    acsUrl: sp.acsUrl,
    destination: requestedDestination || config.ssoUrl,
    relayState,
    forceAuthn,
  };
}

/**
 * Builds a signed bearer assertion for the signed-in user.
 *
 * The assertion is signed individually (SAML schema requires `Signature` right
 * after `Issuer` inside the assertion), the response carries it unchanged, and
 * the returned HTML auto-submits it to the registered ACS as the
 * `SAMLResponse` form field together with the caller's `RelayState`.
 */
export function buildResponse(
  config: SamlConfig,
  sp: SamlServiceProvider,
  user: { id: string; email: string; name: string },
  request: SamlAuthnRequest,
): { xml: string; html: string } {
  const subject = (user.email ?? "").trim();
  if (!subject) throw new Error("A SAML assertion requires an email subject.");
  const inResponseTo = request.id;
  if (!XML_ID.test(inResponseTo)) throw new Error("The SAML request id is not valid.");
  const audience = sp.entityId;
  if (!audience) throw new Error("The service provider has no entity id.");
  if (!isSafeServiceUrl(sp.acsUrl)) throw new Error("The service provider has no usable assertion consumer service URL.");
  const nameIdFormat = sp.nameIdFormat || NAME_ID_EMAIL;

  const issuedAt = Date.now();
  const issueInstant = isoTimestamp(issuedAt);
  const notBefore = isoTimestamp(issuedAt - CLOCK_SKEW_MS);
  const notOnOrAfter = isoTimestamp(issuedAt + ASSERTION_TTL_MS);
  const assertionId = `_${randomBytes(20).toString("hex")}`;
  const responseId = `_${randomBytes(20).toString("hex")}`;
  const sessionIndex = `_${randomBytes(16).toString("hex")}`;
  const recipient = sp.acsUrl;

  const attribute = (name: string, value: string) =>
    `<saml:Attribute Name="${escapeXml(name)}" NameFormat="${ATTR_NAME_FORMAT_BASIC}">` +
    `<saml:AttributeValue xsi:type="xs:string">${escapeXml(value)}</saml:AttributeValue>` +
    `</saml:Attribute>`;

  const assertion =
    `<saml:Assertion xmlns:saml="${SAML_ASSERTION_NS}" xmlns:xs="${XML_SCHEMA_NS}" xmlns:xsi="${XML_SCHEMA_INSTANCE_NS}"` +
    ` ID="${assertionId}" Version="2.0" IssueInstant="${issueInstant}">` +
    `<saml:Issuer>${escapeXml(config.issuer)}</saml:Issuer>` +
    `<saml:Subject>` +
    `<saml:NameID Format="${escapeXml(nameIdFormat)}">${escapeXml(subject)}</saml:NameID>` +
    `<saml:SubjectConfirmation Method="${BEARER_CONFIRMATION}">` +
    `<saml:SubjectConfirmationData InResponseTo="${escapeXml(inResponseTo)}"` +
    ` NotOnOrAfter="${notOnOrAfter}" Recipient="${escapeXml(recipient)}"/>` +
    `</saml:SubjectConfirmation>` +
    `</saml:Subject>` +
    `<saml:Conditions NotBefore="${notBefore}" NotOnOrAfter="${notOnOrAfter}">` +
    `<saml:AudienceRestriction><saml:Audience>${escapeXml(audience)}</saml:Audience></saml:AudienceRestriction>` +
    `</saml:Conditions>` +
    `<saml:AuthnStatement AuthnInstant="${issueInstant}" SessionIndex="${sessionIndex}">` +
    `<saml:AuthnContext><saml:AuthnContextClassRef>${PASSWORD_PROTECTED_TRANSPORT}</saml:AuthnContextClassRef></saml:AuthnContext>` +
    `</saml:AuthnStatement>` +
    `<saml:AttributeStatement>` +
    attribute("email", subject) +
    attribute("name", (user.name ?? "").trim() || subject) +
    attribute("uid", user.id) +
    `</saml:AttributeStatement>` +
    `</saml:Assertion>`;

  const response =
    `<samlp:Response xmlns:samlp="${SAML_PROTOCOL_NS}" xmlns:saml="${SAML_ASSERTION_NS}"` +
    ` ID="${responseId}" Version="2.0" IssueInstant="${issueInstant}"` +
    ` Destination="${escapeXml(recipient)}" InResponseTo="${escapeXml(inResponseTo)}">` +
    `<saml:Issuer>${escapeXml(config.issuer)}</saml:Issuer>` +
    `<samlp:Status><samlp:StatusCode Value="${STATUS_SUCCESS}"/></samlp:Status>` +
    assertion +
    `</samlp:Response>`;

  // The XML declaration is a prolog: it does not change the canonical form of
  // the signed assertion, so it can be added after signing for SPs that expect
  // a complete document.
  const xml = `<?xml version="1.0" encoding="UTF-8"?>${signAssertion(response, config)}`;
  const samlResponse = Buffer.from(xml, "utf8").toString("base64");
  return { xml, html: buildAutoSubmitHtml(recipient, samlResponse, request.relayState ?? "") };
}

/* ------------------------------------------------------------------------- */
/* Request decoding                                                           */
/* ------------------------------------------------------------------------- */

/**
 * Decodes `SAMLRequest` from either binding.
 *
 * HTTP-Redirect sends raw DEFLATE (some stacks send zlib framing), HTTP-POST
 * sends plain XML. Detection tries the framing the first bytes advertise and
 * then the other, and refuses anything that does not decompress to XML. Output
 * is capped so a small compressed body cannot expand into a huge document.
 */
function decodeSamlRequest(raw: string | null | undefined): string {
  const value = (raw ?? "").trim();
  if (!value) throw new Error("The SAMLRequest parameter is missing.");
  if (value.length > MAX_REQUEST_PARAMETER) throw new Error("The SAMLRequest parameter is too large.");
  // URLSearchParams has already percent-decoded the value, which turns a literal
  // "+" into a space. Base64 never contains spaces, so restoring them keeps
  // requests from SPs that do not escape "+" working without weakening anything:
  // the signature still covers the decoded XML.
  const normalized = value.replace(/ /g, "+");
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(normalized) || normalized.length % 4 !== 0) {
    throw new Error("The SAMLRequest parameter is not valid base64.");
  }
  const bytes = Buffer.from(normalized, "base64");
  if (bytes.length === 0) throw new Error("The SAMLRequest parameter is empty.");
  if (bytes.length > MAX_REQUEST_BYTES) throw new Error("The SAMLRequest parameter is too large.");
  if (looksLikeXml(bytes)) return bytes.toString("utf8");
  const inflated = inflateRequest(bytes);
  if (!looksLikeXml(inflated)) throw new Error("The SAMLRequest is not a SAML XML document.");
  return inflated.toString("utf8");
}

function looksLikeXml(bytes: Buffer): boolean {
  let index = 0;
  if (bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) index = 3;
  while (
    index < bytes.length &&
    (bytes[index] === 0x20 || bytes[index] === 0x09 || bytes[index] === 0x0a || bytes[index] === 0x0d)
  ) {
    index += 1;
  }
  return bytes[index] === 0x3c;
}

function inflateRequest(bytes: Buffer): Buffer {
  const options = { maxOutputLength: MAX_REQUEST_BYTES };
  const zlibFramed = bytes.length >= 2 && (bytes[0] & 0x0f) === 8 && (((bytes[0] << 8) | bytes[1]) % 31 === 0);
  const attempts: Array<() => Buffer> = zlibFramed
    ? [() => inflateSync(bytes, options), () => inflateRawSync(bytes, options)]
    : [() => inflateRawSync(bytes, options), () => inflateSync(bytes, options)];
  for (const attempt of attempts) {
    try {
      return attempt();
    } catch {
      // The other framing may be the one the service provider used.
    }
  }
  throw new Error("The SAMLRequest is neither plain XML nor a deflate stream.");
}

/** Rejects a document type declaration before any parser sees it (XXE guard). */
function assertNoDoctype(xml: string): void {
  if (/<!DOCTYPE|<!ENTITY/i.test(xml)) {
    throw new Error("The SAML request must not contain a document type or entity declaration.");
  }
}

function parseXml(xml: string): XmlDocument {
  const parser = new DOMParser({
    // Any diagnostic is fatal: a request that is not cleanly formed is not a
    // request this IdP should act on.
    onError: (level, message) => {
      throw new Error(`The SAML XML could not be parsed (${level}): ${message}`);
    },
  });
  return parser.parseFromString(xml, "text/xml");
}

/* ------------------------------------------------------------------------- */
/* Assertion signing                                                          */
/* ------------------------------------------------------------------------- */

/**
 * Signs the assertion inside `xml` and returns the serialized response.
 *
 * xml-crypto resolves the reference by the assertion `ID`, computes a SHA-256
 * digest over the exclusive-canonical form (with the enveloped signature
 * removed), and places `ds:Signature` immediately after the assertion `Issuer`
 * as the SAML schema requires. xmldom's serializer then normalizes the document
 * that is actually sent to the SP.
 */
function signAssertion(xml: string, config: SamlConfig): string {
  const signer = new SignedXml({
    privateKey: config.privateKeyPem,
    publicCert: config.certificatePem,
    idAttribute: "ID",
    signatureAlgorithm: RSA_SHA256,
    canonicalizationAlgorithm: EXCLUSIVE_C14N,
  });
  signer.addReference({
    xpath: "//*[local-name(.)='Assertion']",
    transforms: [ENVELOPED_SIGNATURE, EXCLUSIVE_C14N],
    digestAlgorithm: SHA256_DIGEST,
  });
  signer.computeSignature(xml, {
    prefix: "ds",
    location: {
      reference: "//*[local-name(.)='Assertion']/*[local-name(.)='Issuer']",
      action: "after",
    },
  });
  return serializeXml(parseXml(signer.getSignedXml()));
}

/**
 * Verifies the enveloped signature over the whole request document.
 *
 * The verification key is the SP certificate stored at registration time and
 * nothing else: the resolver ignores whatever KeyInfo the request carries, so a
 * request cannot introduce its own signing key. `idAttribute` is deliberately
 * left at its default because passing `"ID"` again duplicates the default entry
 * in xml-crypto 6.x and makes it reject any document with a matching id.
 *
 * The reference must also name this exact request id. Without that check a
 * crafted document could move a valid signature next to a different (unsigned)
 * root element and have it verified against the original it still references —
 * the classic SAML signature-wrapping attack.
 */
function assertRequestSignature(xml: string, signature: XmlElement, requestId: string, certificatePem: string): void {
  const verifier = new SignedXml({
    publicCert: certificatePem,
    getCertFromKeyInfo: () => certificatePem,
  });
  try {
    verifier.loadSignature(serializeXml(signature));
    const references = verifier.getReferences();
    if (references.length !== 1 || references[0].uri !== `#${requestId}`) {
      throw new Error("the signature does not cover this request");
    }
    if (verifier.checkSignature(xml) !== true) throw new Error("signature mismatch");
  } catch (error) {
    throw new Error("The signature on the SAML request could not be verified.", { cause: error });
  }
}

/* ------------------------------------------------------------------------- */
/* HTML response                                                              */
/* ------------------------------------------------------------------------- */

/** The auto-submitting form an SP receives from the SSO endpoint. */
function buildAutoSubmitHtml(acsUrl: string, samlResponse: string, relayState: string): string {
  return [
    "<!DOCTYPE html>",
    '<html lang="en">',
    "<head>",
    '<meta charset="utf-8">',
    "<title>Signing in</title>",
    "</head>",
    '<body onload="document.forms[0].submit()">',
    `<form method="post" action="${escapeXml(acsUrl)}">`,
    `<input type="hidden" name="SAMLResponse" value="${escapeXml(samlResponse)}"/>`,
    `<input type="hidden" name="RelayState" value="${escapeXml(relayState)}"/>`,
    '<noscript><button type="submit">Continue</button></noscript>',
    "</form>",
    "</body>",
    "</html>",
  ].join("\n");
}

/* ------------------------------------------------------------------------- */
/* Validation helpers                                                         */
/* ------------------------------------------------------------------------- */

function normalizeOrigin(origin: string): string {
  let url: URL;
  try {
    url = new URL((origin ?? "").trim());
  } catch {
    throw new Error("The SAML issuer must be an absolute URL such as https://console.example.com.");
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new Error("The SAML issuer must use http or https.");
  }
  if (url.username || url.password || url.pathname !== "/" || url.search || url.hash) {
    throw new Error("The SAML issuer must be an origin such as https://console.example.com.");
  }
  return url.origin;
}

function isAbsoluteUri(value: string): boolean {
  if (!value || value.length > 1_024 || /[\u0000-\u001f\u007f\s]/.test(value)) return false;
  try {
    // `new URL` accepts every absolute URI, including the `urn:` entity ids
    // SPs commonly use, and rejects relative values.
    new URL(value);
    return true;
  } catch {
    return false;
  }
}

/** A service (ACS or SLO) endpoint is HTTPS, or loopback HTTP for development. */
function isSafeServiceUrl(value: string): boolean {
  if (!value || value.length > 2_048) return false;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return false;
  }
  if (url.username || url.password || url.hash) return false;
  if (url.protocol === "https:") return true;
  if (url.protocol !== "http:") return false;
  return url.hostname === "127.0.0.1" || url.hostname === "localhost" || url.hostname === "[::1]";
}

function assertHttpUrl(value: string, label: string): void {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`${label} must be an absolute http(s) URL.`);
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new Error(`${label} must be an absolute http(s) URL.`);
  }
}

function assertCertificatePem(value: string): string {
  if (value.length > 16_384) throw new Error("The service provider certificate is too large.");
  if (!value.includes("BEGIN CERTIFICATE") || !value.includes("END CERTIFICATE")) {
    throw new Error("The service provider certificate must be a PEM encoded X.509 certificate.");
  }
  return value;
}

function certificateBase64(certificatePem: string): string {
  const match = /-----BEGIN CERTIFICATE-----([\s\S]*?)-----END CERTIFICATE-----/.exec(certificatePem);
  if (!match) throw new Error("The SAML signing certificate is not a PEM encoded X.509 certificate.");
  const body = match[1].replace(/\s+/g, "");
  if (!body || !/^[A-Za-z0-9+/]+={0,2}$/.test(body)) {
    throw new Error("The SAML signing certificate does not contain valid base64.");
  }
  return body;
}

/* ------------------------------------------------------------------------- */
/* XML helpers                                                                */
/* ------------------------------------------------------------------------- */

function escapeXml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function isoTimestamp(milliseconds: number): string {
  return new Date(milliseconds).toISOString();
}

function serializeXml(node: XmlDocument | XmlElement): string {
  return new XMLSerializer().serializeToString(node);
}

function localNameOf(element: XmlElement): string {
  return element.localName ?? element.nodeName.split(":").pop() ?? element.nodeName;
}

function childElements(parent: XmlElement): XmlElement[] {
  const children: XmlElement[] = [];
  for (let index = 0; index < parent.childNodes.length; index += 1) {
    const child = parent.childNodes.item(index);
    if (child && child.nodeType === 1) children.push(child as XmlElement);
  }
  return children;
}

/** Direct child by namespace and local name; a nested lookalike never matches. */
function findChild(parent: XmlElement, namespace: string, localName: string): XmlElement | null {
  for (const child of childElements(parent)) {
    if (localNameOf(child) === localName && (child.namespaceURI ?? "") === namespace) return child;
  }
  return null;
}

function attribute(element: XmlElement, name: string): string {
  const value = element.getAttribute(name);
  return typeof value === "string" ? value.trim() : "";
}

/* ------------------------------------------------------------------------- */
/* Self-signed certificate generation                                         */
/* ------------------------------------------------------------------------- */

/**
 * Builds the IdP's self-signed RSA certificate synchronously.
 *
 * `selfsigned` is the obvious tool for this, but its 5.x release is
 * asynchronous only: `generate()` returns a Promise built on WebCrypto, and a
 * promise cannot be settled while this process is inside a synchronous call.
 * The public surface is synchronous by contract (`samlConfig` feeds the
 * metadata route in api.ts directly, and `ensureSamlKey` returns PEMs, not a
 * promise), so the certificate is assembled here from node:crypto primitives:
 * a 2048-bit RSA key and a DER-encoded X.509 v3 certificate that node's own
 * X509Certificate parses, matches to the key, and verifies as self-signed.
 *
 * The certificate is for SAML signing only: CN=mobilecloud-idp, RSA-2048,
 * SHA-256, ten years, with basicConstraints (not a CA), keyUsage
 * (digitalSignature + keyEncipherment), subjectKeyIdentifier and
 * authorityKeyIdentifier. It is not a trust anchor for TLS.
 */
function generateSelfSignedCertificate(commonName: string, validDays: number): { privatePem: string; certificatePem: string } {
  const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2_048, publicExponent: 0x10001 });
  const now = Date.now();
  const serial = positiveInteger(randomBytes(16));
  const subjectPublicKeyInfo = publicKey.export({ type: "spki", format: "der" });
  // RFC 5280 key identifiers are the SHA-1 of the subjectPublicKey BIT STRING,
  // whose bytes are exactly the PKCS#1 RSAPublicKey encoding of the key.
  const keyIdentifier = createHash("sha1").update(publicKey.export({ type: "pkcs1", format: "der" })).digest();

  const signatureAlgorithm = sequence(objectIdentifier("1.2.840.113549.1.1.11"), der(0x05, Buffer.alloc(0)));
  const extensions = sequence(
    // basicConstraints: cA=false, no path length.
    sequence(objectIdentifier("2.5.29.19"), der(0x01, Buffer.from([0xff])), octetString(sequence())),
    // keyUsage: digitalSignature (bit 0) and keyEncipherment (bit 2).
    sequence(
      objectIdentifier("2.5.29.15"),
      der(0x01, Buffer.from([0xff])),
      octetString(der(0x03, Buffer.from([0x05, 0xa0]))),
    ),
    sequence(objectIdentifier("2.5.29.14"), octetString(octetString(keyIdentifier))),
    sequence(
      objectIdentifier("2.5.29.35"),
      octetString(sequence(der(0x80, keyIdentifier))),
    ),
  );

  const tbsCertificate = sequence(
    der(0xa0, der(0x02, Buffer.from([0x02]))), // version: v3
    der(0x02, serial),
    signatureAlgorithm,
    certificateName(commonName),
    sequence(derTime(new Date(now - 5 * 60_000)), derTime(new Date(now + validDays * 86_400_000))),
    certificateName(commonName),
    subjectPublicKeyInfo,
    der(0xa3, extensions),
  );

  const signer = createSign("RSA-SHA256");
  signer.update(tbsCertificate);
  const signature = signer.sign(privateKey);
  const certificateDer = sequence(tbsCertificate, signatureAlgorithm, der(0x03, Buffer.concat([Buffer.from([0]), signature])));

  const certificatePem = pemEncode("CERTIFICATE", certificateDer);
  const privatePem = privateKey.export({ type: "pkcs8", format: "pem" }).toString();

  // Fail closed if the encoder ever produced something OpenSSL cannot consume:
  // an unusable IdP certificate must be a startup error, not an SSO outage.
  const certificate = new X509Certificate(certificatePem);
  if (!certificate.checkPrivateKey(privateKey) || !certificate.verify(publicKey)) {
    throw new Error("The generated SAML signing certificate failed self-validation.");
  }
  return { privatePem, certificatePem };
}

function pemEncode(label: string, derBytes: Buffer): string {
  const lines = derBytes.toString("base64").match(/.{1,64}/g) ?? [];
  return `-----BEGIN ${label}-----\n${lines.join("\n")}\n-----END ${label}-----\n`;
}

function der(tag: number, content: Buffer): Buffer {
  return Buffer.concat([Buffer.from([tag]), derLength(content.length), content]);
}

function sequence(...elements: Buffer[]): Buffer {
  return der(0x30, Buffer.concat(elements));
}

function objectIdentifier(dotted: string): Buffer {
  const parts = dotted.split(".").map((part) => Number(part));
  const encoded: number[] = [parts[0] * 40 + parts[1]];
  for (const part of parts.slice(2)) {
    const chunk = [part & 0x7f];
    let remaining = Math.floor(part / 128);
    while (remaining > 0) {
      chunk.unshift((remaining & 0x7f) | 0x80);
      remaining = Math.floor(remaining / 128);
    }
    encoded.push(...chunk);
  }
  return der(0x06, Buffer.from(encoded));
}

function octetString(content: Buffer): Buffer {
  return der(0x04, content);
}

function utf8String(value: string): Buffer {
  return der(0x0c, Buffer.from(value, "utf8"));
}

function certificateName(commonName: string): Buffer {
  return sequence(der(0x31, sequence(objectIdentifier("2.5.4.3"), utf8String(commonName))));
}

/** DER INTEGER from positive magnitude bytes, without a signed reinterpretation. */
function positiveInteger(magnitude: Buffer): Buffer {
  let start = 0;
  while (start < magnitude.length - 1 && magnitude[start] === 0) start += 1;
  let body = magnitude.subarray(start);
  if (body[0] === 0) body = Buffer.from([1]);
  if (body[0] & 0x80) body = Buffer.concat([Buffer.from([0]), body]);
  return body;
}

/** UTCTime through 2049, GeneralizedTime afterwards, as DER requires. */
function derTime(date: Date): Buffer {
  const iso = date.toISOString();
  if (iso.slice(0, 4) >= "1950" && iso.slice(0, 4) < "2050") {
    return der(0x17, Buffer.from(`${iso.slice(2, 19).replace(/[-:T]/g, "")}Z`, "ascii"));
  }
  return der(0x18, Buffer.from(`${iso.slice(0, 19).replace(/[-:T]/g, "")}Z`, "ascii"));
}

function derLength(length: number): Buffer {
  if (length < 0x80) return Buffer.from([length]);
  const bytes: number[] = [];
  let remaining = length;
  while (remaining > 0) {
    bytes.unshift(remaining & 0xff);
    remaining = Math.floor(remaining / 256);
  }
  return Buffer.from([0x80 | bytes.length, ...bytes]);
}
