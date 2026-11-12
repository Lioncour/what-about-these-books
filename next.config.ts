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
    ],
  },
  serverExternalPackages: ["epub2", "vectra"],
  turbopack: {
    root: __dirname,
  },
};

export default nextConfig;
