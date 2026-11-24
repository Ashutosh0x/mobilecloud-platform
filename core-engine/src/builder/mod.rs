//! Trusted local preview builder and deployment state.

pub mod atomic_promoter;
pub mod bun_runner;
pub mod framework_detector;
pub mod git_cloner;

pub use atomic_promoter::DeploymentStore;

pub fn valid_project(project: &str) -> bool {
    let mut bytes = project.bytes();
    let alnum = |b: u8| b.is_ascii_lowercase() || b.is_ascii_digit();
    project.len() <= 63
        && bytes.next().is_some_and(alnum)
        && project.as_bytes().last().copied().is_some_and(alnum)
        && bytes.all(|b| alnum(b) || b == b'-')
        && !matches!(project, "con" | "prn" | "aux" | "nul")
        && !["com", "lpt"].iter().any(|prefix| {
            project
                .strip_prefix(prefix)
                .is_some_and(|s| s.len() == 1 && s.as_bytes()[0].is_ascii_digit())
        })
}

pub fn valid_deploy_id(id: &str) -> bool {
    id.strip_prefix("dpl_").is_some_and(|hex| {
        hex.len() == 24
            && hex
                .bytes()
                .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
    })
}

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct DeployRecord {
    pub project: String,
    pub deploy_id: String,
    pub commit: String,
    pub branch: String,
    pub framework: String,
    pub built_at: u64,
    pub ttfb_hint_ms: Option<u32>,
    pub trigger_source: Option<String>,
}
