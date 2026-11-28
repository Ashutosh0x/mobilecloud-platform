# GitHub integration

MobileCloud can act on a repository the moment it changes. An account links
its GitHub identity, the repositories that identity can reach are listed in the
console, and a push, a pull request or a release becomes a build.

## The two halves

| Half | Path | Who calls it |
|:---|:---|:---|
| **OAuth** | `/api/github/connection` → `/api/github/callback` | The signed-in browser |
| **Webhook** | `POST /api/github/webhook` | GitHub |

The browser half lets a person connect an account and browse repositories. The
webhook half lets GitHub push work into the platform without anybody watching.

## Configuration

Nothing is enabled until the operator configures it:

```bash
GITHUB_CLIENT_ID=...            # from the GitHub OAuth app
GITHUB_CLIENT_SECRET=...        # never leaves the server
GITHUB_WEBHOOK_SECRET=...       # the shared secret of the webhook delivery
```

Without a client id and secret the connect endpoint answers `503` rather than
half-working. Without a webhook secret the webhook receiver answers `503`
rather than accepting deliveries it cannot authenticate — an unconfigured
webhook is closed, not open.

The OAuth app needs this callback address:

```
https://<your-console-origin>/api/github/callback
```

## How the token is kept

The access token is **sealed** before it is stored:

- a 32-byte master key is generated once and kept in the `secrets` table;
- the token is encrypted with AES-256-GCM under that key;
- the stored value is `iv.authTag.ciphertext`, all base64url.

A database dump therefore does not hand over a GitHub token. This is not a
substitute for a secrets manager — the master key sits beside the tokens it
protects — but it does mean the token is not sitting in the database in the
clear, and the browser never receives it at all.

## The webhook

Every delivery is checked against `X-Hub-Signature-256` with a constant-time
comparison, over the exact bytes GitHub sent. A delivery that does not verify is
refused with `401` before the body is looked at.

The events that matter:

| Event | What the platform does |
|:---|:---|
| `push` | Starts a build for the branch |
| `pull_request` | Starts a build for the pull request's head |
| `release` | Starts a build for the tag |

The event is read apart by `parseWebhookEvent`, which returns the repository,
the branch, the commit and the pull request number. An event that carries
none of those is acknowledged and ignored rather than treated as an error, so
a GitHub delivery for a repository the platform does not serve never fails.

## The console

`/github` in the console:

- connects and disconnects an identity;
- lists the repositories the identity can reach, newest push first;
- opens a repository: the file tree at a ref, and the content of a file;
- imports a repository as a project;
- starts an analysis of a repository.

## The API

| Method | Path | Purpose |
|:---|:---|:---|
| `POST` | `/api/github/connection` | Start the OAuth round trip |
| `GET` | `/api/github/callback` | Finish it and store the connection |
| `GET` | `/api/github/status` | Whether an account is linked |
| `GET` | `/api/github/repos` | The repositories of the connection |
| `POST` | `/api/github/sync` | Refresh the list from GitHub |
| `GET` | `/api/github/tree` | The file tree of a repository |
| `GET` | `/api/github/file` | The content of one file |
| `POST` | `/api/github/import` | Import a repository as a project |
| `DELETE` | `/api/github/connection` | Disconnect and forget the token |
| `POST` | `/api/github/webhook` | Receive a delivery from GitHub |
| `POST` | `/api/github/device/code` | Start a device authorization |
| `POST` | `/api/github/device/token` | Poll a device authorization |

Every route except the webhook and the device authorization needs a session;
the mutation routes also need the CSRF token, exactly like the rest of the
console.

## The device flow

A CLI or a phone that cannot open a browser on the same device as the console
uses the device flow: `POST /api/github/device/code` returns a user code and a
verification address, and `POST /api/github/device/token` polls until the
person has approved it in GitHub. The token is stored the same way — sealed —
and the caller still has to be signed in to the console.
