/** Pure predicates over Bedrock / AWS CLI error text (no client, safe to import anywhere). */

/** Real expiry / missing-credential signatures only — not permissions, not network. */
export function isAwsAuthExpiredMessage(message: string): boolean {
  return /ExpiredToken(?:Exception)?|The SSO session associated with this profile has expired|SSO session .* has expired|Unable to locate credentials|TokenRefreshRequired|Could not load credentials|credentials have expired|NoCredentialProviders|NoCredentials|UnrecognizedClient(?:Exception)?|InvalidClientTokenId|UnauthorizedException|security token included in the request is (?:invalid|expired)|Token has expired|provided token has expired|Error loading SSO Token|loading SSO token/i.test(
    message
  );
}

/** Offline / DNS / connection failures — a browser login won't help here. */
export function isNetworkErrorMessage(message: string): boolean {
  return /ENOTFOUND|ECONNREFUSED|ECONNRESET|ETIMEDOUT|EAI_AGAIN|ENETUNREACH|EHOSTUNREACH|getaddrinfo|Could not connect to the endpoint URL|Connect timeout|Connection was closed|socket hang up|network error|Failed to fetch|fetch failed|Max retries exceeded|SSL validation failed/i.test(
    message
  );
}

export function isAbortError(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const err = error as { name?: string; message?: string };
  return err.name === "AbortError" || /\baborted\b/i.test(err.message || "");
}
