import type { NextConfig } from 'next';

const config: NextConfig = {
  // The workspace packages ship TypeScript source rather than a build step.
  transpilePackages: ['@zeeraa/core', '@zeeraa/db', '@zeeraa/connectors', '@zeeraa/jobs'],
  experimental: {
    // `postgres` opens sockets; it must not be bundled into the edge runtime.
    serverActions: { bodySizeLimit: '2mb' },
  },
  serverExternalPackages: ['postgres'],
  typedRoutes: false,
};

export default config;
