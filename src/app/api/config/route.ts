import { NextResponse } from "next/server";

export async function GET() {
  return NextResponse.json({
    publicMode: process.env.PUBLIC_MODE === "true",
  });
}
