import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  output: "standalone",
  outputFileTracingExcludes: {
    // Reads that start at the project root make Next trace the whole project into the
    // standalone output. None of this is needed at run time, and env files must not ship
    // (scripts/prepare-standalone.mjs enforces that too).
    "*": [
      "./dist/**",
      "./.git/**",
      "./.env*",
      "./.claude/**",
      "./.github/**",
      "./src/**",
      "./tests/**",
      "./docs/**",
      "./scripts/**",
      "./electron/**",
      "./eval/**",
      "./*.md",
      "./*.tsbuildinfo",
      // Build-time only. sharp serves next/image, which this app does not use (see
      // `images` below); the prepare script removes these too if the trace keeps them.
      "./node_modules/typescript/**",
      "./node_modules/@types/**",
      "./node_modules/sharp/**",
      "./node_modules/@img/**",
    ],
  },
  // Covers are local files served by our own API; nothing goes through the image
  // optimiser, so the installer does not carry sharp. Keep this if next/image is ever used.
  images: { unoptimized: true },
  serverExternalPackages: ["epub2", "vectra"],
  turbopack: {
    root: __dirname,
  },
};

export default nextConfig;
