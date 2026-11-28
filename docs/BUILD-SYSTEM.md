# The live build system

A build is a row, a step timeline and an event log. The runner emits events as
the work happens, and each event is both stored — so the build can be replayed
later — and published on the realtime bus, so the dashboard sees it as it
happens.

## The event protocol

```ts
interface BuildEvent {
  type: "log" | "progress" | "step" | "metric" | "error" | "complete";
  timestamp: number;
  buildId: string;
  stream?: "stdout" | "stderr";
  line?: string;
  percentage?: number;
  currentStep?: string;
  eta?: number;
  stepName?: string;
  stepStatus?: "running" | "success" | "failed" | "skipped";
  duration?: number;
  metric?: { bundleSize?: number; fileCount?: number; totalBytes?: number; framework?: string; cacheHitRate?: number };
}
```

| Event | Meaning |
|:---|:---|
| `log` | A line of output from the build |
| `progress` | How far the build is, and what it is doing now |
| `step` | A step started, finished, failed or was skipped |
| `metric` | A measurement: file count, size, framework, cache |
| `error` | Something went wrong |
| `complete` | The build finished, one way or the other |

Every event is also published on the realtime bus as `build.event`, so the
console does not have to poll to stay current. Polling every two seconds is
only the fallback for a client whose socket is not connected.

## The targets

| Target | What it runs | What may execute |
|:---|:---|:---|
| `web` | `npm run build` in the console | The platform's own build |
| `android` | `gradlew :app:assembleDebug` | The platform's own build |
| `repository` | Fetch, detect, hash, decide, allocate | **Nothing** |

## What may run, and what may not

A build that executes code runs only the platform's own trusted targets, from
a fixed command list and a fixed directory. The command is not taken from the
request.

A repository connected through GitHub is **analysed, never executed**. The
analysis fetches the tree through the GitHub API, detects the framework from
the manifest, hashes every file, compares the hash with the last successful
build of the same branch, and allocates a preview address. The compile step is
not run, because the isolated worker boundary that the engine still owes is
not something the build route may quietly step over.

## The cache decision

The content key of a tree is the SHA-256 of every path and its content, in
path order. Two builds of the same sources always produce the same key, and
any change produces a different one — so the cache decision is a comparison,
not a guess:

- the same key as the last successful build → the cache answers the whole
  build, and the log says so;
- a different key → only the changed files need rebuilding;
- no previous build → the cache is cold.

The key is stored on the build row, so the next build of the branch can
compare against it.

## The preview address

Every build that reaches the preview step gets one:

```
https://<console-origin>/preview/<branch>-<build id prefix>
```

The branch is normalised to a safe host label, so `feat/new thing` becomes
`feat-new-thing`.

## The console

`/builds` shows the builds with their progress, and the selected build with
its step timeline, its metrics and its log, live. The realtime bus drives it;
polling is the fallback.

## The API

| Method | Path | Purpose |
|:---|:---|:---|
| `GET` | `/api/builds` | The builds of the account |
| `GET` | `/api/builds/{id}` | A build with its steps and events |
| `POST` | `/api/builds` | Start a build |
| `POST` | `/api/github/webhook` | A push becomes a build |

`POST /api/builds` answers `202` with the build id: the build runs in the
background and the caller follows it.
