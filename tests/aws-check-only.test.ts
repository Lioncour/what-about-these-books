import { beforeEach, describe, expect, it, vi } from "vitest";

// Every `aws` call the module makes, in order. The identity check fails as it
// does with an expired SSO session; a login would "succeed" if it were tried.
const calls: string[][] = [];

vi.mock("child_process", () => ({
  execFile: (
    _cli: string,
    args: string[],
    _opts: unknown,
    cb: (err: Error | null, out?: { stdout: string; stderr: string }) => void
  ) => {
    calls.push(args);
    if (args[0] === "sts") {
      cb(new Error("Error when retrieving token from sso: Token has expired and refresh failed"));
    } else {
      cb(null, { stdout: "", stderr: "" });
    }
  },
}));

vi.mock("@/lib/chat-debug", () => ({ logChatEvent: () => {} }));

const logins = () => calls.filter((a) => a[0] === "sso" && a[1] === "login").length;

describe("ensureAwsCredentials", () => {
  beforeEach(() => {
    calls.length = 0;
    vi.resetModules();
  });

  it("checkOnly reports an expired session without opening a login", async () => {
    const { ensureAwsCredentials } = await import("@/lib/bedrock-client");
    for (let poll = 0; poll < 3; poll++) {
      const status = await ensureAwsCredentials({ checkOnly: true });
      expect(status.ok).toBe(false);
      expect(status.loginAttempted).toBe(false);
    }
    expect(logins()).toBe(0);
  });

  it("without checkOnly an expired session still signs in", async () => {
    const { ensureAwsCredentials } = await import("@/lib/bedrock-client");
    const status = await ensureAwsCredentials();
    expect(status.loginAttempted).toBe(true);
    expect(logins()).toBe(1);
  });

  it("forceLogin wins over checkOnly", async () => {
    const { ensureAwsCredentials } = await import("@/lib/bedrock-client");
    await ensureAwsCredentials({ forceLogin: true, checkOnly: true });
    expect(logins()).toBe(1);
  });
});
