/**
 * Provider repository shortcodes — CloudStream-style shorthand aliases for
 * repository manifest URLs.
 *
 * Supported forms (typed into the "+" add-repository dialog):
 *   vega                       registry shortcode -> known manifest URL
 *   github:Zenda-Cross/foo     GitHub shorthand  -> raw.githubusercontent.com/.../main/repo.json
 *   Zenda-Cross/foo            bare owner/repo   -> same as github: form
 *   https://...                full URL          -> passed through untouched
 *
 * Resolution here is pure (no network): the registry pins exact URLs
 * (branch verified), and the GitHub forms construct a raw.githubusercontent
 * URL. The add-repository flow tries /main first and falls back to /master
 * via repositoryManifestCandidates, so both default branches work.
 */

const SHORTCODE_REGISTRY = {
  // Verified 2026-10-12: Vega provider manifest (Zenda-Cross fork, main branch).
  // The manifest is Vega-format; the add flow routes it to the Vega adapter.
  vega: "https://raw.githubusercontent.com/Zenda-Cross/vega-providers/main/manifest.json"
};

const OWNER_REPO_RE = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;

function clean(value) {
  return String(value || "").trim();
}

/**
 * True when the input looks like a shortcode rather than a URL.
 * Note: unlike the legacy isPluginShortCode, this also accepts the
 * `owner/repo` and `github:owner/repo` GitHub shorthands (which contain
 * exactly one slash but no scheme).
 */
export function isProviderShortCode(value) {
  const input = clean(value);
  if (!input || input.includes("://")) return false;
  const lower = input.toLowerCase();
  if (Object.prototype.hasOwnProperty.call(SHORTCODE_REGISTRY, lower)) return true;
  if (/^[A-Za-z][A-Za-z0-9_.-]*:[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(input)) return true;
  if (OWNER_REPO_RE.test(input) && !input.startsWith(".") && !input.includes("..")) return true;
  // Bare registry-style code: alnum/_/-, no dots (dots mean host/path).
  if (/^[A-Za-z0-9_-]+$/.test(input) && !input.includes(".")) return true;
  return false;
}

/**
 * Resolve a shortcode to a manifest URL, or null when it is not a
 * recognized shortcode form. Pure function — no network access.
 */
export function resolveProviderShortCode(value) {
  const input = clean(value);
  if (!input) return null;
  const lower = input.toLowerCase();
  if (Object.prototype.hasOwnProperty.call(SHORTCODE_REGISTRY, lower)) {
    return SHORTCODE_REGISTRY[lower];
  }
  let match = input.match(/^[A-Za-z][A-Za-z0-9_.-]*:([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)$/);
  if (!match && OWNER_REPO_RE.test(input)) {
    match = input.match(/^([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)$/);
  }
  if (match) {
    const [, owner, repo] = match;
    if (owner === "." || owner === ".." || repo === "." || repo === "..") return null;
    return `https://raw.githubusercontent.com/${owner}/${repo}/main/repo.json`;
  }
  return null;
}

/** The built-in registry (copy) — for UI hints and tests. */
export function listBuiltinShortcodes() {
  return Object.entries(SHORTCODE_REGISTRY).map(([code, url]) => ({ code, url }));
}
