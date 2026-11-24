//! Fresh, shallow HTTPS checkout for an operator-configured repository/ref.

use std::path::Path;

use git2::{build::CheckoutBuilder, FetchOptions, RemoteRedirect, Repository};

pub fn valid_commit(commit: &str) -> bool {
    commit.len() == 40 && commit.bytes().all(|b| b.is_ascii_hexdigit())
}

pub fn shallow_fetch(
    home: &Path,
    url: &str,
    branch: &str,
    expected: Option<&str>,
) -> anyhow::Result<(tempfile::TempDir, String)> {
    let checkout = tempfile::tempdir_in(home.join("sources"))?;
    let mut init = git2::RepositoryInitOptions::new();
    init.external_template(false);
    let repo = Repository::init_opts(checkout.path(), &init)?;
    let mut remote = repo.remote_anonymous(url)?;
    anyhow::ensure!(
        remote.url() == Some(url),
        "Git configuration attempted to rewrite the configured repository URL"
    );
    let mut options = FetchOptions::new();
    options
        .depth(1)
        .follow_redirects(RemoteRedirect::None)
        .proxy_options(git2::ProxyOptions::new());
    options.download_tags(git2::AutotagOption::None);
    let mut callbacks = git2::RemoteCallbacks::new();
    let started = std::time::Instant::now();
    callbacks.transfer_progress(move |_| started.elapsed() < std::time::Duration::from_secs(90));
    options.remote_callbacks(callbacks);
    let refspec = format!("refs/heads/{branch}:refs/remotes/origin/{branch}");
    remote
        .fetch(&[&refspec], Some(&mut options), None)
        .map_err(|_| anyhow::anyhow!("could not fetch the configured repository/ref"))?;
    let commit = repo
        .find_reference(&format!("refs/remotes/origin/{branch}"))?
        .peel_to_commit()?;
    let actual = commit.id().to_string();
    anyhow::ensure!(
        expected.is_none_or(|expected| expected.eq_ignore_ascii_case(&actual)),
        "requested commit does not match the fetched branch tip"
    );
    repo.checkout_tree(commit.as_object(), Some(CheckoutBuilder::new().force()))?;
    repo.set_head_detached(commit.id())?;
    Ok((checkout, actual))
}
