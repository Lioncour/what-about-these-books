import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  output: "standalone",
  outputFileTracingExcludes: {
    "*": ["./dist/**", "./.git/**"],
  },
  serverExternalPackages: ["epub2", "vectra"],
  turbopack: {
    root: __dirname,
  },
};

export default nextConfig;
