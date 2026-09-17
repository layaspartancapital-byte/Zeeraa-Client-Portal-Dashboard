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
 *
 * Running inside a container or a Codespace: the listener is on the container's
 * loopback, and the browser is on your machine, so the callback may never
 * arrive. That is not a failure mode worth engineering around, because the
 * authorisation code is sitting in the browser's address bar either way — so
 * this races the listener against a paste. Whichever arrives first wins, and
 * you do not have to know in advance which one will work.
 *
 * `GOOGLE_ADS_OAUTH_PORT` pins the port, for when loopback forwarding is set up
 * and a predictable port makes it easier to forward.
 */
import { createServer } from 'node:http';
import { randomBytes, createHash } from 'node:crypto';
import { once } from 'node:events';
import { createInterface } from 'node:readline';
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

/**
 * The same authorisation code, arriving by hand.
 *
 * Accepts the whole redirect URL or a bare code. A pasted URL still carries the
 * `state` parameter, so it is checked exactly as the callback is; a bare code
 * cannot be checked, which is noted rather than silently skipped.
 */
function pastedRedirect(): Promise<Callback> {
  return new Promise<Callback>((resolve) => {
    if (!process.stdin.isTTY) return; // Non-interactive: listener only.
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    rl.setPrompt('Paste the redirect URL (or the code): ');
    rl.prompt();

    rl.on('line', (line) => {
      const text = line.trim();
      if (!text) {
        rl.prompt();
        return;
      }

      if (text.includes('code=')) {
        let url: URL;
        try {
          url = new URL(text);
        } catch {
          console.error('That does not parse as a URL. Paste the whole address.');
          rl.prompt();
          return;
        }
        if (url.searchParams.get('state') !== state) {
          console.error('State mismatch — that URL is from a different run. Start again.');
          rl.prompt();
          return;
        }
        const code = url.searchParams.get('code');
        if (!code) {
          console.error('No code in that URL.');
          rl.prompt();
          return;
        }
        rl.close();
        resolve({ code });
        return;
      }

      // A bare code, not a URL. Google's look like `4/0AY0e-g7...`, so anything
      // else is a stray line or a half-copied paste. Accepting it would spend
      // the one-shot code on a doomed exchange and report `invalid_grant`,
      // which reads as a credential problem rather than as a typo.
      if (!/^4\/[A-Za-z0-9_-]{10,}$/.test(text)) {
        console.error(
          'That is neither a redirect URL nor an authorisation code. Paste the ' +
            'whole address from the browser, starting with http://localhost:.',
        );
        rl.prompt();
        return;
      }
      console.log('Treating that as a bare authorisation code (state not verifiable).');
      rl.close();
      resolve({ code: text });
    });
  });
}

const requestedPort = Number(process.env.GOOGLE_ADS_OAUTH_PORT ?? 0);
server.listen(requestedPort, '127.0.0.1');
await once(server, 'listening');
const { port } = server.address() as AddressInfo;
// Must be a loopback address: Google accepts `http://localhost:<any port>` for
// a Desktop client and rejects anything else, including a forwarded
// `*.app.github.dev` URL, which is not loopback however convenient it looks.
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

console.log('Before you start: check the OAuth consent screen\u2019s publishing status');
console.log('in Cloud Console (APIs & Services \u2192 OAuth consent screen).\n');
console.log('  If it says "Testing" and the user type is External, the refresh token');
console.log('  you are about to generate EXPIRES IN SEVEN DAYS. Publishing the app');
console.log('  ("In production") or setting the user type to Internal removes that');
console.log('  limit. Generating a token first and publishing afterwards does not');
console.log('  extend the token already issued \u2014 you would have to run this again.\n');

console.log('Step 1. Open this in a browser, signed in as a user with access to');
console.log('the manager account:\n');
console.log(`  ${authUrl}\n`);
console.log('Step 2. Approve the consent screen.\n');
console.log(`Step 3. The browser is sent to ${redirectUri}?code=...`);
console.log('        If this process can see that callback, it completes on its own.');
console.log('        If the browser instead shows "unable to connect" — which is what');
console.log('        happens when it runs on a different machine from this process,');
console.log('        such as a Codespace — that page is not an error. The code is in');
console.log('        the address bar. Copy the whole URL and paste it below.\n');

if (process.env.CODESPACES === 'true') {
  console.log('Detected a Codespace, so the paste route is the likely one: the');
  console.log('listener is on the container\u2019s loopback and your browser is not.\n');
}

console.log('Waiting for the callback, or for a pasted URL. Ctrl-C to abort.\n');

const result = await Promise.race([callback, pastedRedirect()]);
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
console.log('\nIf the consent screen is published ("In production") it does not expire');
console.log('on a schedule, but it is revoked if the granting user loses access to the');
console.log('account, if their password changes, if the app is removed from their');
console.log('Google account permissions, or if it goes unused for about six months.');
console.log('\nIf the consent screen is still in "Testing" with an External user type,');
console.log('this token expires seven days from now. Publish the app and run this');
console.log('again \u2014 publishing does not extend a token already issued.');
