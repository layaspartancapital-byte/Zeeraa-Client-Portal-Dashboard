import { serve } from 'inngest/next';
import { functions, inngest } from '@zeeraa/jobs';

/**
 * The Inngest endpoint.
 *
 * Inngest calls back into this route to execute each step, which is what makes
 * a long ingestion durable across the platform's request timeout: every step is
 * its own short request, and the orchestration lives outside them.
 */
// The signing key is read from INNGEST_SIGNING_KEY by the client itself; it is
// not passed here, so there is one place it can be wrong rather than two.
export const { GET, POST, PUT } = serve({ client: inngest, functions });

export const runtime = 'nodejs';
export const maxDuration = 300;
