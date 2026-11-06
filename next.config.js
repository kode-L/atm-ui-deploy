const path = require('path');
const { execSync } = require('child_process');

// Build info shown in the dashboard footer, so anyone can see exactly which code is deployed.
// From git when the build has the repo; otherwise from common CI variables; else "unknown".
const git = (cmd) => {
  try { return execSync(`git ${cmd}`, { cwd: __dirname, stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim(); } catch { return ''; }
};
const commit = git('rev-parse --short HEAD') || (process.env.VERCEL_GIT_COMMIT_SHA || process.env.GITHUB_SHA || process.env.CI_COMMIT_SHA || '').slice(0, 7) || 'unknown';
const buildInfo = {
  NEXT_PUBLIC_BUILD_COMMIT: commit,
  NEXT_PUBLIC_BUILD_BRANCH: git('rev-parse --abbrev-ref HEAD') || process.env.VERCEL_GIT_COMMIT_REF || process.env.GITHUB_REF_NAME || process.env.CI_COMMIT_REF_NAME || '',
  NEXT_PUBLIC_BUILD_COMMIT_TIME: git('log -1 --format=%ct') || '',
  NEXT_PUBLIC_BUILD_DIRTY: git('status --porcelain') ? '1' : '',
  NEXT_PUBLIC_BUILD_TIME: String(Math.floor(Date.now() / 1000)),
};

/** @type {import('next').NextConfig} */
const nextConfig = {
  env: buildInfo,
  distDir: process.env.NEXT_DIST_DIR || '.next',
  output: process.env.NEXT_OUTPUT_MODE,
  productionBrowserSourceMaps: false,
  experimental: {
    outputFileTracingRoot: path.join(__dirname, '../'),
  },
  eslint: {
    ignoreDuringBuilds: true,
  },
  typescript: {
    ignoreBuildErrors: false,
  },
  images: { unoptimized: true },
  webpack: (config, { isServer }) => {
    if (!isServer) {
      config.output.filename = 'static/chunks/[name]-[contenthash:8].js';
      config.output.chunkFilename = 'static/chunks/[contenthash:16].js';
    }
    return config;
  },
};

module.exports = nextConfig;
