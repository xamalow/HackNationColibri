// Errors shared by the platform adapters and publish.mjs. Messages name env vars, never their values.

/** No credentials in the environment for a real platform adapter. */
export class NotConfiguredError extends Error {
  constructor(platform, missing) {
    super(`${platform} adapter is not configured: set ${missing.join(", ")} in the environment (never in git)`);
    this.name = "NotConfiguredError";
    this.code = "not_configured";
    this.platform = platform;
    this.missing = missing;
  }
}

/** Credentials are present but this build has no live transport for the call (no network in the demo build). */
export class NotImplementedError extends Error {
  constructor(platform, what) {
    super(`${platform}: ${what} is not wired in this build; the payload is built but nothing is sent`);
    this.name = "NotImplementedError";
    this.code = "not_implemented";
    this.platform = platform;
  }
}

/** The platform has no API for this change (e.g. listing content edited only in the partner portal). */
export class UnsupportedByPlatformError extends Error {
  constructor(platform, what) {
    super(`${platform} has no API for ${what}; Noor's helper must apply it in the partner portal`);
    this.name = "UnsupportedByPlatformError";
    this.code = "unsupported_by_platform";
    this.platform = platform;
  }
}

/** Read named env vars; throw NotConfiguredError listing the missing NAMES. */
export function requireEnv(platform, env, names) {
  const missing = names.filter((n) => typeof env[n] !== "string" || env[n].trim() === "");
  if (missing.length) throw new NotConfiguredError(platform, missing);
  return Object.fromEntries(names.map((n) => [n, env[n]]));
}
