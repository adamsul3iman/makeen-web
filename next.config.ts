import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  output: "export",
  images: { unoptimized: true },
  trailingSlash: true,
  devIndicators: false,
  typescript: { ignoreBuildErrors: true },
};

export default nextConfig;
