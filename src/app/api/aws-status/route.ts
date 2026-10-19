import { NextRequest, NextResponse } from "next/server";
import { ensureAwsCredentials } from "@/lib/bedrock-client";

export async function GET(request: NextRequest) {
  const force = request.nextUrl.searchParams.get("force") === "1";
  try {
    const status = await ensureAwsCredentials({ forceLogin: force });
    if (!status.ok) {
      return NextResponse.json(status, { status: 503 });
    }
    return NextResponse.json(status);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return NextResponse.json(
      {
        ok: false,
        profile: process.env.AWS_PROFILE || "default",
        region: process.env.AWS_REGION || "eu-central-1",
        error: message,
      },
      { status: 503 }
    );
  }
}

/** Force an SSO login refresh (opens browser if needed). */
export async function POST() {
  try {
    const status = await ensureAwsCredentials({ forceLogin: true });
    if (!status.ok) {
      return NextResponse.json(status, { status: 503 });
    }
    return NextResponse.json(status);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return NextResponse.json(
      {
        ok: false,
        profile: process.env.AWS_PROFILE || "default",
        region: process.env.AWS_REGION || "eu-central-1",
        error: message,
      },
      { status: 503 }
    );
  }
}
