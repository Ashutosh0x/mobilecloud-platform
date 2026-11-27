# Passkeys & Biometrics

Status: **web passkey sign-in, passkey management and WebAuthn payment step-up
are implemented and tested at the server level.** Android has a Credential
Manager passkey manager and approval UI, but its routing remains incomplete.
There is no iOS app in this repository.

## How it works here

The private key never leaves the authenticator. The server stores only the COSE
public key, credential id, sign counter, transports, AAGUID and a device label.
The browser gets a base64url challenge; `navigator.credentials` opens the
platform biometric/PIN prompt; the server verifies the signature, origin, RP id
hash and UV flag, then rejects a non-increasing counter.

| Flow | Browser API | UV | Server |
| :--- | :--- | :--- | :--- |
| Register | `credentials.create()` | required | `POST /api/auth/passkey/register/begin` → finish |
| Sign in | `credentials.get()` | required | `POST /api/auth/passkey/login/begin` → finish |
| Conditional UI | `get({ mediation: "conditional" })` | required | same login endpoints, discovered credential |
| Add passkey | `credentials.create()` | required | same register endpoints, session + CSRF |
| Payment step-up | `credentials.get()` | required | `POST /api/auth/step-up/begin` → verify |

## Web

* `/login` offers **Sign in with a passkey** and starts a conditional request on
  page load. The email field uses `autocomplete="username webauthn"`, so
  passkeys appear in the browser's autofill menu on supported platforms.
* `/security` lists passkeys, adds new ones, removes them and runs a demo
  biometric step-up. Removing the last passkey is refused when the account has
  no password fallback.
* Sign-in with a web passkey creates a `web` session (not an Android session).

## Payment / security step-up

`lib/server/stepup.ts` implements the boundary FurlPay needs:

1. FurlPay (or the console) requests a challenge for one action and the exact
   payload (`amount`, `currency`, `recipient`, …).
2. The browser signs it with a passkey (`userVerification: "required"`).
3. The server verifies the assertion, the account, the payload hash and the UV
   flag, then marks the challenge used.
4. It issues a five-minute RS256 **step-up token** with `typ: "stepup"`,
   `aud` = client, `action`, `payload_hash`, `sub` and `jti`.

The FurlPay adapter's `verifyStepUpToken()` checks signature, issuer, audience,
`typ`, action, payload hash and expiry. Changing the amount or recipient after
approval invalidates the token. An ordinary SSO session or access token is not a
step-up token and cannot authorize a financial action.

The console's demo step-up uses client id `mobilecloud-console`; FurlPay uses its
registered client id and a confidential client for server-to-server begin/verify.

## Configuration

| Variable | Purpose |
| :--- | :--- |
| `MOBILECLOUD_WEBAUTHN_RP_ID` | RP id; must equal the console hostname or a parent domain (e.g. `furlpay.com` for `auth.furlpay.com`). Defaults to the hostname. |
| `ANDROID_PACKAGE_NAME` | App package for `/.well-known/assetlinks.json`. |
| `ANDROID_CERT_SHA256` | Comma-separated signing-cert SHA-256 fingerprints. |
| `APPLE_TEAM_ID`, `APPLE_BUNDLE_ID` | `/.well-known/apple-app-site-association` app identifier. |

The binding files return **404** when unconfigured rather than publishing a
wrong fingerprint, because iOS/Android cache malformed associations.

## Android

`android-app/.../auth/PasskeyManager.kt` uses AndroidX Credential Manager with
`PreferImmediatelyAvailableCredentials = false`, calls the same begin/finish
endpoints, and returns a sealed result for cancellation, missing credential and
errors. `LoginApprovalScreen.kt` uses `BIOMETRIC_STRONG | DEVICE_CREDENTIAL`
before approving a QR/CLI request, and `AuthRequestNotifier.kt` prepares the
notification channel.

**Still missing:** `MainActivity`/`ConsoleRoot` do not route the approval intent
or start the passkey flow from the console shell, and no push transport is
configured. The screen compiles but is not reachable end to end.

## iOS

No iOS application exists in this repository. The required Apple Associated
Domains endpoint (`/.well-known/apple-app-site-association`) is implemented and
configurable, but the native `ASAuthorizationController` client, entitlements and
bundle id are FurlPay's iOS app work.

## Limitations

* WebAuthn RP id cannot change after passkeys are registered; set
  `MOBILECLOUD_WEBAUTHN_RP_ID` before the first enrollment.
* The origin check is exact. A ceremony performed on `https://furlpay.com` is
  not accepted for the `https://auth.furlpay.com` origin; FurlPay's app must use
  its own RP/origin pair (or the deployment must align origins). This is not a
  shared-origin passkey setup yet.
* Account recovery is password/operator-assisted; recovery codes and email magic
  links are not implemented.
* No attestation verification (`attestation: "none"`); AAGUID is recorded only.
* No iOS app, and Android intent routing remains open.
