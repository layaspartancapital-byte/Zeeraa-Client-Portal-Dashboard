/**
 * One-shot: turn a Desktop-app OAuth client into a Google Ads refresh token.
 *
 *   GOOGLE_ADS_CLIENT_ID=... GOOGLE_ADS_CLIENT_SECRET=... \
 *     pnpm --filter @zeeraa/connectors google-ads-token
 *
 * Run it once, on a machine with a browser. It prints a refresh token, which
 * goes into a secret — never into the repository, a commit message, or a chat.
 *
 * Why loopback rather than a hosted callback: a Desktop-app client may redirect
 * to `http://localhost`, so this needs no deployed URL and no allow-listing
 * beyond the client itself. Google removed the out-of-band (`urn:ietf:wg:oauth:
 * 2.0:oob`) flow in 2022, so copy-the-code-from-the-browser is no longer an
 * option and a local listener is the supported path.
 *
 * Three settings are load-bearing and each one fails differently:
 *
 *   `access_type=offline`  — without it Google returns an access token only,
 *                            and there is nothing to store.
 *   `prompt=consent`       — without it a *re-authorisation* returns no refresh
 *                            token at all. Google issues one on first consent
 *                            and then stops, so the second run of this script
 *                            silently produces a token-less response. This is
 *                            the single most common way to get stuck here.
 *   `scope=.../adwords`    — the Google Ads API scope. Not the analytics one.
 */
import { createServer } from 'node:http';
import { randomBytes, createHash } from 'node:crypto';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';

const SCOPE = 'https://www.googleapis.com/auth/adwords';
const AUTH_ENDPOINT = 'https://accounts.google.com/o/oauth2/v2/auth';
const TOKEN_ENDPOINT = 'https://oauth2.googleapis.com/token';

const clientId = process.env.GOOGLE_ADS_CLIENT_ID;
const clientSecret = process.env.GOOGLE_ADS_CLIENT_SECRET;

if (!clientId || !clientSecret) {
  console.error('Set GOOGLE_ADS_CLIENT_ID and GOOGLE_ADS_CLIENT_SECRET first.\n');
  console.error('Both come from a Google Cloud project with the Google Ads API');
  console.error('enabled: APIs & Services → Credentials → Create credentials →');
  console.error('OAuth client ID → Application type: Desktop app.\n');
  console.error('Pick Desktop app specifically. A Web application client refuses');
  console.error('the loopback redirect this script uses.');
  process.exit(2);
}

// PKCE. Not strictly required for a confidential client, but it costs three
// lines and removes the authorisation-code interception this flow is otherwise
// open to on a shared machine.
const verifier = randomBytes(32).toString('base64url');
const challenge = createHash('sha256').update(verifier).digest('base64url');
// Binds the callback to this run, so a stray request to the listener cannot
// inject a code from somebody else's consent.
const state = randomBytes(16).toString('base64url');

type Callback = { code?: string; error?: string };
let resolveCallback: (value: Callback) => void;
const callback = new Promise<Callback>((resolve) => {
  resolveCallback = resolve;
});

const server = createServer((req, res) => {
  const url = new URL(req.url ?? '/', 'http://localhost');
  if (url.pathname !== '/') {
    res.writeHead(404).end();
    return;
  }

  const received = url.searchParams.get('state');
  const error = url.searchParams.get('error');
  const code = url.searchParams.get('code');

  const reply = (status: number, message: string) => {
    res.writeHead(status, { 'content-type': 'text/plain; charset=utf-8' });
    res.end(`${message}\n`);
  };

  if (received !== state) {
    reply(400, 'State mismatch. Ignoring this callback — start the script again.');
    return;
  }
  if (error) {
    reply(400, `Authorisation failed: ${error}. You can close this tab.`);
    resolveCallback({ error });
    return;
  }
  if (!code) {
    reply(400, 'No authorisation code in the callback.');
    resolveCallback({ error: 'no code in callback' });
    return;
  }

  reply(200, 'Authorised. Close this tab and return to the terminal.');
  resolveCallback({ code });
});

server.listen(0, '127.0.0.1');
await once(server, 'listening');
const { port } = server.address() as AddressInfo;
const redirectUri = `http://localhost:${port}`;

const authUrl = new URL(AUTH_ENDPOINT);
authUrl.search = new URLSearchParams({
  client_id: clientId,
  redirect_uri: redirectUri,
  response_type: 'code',
  scope: SCOPE,
  access_type: 'offline',
  prompt: 'consent',
  code_challenge: challenge,
  code_challenge_method: 'S256',
  state,
}).toString();

console.log('Open this in a browser, signed in as a user with access to the');
console.log('manager account whose developer token you will use:\n');
console.log(`  ${authUrl}\n`);
console.log(`Listening on ${redirectUri} for the callback. Ctrl-C to abort.`);

const result = await callback;
server.close();

if (result.error || !result.code) {
  console.error(`\nNo authorisation code: ${result.error ?? 'unknown error'}`);
  process.exit(1);
}

const response = await fetch(TOKEN_ENDPOINT, {
  method: 'POST',
  headers: { 'content-type': 'application/x-www-form-urlencoded' },
  body: new URLSearchParams({
    client_id: clientId,
    client_secret: clientSecret,
    code: result.code,
    code_verifier: verifier,
    grant_type: 'authorization_code',
    redirect_uri: redirectUri,
  }),
});

const body = (await response.json()) as {
  refresh_token?: string;
  access_token?: string;
  expires_in?: number;
  scope?: string;
  error?: string;
  error_description?: string;
};

if (!response.ok) {
  console.error(`\nToken exchange failed (${response.status}): ${body.error ?? ''}`);
  if (body.error_description) console.error(body.error_description);
  if (body.error === 'redirect_uri_mismatch') {
    console.error(
      '\nThis usually means the OAuth client is a Web application rather than a ' +
        'Desktop app. Desktop clients accept any loopback port; Web clients do not.',
    );
  }
  process.exit(1);
}

if (!body.refresh_token) {
  console.error('\nGoogle returned an access token but no refresh token.\n');
  console.error('This happens when the account has already consented to this');
  console.error('client and `prompt=consent` was not honoured. Revoke the app at');
  console.error('https://myaccount.google.com/permissions and run this again.');
  process.exit(1);
}

console.log('\nRefresh token:\n');
console.log(`  ${body.refresh_token}\n`);
console.log(`Granted scope: ${body.scope ?? '(not reported)'}`);
console.log(
  `Access token acquired too, expiring in ${body.expires_in ?? '?'}s — ignore it, ` +
    'the connector mints its own.',
);
console.log('\nPut the refresh token in the GOOGLE_ADS_REFRESH_TOKEN secret.');
console.log('It does not expire on a schedule, but it is revoked if the granting');
console.log('user loses access to the account, if their password changes, or if');
console.log('the app is removed from their Google account permissions.');
