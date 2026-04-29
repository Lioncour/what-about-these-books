import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  serverExternalPackages: ["epub2", "vectra"],
  turbopack: {
    root: __dirname,
  },
};

export default nextConfig;
