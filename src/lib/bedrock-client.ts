import {
  BedrockRuntimeClient,
  InvokeModelCommand,
  type InvokeModelCommandOutput,
} from "@aws-sdk/client-bedrock-runtime";
import { execFile } from "child_process";
import { promisify } from "util";
import { logChatEvent } from "@/lib/chat-debug";

export const AWS_REGION = process.env.AWS_REGION || "eu-central-1";
export const DEFAULT_BEDROCK_MODEL_ID =
  process.env.BEDROCK_MODEL_ID || "eu.anthropic.claude-opus-4-6-v1";

export const bedrockClient = new BedrockRuntimeClient({ region: AWS_REGION });

const execFileAsync = promisify(execFile);
const AWS_CLI_CANDIDATES = ["aws", "C:\\Program Files\\Amazon\\AWSCLIV2\\aws.exe"];
/** Re-check identity at most this often when already known-good. */
const CREDENTIALS_TTL_MS = 2 * 60 * 1000;

let credentialsVerifiedAt = 0;
let ensureCredentialsInFlight: Promise<AwsCredentialStatus> | null = null;
let lastIdentityArn: string | null = null;

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

function awsProfileArgs(): string[] {
  const profile = process.env.AWS_PROFILE?.trim();
  return profile ? ["--profile", profile] : [];
}

function errorText(error: unknown): string {
  if (!error || typeof error !== "object") return String(error);
  const err = error as { message?: string; stderr?: Buffer | string; stdout?: Buffer | string };
  const parts = [
    err.message || "",
    typeof err.stderr === "string" ? err.stderr : err.stderr?.toString("utf8") || "",
    typeof err.stdout === "string" ? err.stdout : err.stdout?.toString("utf8") || "",
  ];
  return parts.filter(Boolean).join("\n");
}

async function runAwsCli(
  args: string[],
  timeoutMs = 30000
): Promise<{ ok: boolean; message: string; stdout: string }> {
  for (const cli of AWS_CLI_CANDIDATES) {
    try {
      const result = await execFileAsync(cli, args, {
        timeout: timeoutMs,
        windowsHide: true,
        env: process.env,
        maxBuffer: 2 * 1024 * 1024,
      });
      return {
        ok: true,
        message: "",
        stdout: (result.stdout || "").toString(),
      };
    } catch (error) {
      const msg = errorText(error);
      const last = { ok: false, message: msg, stdout: "" };
      if (cli === AWS_CLI_CANDIDATES[AWS_CLI_CANDIDATES.length - 1]) return last;
    }
  }
  return { ok: false, message: "AWS CLI not found", stdout: "" };
}

let ssoLoginInFlight: Promise<boolean> | null = null;

/** Run `aws sso login` once; concurrent callers share the same browser login. */
export function runAwsSsoLogin(): Promise<boolean> {
  if (ssoLoginInFlight) return ssoLoginInFlight;
  const pending = runAwsSsoLoginOnce().finally(() => {
    if (ssoLoginInFlight === pending) ssoLoginInFlight = null;
  });
  ssoLoginInFlight = pending;
  return pending;
}

async function runAwsSsoLoginOnce(): Promise<boolean> {
  const profile = process.env.AWS_PROFILE?.trim();
  const args = profile ? ["sso", "login", "--profile", profile] : ["sso", "login"];
  for (const cli of AWS_CLI_CANDIDATES) {
    try {
      const result = await execFileAsync(cli, args, {
        timeout: 180000,
        windowsHide: true,
        env: process.env,
        maxBuffer: 2 * 1024 * 1024,
      });
      logChatEvent("aws_sso_login_auto_success", {
        cli,
        profile: profile || "default",
        stdout: (result.stdout || "").toString().slice(0, 500),
      });
      credentialsVerifiedAt = 0;
      return true;
    } catch (error) {
      logChatEvent("aws_sso_login_auto_failed", {
        cli,
        profile: profile || "default",
        error: errorText(error).slice(0, 500),
      });
    }
  }
  return false;
}

export type AwsCredentialStatus = {
  ok: boolean;
  profile: string;
  region: string;
  identity?: string;
  error?: string;
  loginAttempted?: boolean;
};

/**
 * Verify AWS creds. When missing/expired, run `aws sso login` (opens browser once).
 * Pass forceLogin to always open SSO login.
 */
export async function ensureAwsCredentials(opts?: {
  forceLogin?: boolean;
}): Promise<AwsCredentialStatus> {
  const profile = process.env.AWS_PROFILE?.trim() || "default";
  const region = AWS_REGION;
  const now = Date.now();

  if (!opts?.forceLogin && now - credentialsVerifiedAt < CREDENTIALS_TTL_MS) {
    return {
      ok: true,
      profile,
      region,
      identity: lastIdentityArn || undefined,
    };
  }

  if (ensureCredentialsInFlight && !opts?.forceLogin) {
    return ensureCredentialsInFlight;
  }

  const run = async (): Promise<AwsCredentialStatus> => {
    const identityArgs = ["sts", "get-caller-identity", "--output", "json", ...awsProfileArgs()];
    let loginAttempted = false;

    if (opts?.forceLogin) {
      loginAttempted = true;
      const loginOk = await runAwsSsoLogin();
      if (!loginOk) {
        return {
          ok: false,
          profile,
          region,
          loginAttempted,
          error:
            "AWS SSO login failed or was cancelled. Complete login in the browser.",
        };
      }
    }

    let check = await runAwsCli(identityArgs);
    if (check.ok) {
      try {
        const parsed = JSON.parse(check.stdout) as { Arn?: string };
        lastIdentityArn = parsed.Arn || null;
      } catch {
        lastIdentityArn = null;
      }
      credentialsVerifiedAt = Date.now();
      return {
        ok: true,
        profile,
        region,
        identity: lastIdentityArn || undefined,
        loginAttempted,
      };
    }

    // Offline / unreachable: a browser login would not help — report, don't open one.
    if (isNetworkErrorMessage(check.message)) {
      logChatEvent("aws_identity_check_network_error", { reason: check.message.slice(0, 300) });
      return {
        ok: false,
        profile,
        region,
        loginAttempted,
        error: "AWS is unreachable (network error). Check your connection and try again.",
      };
    }

    // Any other identity failure → try SSO login (session may have expired quietly)
    loginAttempted = true;
    logChatEvent("aws_sso_login_proactive", { reason: check.message.slice(0, 300) });
    const loginOk = await runAwsSsoLogin();
    if (!loginOk) {
      return {
        ok: false,
        profile,
        region,
        loginAttempted,
        error:
          "AWS SSO login failed. Complete login in the browser, or run: aws sso login" +
          (process.env.AWS_PROFILE ? ` --profile ${process.env.AWS_PROFILE}` : ""),
      };
    }
    check = await runAwsCli(identityArgs);

    if (!check.ok) {
      return {
        ok: false,
        profile,
        region,
        loginAttempted,
        error: check.message || "AWS credentials still unavailable after SSO login",
      };
    }

    try {
      const parsed = JSON.parse(check.stdout) as { Arn?: string };
      lastIdentityArn = parsed.Arn || null;
    } catch {
      lastIdentityArn = null;
    }
    credentialsVerifiedAt = Date.now();
    return {
      ok: true,
      profile,
      region,
      identity: lastIdentityArn || undefined,
      loginAttempted,
    };
  };

  const pending = run().finally(() => {
    if (ensureCredentialsInFlight === pending) {
      ensureCredentialsInFlight = null;
    }
  });
  if (!opts?.forceLogin) {
    ensureCredentialsInFlight = pending;
  }
  return pending;
}

/**
 * Run a Bedrock call; ensure AWS login first, then retry once after SSO on auth errors.
 * `canRetry` lets streaming callers refuse a retry once output has been emitted.
 */
export async function withBedrockAuthRetry<T>(
  operation: () => Promise<T>,
  canRetry: () => boolean = () => true
): Promise<T> {
  const status = await ensureAwsCredentials();
  if (!status.ok) {
    throw new Error(status.error || "AWS credentials unavailable");
  }

  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      return await operation();
    } catch (error) {
      if (isAbortError(error)) throw error;
      const msg = error instanceof Error ? error.message : String(error);
      if (attempt === 0 && canRetry() && isAwsAuthExpiredMessage(msg)) {
        credentialsVerifiedAt = 0;
        logChatEvent("aws_sso_login_triggered", { reason: msg.slice(0, 300) });
        const relogged = await ensureAwsCredentials({ forceLogin: true });
        if (relogged.ok) continue;
      }
      throw error;
    }
  }
  throw new Error("Bedrock request failed after AWS SSO login retry");
}

export async function sendBedrockCommand(
  command: InvokeModelCommand,
  signal?: AbortSignal
): Promise<InvokeModelCommandOutput> {
  signal?.throwIfAborted();
  return withBedrockAuthRetry(() => bedrockClient.send(command, { abortSignal: signal }));
}
