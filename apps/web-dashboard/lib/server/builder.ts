// The core runner executes repository code without worker isolation and its
// management API does not enforce tenant identity. No dashboard route may
// contact it until both boundaries exist (including for a local operator).
export const BUILDER_DISABLED = "Engine dispatch is disabled until isolated workers and authorized management are available.";
