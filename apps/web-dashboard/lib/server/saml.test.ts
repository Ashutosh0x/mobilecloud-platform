import assert from "node:assert/strict";
import { X509Certificate } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { DatabaseSync } from "node:sqlite";
import { deflateRawSync } from "node:zlib";
import { DOMParser, XMLSerializer } from "@xmldom/xmldom";
import { SignedXml } from "xml-crypto";
import { openDb } from "./db.ts";
import {
  buildMetadata,
  buildResponse,
  createServiceProvider,
  deleteServiceProvider,
  ensureSamlKey,
  findServiceProvider,
  listServiceProviders,
  parseAuthnRequest,
  samlConfig,
  type SamlAuthnRequest,
  type SamlConfig,
} from "./saml.ts";

const SAML_PROTOCOL_NS = "urn:oasis:names:tc:SAML:2.0:protocol";
const SAML_ASSERTION_NS = "urn:oasis:names:tc:SAML:2.0:assertion";
const DSIG_NS = "http://www.w3.org/2000/09/xmldsig#";
const EXCLUSIVE_C14N = "http://www.w3.org/2001/10/xml-exc-c14n#";
const RSA_SHA256 = "http://www.w3.org/2001/04/xmldsig-more#rsa-sha256";
const SHA256_DIGEST = "http://www.w3.org/2001/04/xmlenc#sha256";
const ENVELOPED_SIGNATURE = "http://www.w3.org/2000/09/xmldsig#enveloped-signature";
const NAME_ID_EMAIL = "urn:oasis:names:tc:SAML:1.1:nameid-format:emailAddress";

const ORIGIN = "https://idp.example.com";
const ENTITY_ID = "https://sp.example.com/metadata";
const ACS = "https://sp.example.com/saml/acs";

let resolvedSsoUrl: string | undefined;

/**
 * The SSO URL the module advertises, resolved once. The public path is an
 * integration decision (next.config.mjs rewrites it to the catch-all API
 * route), so request fixtures follow the module instead of duplicating it.
 */
function ssoUrl(): string {
  if (resolvedSsoUrl) return resolvedSsoUrl;
  const db = freshDb();
  try {
    const resolved = samlConfig(db, ORIGIN).ssoUrl;
    resolvedSsoUrl = resolved;
    return resolved;
  } finally {
    db.close();
  }
}

function freshDb(): DatabaseSync {
  const file = join(mkdtempSync(join(tmpdir(), "mc-saml-")), "t.db");
  const db = openDb(file);
  db.prepare(
    "INSERT INTO users (id, email, name, password_hash, role, plan, created_at) VALUES ('u1', 'a@b.co', 'A', '!', 'owner', 'community', ?)",
  ).run(Date.now());
  return db;
}

/** The minimal config request parsing needs; keys are only used for responses. */
function parseConfig(): SamlConfig {
  return {
    issuer: ORIGIN,
    ssoUrl: ssoUrl(),
    metadataUrl: `${ORIGIN}/saml/metadata`,
    certificatePem: "",
    privateKeyPem: "",
  };
}

function requestXml(
  options: {
    id?: string;
    issuer?: string;
    destination?: string | null;
    acsUrl?: string | null;
    forceAuthn?: boolean;
  } = {},
): string {
  const id = options.id ?? "_request1";
  const issuer = options.issuer ?? ENTITY_ID;
  const destination = options.destination === undefined ? ssoUrl() : options.destination;
  const acsUrl = options.acsUrl === undefined ? ACS : options.acsUrl;
  const attributes = [
    `xmlns:samlp="${SAML_PROTOCOL_NS}"`,
    `xmlns:saml="${SAML_ASSERTION_NS}"`,
    `ID="${id}"`,
    'Version="2.0"',
    `IssueInstant="${new Date().toISOString()}"`,
  ];
  if (destination) attributes.push(`Destination="${destination}"`);
  if (acsUrl) attributes.push(`AssertionConsumerServiceURL="${acsUrl}"`);
  if (options.forceAuthn) attributes.push('ForceAuthn="true"');
  return (
    `<samlp:AuthnRequest ${attributes.join(" ")}>` +
    `<saml:Issuer>${issuer}</saml:Issuer>` +
    `</samlp:AuthnRequest>`
  );
}

/** The SAML HTTP-Redirect binding: raw DEFLATE, base64, URL-encoded. */
function redirectRequest(xml: string, relayState = "state-1"): { SAMLRequest: string; RelayState: string } {
  return { SAMLRequest: deflateRawSync(Buffer.from(xml, "utf8")).toString("base64"), RelayState: relayState };
}

function parse(xml: string) {
  return new DOMParser({ onError: () => undefined }).parseFromString(xml, "text/xml");
}

/** Sign an AuthnRequest the way a service provider would, for request tests. */
function signRequest(xml: string, config: SamlConfig): string {
  const signer = new SignedXml({
    privateKey: config.privateKeyPem,
    publicCert: config.certificatePem,
    idAttribute: "ID",
    signatureAlgorithm: RSA_SHA256,
    canonicalizationAlgorithm: EXCLUSIVE_C14N,
  });
  signer.addReference({
    xpath: "//*[local-name(.)='AuthnRequest']",
    transforms: [ENVELOPED_SIGNATURE, EXCLUSIVE_C14N],
    digestAlgorithm: SHA256_DIGEST,
  });
  signer.computeSignature(xml, {
    prefix: "ds",
    location: { reference: "//*[local-name(.)='AuthnRequest']/*[local-name(.)='Issuer']", action: "after" },
  });
  return signer.getSignedXml();
}

test("metadata publishes the entity, the SSO endpoints and the signing certificate", () => {
  const db = freshDb();
  const config = samlConfig(db, ORIGIN);
  const metadata = buildMetadata(config);

  assert.match(metadata, /<md:EntityDescriptor/);
  assert.ok(metadata.includes(`entityID="${ORIGIN}"`));
  assert.ok(metadata.includes(`Location="${config.ssoUrl}"`));
  assert.ok(metadata.includes("urn:oasis:names:tc:SAML:2.0:bindings:HTTP-Redirect"));
  assert.ok(metadata.includes("urn:oasis:names:tc:SAML:2.0:bindings:HTTP-POST"));
  assert.ok(metadata.includes(NAME_ID_EMAIL));

  const body = /<ds:X509Certificate>([A-Za-z0-9+/=]+)<\/ds:X509Certificate>/.exec(metadata)?.[1];
  assert.ok(body);
  const pemBody = config.certificatePem.replace(/-----[^-]+-----/g, "").replace(/\s+/g, "");
  assert.equal(body, pemBody);

  // The certificate itself must be a valid, in-date X.509 certificate.
  const certificate = new X509Certificate(config.certificatePem);
  assert.match(certificate.subject, /CN=mobilecloud-idp/);
  assert.ok(new Date(certificate.validTo).getTime() > Date.now());
  db.close();
});

test("the signing key is generated once, stored and reused", () => {
  const db = freshDb();
  const first = ensureSamlKey(db);
  const second = ensureSamlKey(db);
  assert.equal(first.certificatePem, second.certificatePem);
  assert.equal(first.privatePem, second.privatePem);
  assert.match(first.certificatePem, /^-----BEGIN CERTIFICATE-----/);
  assert.match(first.privatePem, /^-----BEGIN PRIVATE KEY-----/);

  const row = db.prepare("SELECT kid, alg, public_jwk, active FROM signing_keys WHERE alg = 'SAML'").get() as {
    kid: string;
    alg: string;
    public_jwk: string;
    active: number;
  };
  assert.match(row.kid, /^[a-f0-9]{16}$/);
  assert.equal(row.alg, "SAML");
  assert.equal(row.public_jwk, "{}");
  assert.equal(Number(row.active), 1);
  assert.equal(Number((db.prepare("SELECT COUNT(*) AS n FROM signing_keys WHERE alg = 'SAML'").get() as { n: number }).n), 1);
  db.close();
});

test("a service provider can be registered, listed and deleted", () => {
  const db = freshDb();
  const created = createServiceProvider(db, { entityId: ENTITY_ID, acsUrl: ACS });
  assert.equal(created.entityId, ENTITY_ID);
  assert.equal(created.acsUrl, ACS);
  assert.equal(created.sloUrl, null);
  assert.equal(created.certificatePem, null);
  assert.equal(created.nameIdFormat, NAME_ID_EMAIL);

  assert.deepEqual(listServiceProviders(db).map((sp) => sp.id), [created.id]);
  assert.deepEqual(findServiceProvider(db, ENTITY_ID), created);

  assert.equal(deleteServiceProvider(db, created.id), true);
  assert.equal(deleteServiceProvider(db, created.id), false);
  assert.equal(findServiceProvider(db, ENTITY_ID), null);
  assert.deepEqual(listServiceProviders(db), []);
  db.close();
});

test("invalid registrations and duplicates are rejected", () => {
  const db = freshDb();
  createServiceProvider(db, { entityId: ENTITY_ID, acsUrl: ACS });
  assert.throws(() => createServiceProvider(db, { entityId: ENTITY_ID, acsUrl: ACS }), /already registered/);
  assert.throws(
    () => createServiceProvider(db, { entityId: "relative/entity", acsUrl: ACS }),
    /absolute URI/,
  );
  assert.throws(
    () => createServiceProvider(db, { entityId: "https://plain.example.com", acsUrl: "http://sp.example.com/acs" }),
    /HTTPS/,
  );
  assert.throws(
    () =>
      createServiceProvider(db, {
        entityId: "https://plain.example.com",
        acsUrl: ACS,
        certificatePem: "definitely not a certificate",
      }),
    /PEM/,
  );
  assert.throws(
    () => createServiceProvider(db, { entityId: "https://slo.example.com", acsUrl: ACS, sloUrl: "ftp://sp.example.com/slo" }),
    /HTTPS/,
  );

  // http is only allowed for loopback development targets.
  const local = createServiceProvider(db, {
    entityId: "https://local.example.com/metadata",
    acsUrl: "http://127.0.0.1:8080/saml/acs",
  });
  assert.equal(local.acsUrl, "http://127.0.0.1:8080/saml/acs");
  db.close();
});

test("a deflated AuthnRequest for a registered service provider is accepted", () => {
  const db = freshDb();
  createServiceProvider(db, { entityId: ENTITY_ID, acsUrl: ACS });
  const xml = requestXml({ forceAuthn: true, acsUrl: "https://attacker.example.com/acs" });
  const parsed = parseAuthnRequest(db, parseConfig(), redirectRequest(xml, "relay-1"));

  assert.equal(parsed.id, "_request1");
  assert.equal(parsed.issuer, ENTITY_ID);
  assert.equal(parsed.relayState, "relay-1");
  assert.equal(parsed.forceAuthn, true);
  // The registered ACS wins; the request's AssertionConsumerServiceURL is ignored.
  assert.equal(parsed.acsUrl, ACS);
  assert.equal(parsed.destination, ssoUrl());
  db.close();
});

test("a plain XML AuthnRequest from the POST binding is accepted", () => {
  const db = freshDb();
  createServiceProvider(db, { entityId: ENTITY_ID, acsUrl: ACS });
  const parsed = parseAuthnRequest(db, parseConfig(), {
    SAMLRequest: Buffer.from(requestXml(), "utf8").toString("base64"),
    RelayState: null,
  });
  assert.equal(parsed.issuer, ENTITY_ID);
  assert.equal(parsed.relayState, "");
  assert.equal(parsed.forceAuthn, false);
  assert.equal(parsed.acsUrl, ACS);
  db.close();
});

test("an unknown service provider and a wrong destination are rejected", () => {
  const db = freshDb();
  createServiceProvider(db, { entityId: ENTITY_ID, acsUrl: ACS });
  assert.throws(
    () => parseAuthnRequest(db, parseConfig(), redirectRequest(requestXml({ issuer: "https://unknown.example.com" }))),
    /not registered/,
  );
  assert.throws(
    () =>
      parseAuthnRequest(
        db,
        parseConfig(),
        redirectRequest(requestXml({ destination: "https://evil.example.com/api/saml/sso" })),
      ),
    /different destination/,
  );
  assert.throws(() => parseAuthnRequest(db, parseConfig(), { SAMLRequest: null }), /missing/);
  assert.throws(
    () => parseAuthnRequest(db, parseConfig(), { SAMLRequest: Buffer.from("not xml at all").toString("base64") }),
    /neither plain XML nor a deflate stream|not a SAML XML document/,
  );
  db.close();
});

test("a document type declaration is refused before parsing", () => {
  const db = freshDb();
  createServiceProvider(db, { entityId: ENTITY_ID, acsUrl: ACS });
  const xml = requestXml().replace(
    "<samlp:AuthnRequest",
    '<!DOCTYPE samlp:AuthnRequest [<!ENTITY xxe SYSTEM "file:///etc/passwd">]><samlp:AuthnRequest',
  );
  assert.throws(
    () => parseAuthnRequest(db, parseConfig(), { SAMLRequest: Buffer.from(xml, "utf8").toString("base64") }),
    /document type or entity declaration/,
  );
  db.close();
});

test("a service provider with a certificate must sign its requests", () => {
  const db = freshDb();
  const config = samlConfig(db, ORIGIN);
  createServiceProvider(db, { entityId: ENTITY_ID, acsUrl: ACS, certificatePem: config.certificatePem });
  assert.throws(
    () => parseAuthnRequest(db, config, redirectRequest(requestXml())),
    /must sign its requests/,
  );
  db.close();
});

test("a signed AuthnRequest is verified against the registered certificate", () => {
  const db = freshDb();
  const config = samlConfig(db, ORIGIN);
  // The fixture reuses the IdP keypair as the SP's: it is a valid self-signed
  // X.509 pair, which is all request-signature verification needs.
  createServiceProvider(db, { entityId: ENTITY_ID, acsUrl: ACS, certificatePem: config.certificatePem });

  const signed = signRequest(requestXml(), config);
  const parsed = parseAuthnRequest(db, config, redirectRequest(signed, "relay-2"));
  assert.equal(parsed.issuer, ENTITY_ID);
  assert.equal(parsed.relayState, "relay-2");
  assert.equal(parsed.acsUrl, ACS);

  // Tampering with a signed request breaks the digest and is refused.
  const tampered = signed.replace('Version="2.0"', 'Version="2.0" ForceAuthn="true"');
  assert.throws(
    () => parseAuthnRequest(db, config, redirectRequest(tampered)),
    /signature on the SAML request could not be verified/,
  );
  db.close();
});

test("a signature moved onto another request element is refused (signature wrapping)", () => {
  const db = freshDb();
  const config = samlConfig(db, ORIGIN);
  createServiceProvider(db, { entityId: ENTITY_ID, acsUrl: ACS, certificatePem: config.certificatePem });

  // Move the valid signature from the request it covers onto a new outer
  // request that keeps the original (signed) request nested. The enveloped
  // transform means the digest still matches the inner element, so only the
  // reference-id check stands between this document and a forged login.
  const signed = signRequest(requestXml(), config);
  const signatureMatch = /<ds:Signature[\s\S]*?<\/ds:Signature>/.exec(signed);
  assert.ok(signatureMatch);
  const signatureXml = signatureMatch[0];
  const inner = signed.replace(signatureXml, "");
  const wrapped =
    `<samlp:AuthnRequest xmlns:samlp="${SAML_PROTOCOL_NS}" xmlns:saml="${SAML_ASSERTION_NS}"` +
    ` ID="_wrapped" Version="2.0" IssueInstant="${new Date().toISOString()}"` +
    ` Destination="${ssoUrl()}" ForceAuthn="true">` +
    `<saml:Issuer>${ENTITY_ID}</saml:Issuer>${signatureXml}${inner}</samlp:AuthnRequest>`;

  assert.throws(
    () => parseAuthnRequest(db, config, redirectRequest(wrapped)),
    /signature on the SAML request could not be verified/,
  );
  db.close();
});

test("the signed response carries the assertion, audience and auto-submit form", () => {
  const db = freshDb();
  const config = samlConfig(db, ORIGIN);
  const sp = createServiceProvider(db, { entityId: ENTITY_ID, acsUrl: ACS });
  const request: SamlAuthnRequest = {
    id: "_request1",
    issuer: ENTITY_ID,
    acsUrl: ACS,
    destination: config.ssoUrl,
    relayState: 'state-&"<>',
    forceAuthn: false,
  };

  const result = buildResponse(config, sp, { id: "u1", email: "a@b.co", name: "Ada Lovelace" }, request);
  const doc = parse(result.xml);

  const assertion = doc.getElementsByTagNameNS(SAML_ASSERTION_NS, "Assertion").item(0);
  assert.ok(assertion);
  const childNames = Array.from({ length: assertion.childNodes.length }, (_, index) =>
    assertion.childNodes.item(index)?.nodeName,
  );
  // SAML schema: Issuer, then the enveloped Signature, then Subject.
  assert.equal(childNames[0], "saml:Issuer");
  assert.equal(childNames[1], "ds:Signature");
  assert.equal(childNames[2], "saml:Subject");

  const signature = doc.getElementsByTagNameNS(DSIG_NS, "Signature").item(0);
  assert.ok(signature);
  const verifier = new SignedXml({
    publicCert: config.certificatePem,
    getCertFromKeyInfo: () => config.certificatePem,
  });
  verifier.loadSignature(new XMLSerializer().serializeToString(signature));
  assert.equal(verifier.checkSignature(result.xml), true);

  assert.ok(result.xml.includes(`<saml:Audience>${ENTITY_ID}</saml:Audience>`));
  assert.ok(result.xml.includes('InResponseTo="_request1"'));
  assert.ok(result.xml.includes(`Destination="${ACS}"`));
  assert.ok(result.xml.includes('Recipient="' + ACS + '"'));
  assert.ok(result.xml.includes(`<saml:NameID Format="${NAME_ID_EMAIL}">a@b.co</saml:NameID>`));
  assert.ok(result.xml.includes('Name="email"'));
  assert.ok(result.xml.includes(">a@b.co</saml:AttributeValue>"));
  assert.ok(result.xml.includes('Name="name"'));
  assert.ok(result.xml.includes(">Ada Lovelace</saml:AttributeValue>"));
  assert.ok(result.xml.includes('Name="uid"'));
  assert.ok(result.xml.includes(">u1</saml:AttributeValue>"));
  assert.ok(result.xml.includes("urn:oasis:names:tc:SAML:2.0:ac:classes:PasswordProtectedTransport"));
  assert.ok(result.xml.includes("<ds:X509Certificate>"));

  assert.ok(result.html.includes('name="SAMLResponse"'));
  assert.ok(result.html.includes(`action="${ACS}"`));
  assert.ok(result.html.includes('name="RelayState" value="state-&amp;&quot;&lt;&gt;"'));
  assert.ok(result.html.includes("document.forms[0].submit()"));
  assert.ok(result.html.includes(Buffer.from(result.xml, "utf8").toString("base64")));
  db.close();
});
