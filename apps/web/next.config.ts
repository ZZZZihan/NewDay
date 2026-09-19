import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  transpilePackages: ["@newday/core"],
  async rewrites() {
    const apiOrigin = process.env.NEWDAY_API_ORIGIN ?? "http://127.0.0.1:3001";
    return [
      { source: "/api/:path*", destination: `${apiOrigin}/api/:path*` },
    ];
  },
};

export default nextConfig;
