"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { request, useCloud } from "@/lib/store";
import { Icon } from "./Icons";
import { ClientTime } from "./Time";

/**
 * The GitHub side of the console.
 *
 * An account links its GitHub identity, the repositories that identity can
 * reach are listed, and any of them can be imported as a project or handed
 * to the build system for analysis. The token is held by the server, sealed;
 * the browser never sees it.
 */

type Status = {
  connected: boolean;
  login: string | null;
  avatarUrl: string | null;
  scopes: string | null;
  repositories: number;
};

type Repository = {
  id: string;
  githubId: string;
  fullName: string;
  name: string;
  ownerName: string;
  private: number;
  defaultBranch: string;
  language: string | null;
  stars: number;
  description: string | null;
  pushedAt: number | null;
  url: string | null;
  importedProjectId: string | null;
};

type TreeFile = { path: string; type: string; size: number };

export function GithubView() {
  const { call, setToast } = useCloud();
  const [status, setStatus] = useState<Status | null>(null);
  const [repositories, setRepositories] = useState<Repository[]>([]);
  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState<Repository | null>(null);
  const [files, setFiles] = useState<TreeFile[]>([]);
  const [openFile, setOpenFile] = useState<{ path: string; content: string } | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      const [statusResponse, repoResponse] = await Promise.all([
        request("github/status") as Promise<Status>,
        request("github/repos") as Promise<{ repositories: Repository[] }>,
      ]);
      setStatus(statusResponse);
      setRepositories(repoResponse.repositories ?? []);
    } catch {
      setStatus({ connected: false, login: null, avatarUrl: null, scopes: null, repositories: 0 });
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const visible = useMemo(() => {
    const needle = query.trim().toLowerCase();
    if (!needle) return repositories;
    return repositories.filter((repo) => repo.fullName.toLowerCase().includes(needle));
  }, [repositories, query]);

  async function openRepository(repository: Repository) {
    setSelected(repository);
    setOpenFile(null);
    setFiles([]);
    try {
      const response = (await request(
        `github/tree?repository=${encodeURIComponent(repository.githubId)}&ref=${encodeURIComponent(repository.defaultBranch)}`,
      )) as { files: TreeFile[] };
      setFiles(response.files ?? []);
    } catch (error) {
      setToast(error instanceof Error ? error.message : "Could not read the repository");
    }
  }

  async function openSource(path: string) {
    if (!selected) return;
    try {
      const response = (await request(
        `github/file?repository=${encodeURIComponent(selected.githubId)}&ref=${encodeURIComponent(selected.defaultBranch)}&path=${encodeURIComponent(path)}`,
      )) as { path: string; content: string };
      setOpenFile(response);
    } catch (error) {
      setToast(error instanceof Error ? error.message : "Could not read the file");
    }
  }

  async function importRepository(repository: Repository) {
    setBusy(true);
    try {
      const result = (await call("github/import", {
        method: "POST",
        body: JSON.stringify({ repositoryId: repository.githubId, name: repository.name }),
      })) as { alreadyImported?: boolean };
      setToast(result.alreadyImported ? "That repository is already a project" : `Imported ${repository.fullName}`);
      await load();
    } catch (error) {
      setToast(error instanceof Error ? error.message : "Could not import the repository");
    } finally {
      setBusy(false);
    }
  }

  async function analyse(repository: Repository) {
    setBusy(true);
    try {
      const result = (await call("builds", {
        method: "POST",
        body: JSON.stringify({ target: "repository", repositoryId: repository.githubId, branch: repository.defaultBranch }),
      })) as { buildId?: string };
      setToast(result.buildId ? "The analysis started; follow it on the Builds page" : "The build started");
    } catch (error) {
      setToast(error instanceof Error ? error.message : "Could not start the analysis");
    } finally {
      setBusy(false);
    }
  }

  const connected = status?.connected ?? false;

  return (
    <>
      <header className="page-head">
        <div>
          <h2>GitHub</h2>
          <p>
            Link a GitHub identity to import repositories and to turn every push into a build. The token stays on the
            server, sealed; a webhook only accepts deliveries that carry its shared secret.
          </p>
        </div>
        {connected ? (
          <button
            className="ghost"
            type="button"
            disabled={busy}
            onClick={() => {
              setBusy(true);
              void call("github/sync", { method: "POST", body: "{}" })
                .then(() => setToast("Repositories refreshed"))
                .then(() => load())
                .catch((error) => setToast(error instanceof Error ? error.message : "Could not refresh the repositories"))
                .finally(() => setBusy(false));
            }}
          >
            Refresh repositories
          </button>
        ) : (
          <button className="primary" type="button" onClick={() => { window.location.href = "/api/github/connection"; }}>
            Connect GitHub
          </button>
        )}
      </header>

      {!connected && (
        <article className="panel">
          <h3>No GitHub account linked</h3>
          <p className="sub">
            Linking an account lets the console list your repositories and import one as a project. Nothing is sent to
            GitHub until you press the button, and the server needs a client id and a secret before it can offer the
            authorization.
          </p>
          <p className="banner">The operator configures <code>GITHUB_CLIENT_ID</code>, <code>GITHUB_CLIENT_SECRET</code> and <code>GITHUB_WEBHOOK_SECRET</code>.</p>
        </article>
      )}

      {connected && (
        <>
          <article className="panel">
            <div className="panel-head">
              <h3><Icon name="github" size={18} /> {status?.login}</h3>
              <span className="sub">{repositories.length} repositories · {status?.scopes}</span>
            </div>
            <input
              aria-label="Search repositories"
              placeholder="Search repositories"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              style={{ marginBottom: 12 }}
            />
            {visible.map((repository) => (
              <div key={repository.id} className="list-row" style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 12 }}>
                <button
                  type="button"
                  className="name"
                  onClick={() => void openRepository(repository)}
                  style={{ background: "none", border: "none", textAlign: "left", cursor: "pointer", padding: 0 }}
                >
                  <strong>{repository.fullName}</strong>
                  {repository.private ? " · private" : ""}
                  <div className="sub">
                    {repository.language ?? "unknown"} · {repository.defaultBranch} · {repository.stars} stars
                    {repository.pushedAt ? <> · pushed <ClientTime ts={repository.pushedAt} /></> : null}
                  </div>
                </button>
                <div className="form-row">
                  <button className="ghost" type="button" disabled={busy} onClick={() => void analyse(repository)}>
                    Analyse
                  </button>
                  <button className="primary" type="button" disabled={busy} onClick={() => void importRepository(repository)}>
                    {repository.importedProjectId ? "Imported" : "Import"}
                  </button>
                </div>
              </div>
            ))}
            {visible.length === 0 && <p className="empty">No repository matches that search.</p>}
          </article>

          {selected && (
            <article className="panel">
              <div className="panel-head">
                <h3><Icon name="branch" size={18} /> {selected.fullName}</h3>
                <button className="ghost" type="button" onClick={() => { setSelected(null); setFiles([]); setOpenFile(null); }}>
                  Close
                </button>
              </div>
              {openFile ? (
                <>
                  <p className="sub">{openFile.path}</p>
                  <pre className="term">{openFile.content.slice(0, 20000)}</pre>
                </>
              ) : (
                <div className="list-row" style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8 }}>
                  {files.slice(0, 200).map((file) => (
                    <button
                      key={file.path}
                      type="button"
                      className="name"
                      onClick={() => void openSource(file.path)}
                      style={{ background: "none", border: "none", textAlign: "left", cursor: "pointer", padding: 0 }}
                    >
                      {file.path}
                      <div className="sub">{file.size} bytes</div>
                    </button>
                  ))}
                </div>
              )}
              {files.length === 0 && !openFile && <p className="empty">That branch has no files the token can read.</p>}
            </article>
          )}
        </>
      )}
    </>
  );
}
