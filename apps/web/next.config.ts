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
  // `next dev` otherwise writes AGENTS.md and CLAUDE.md into apps/web on every
  // run. A CLAUDE.md appearing in a subdirectory is picked up as instructions by
  // anything reading this repo, so it is not a file this project wants written
  // by a build tool. The guidance in it is about Next's own version; read it
  // from node_modules/next/dist/docs/ when it is needed.
  agentRules: false,
};

export default config;
