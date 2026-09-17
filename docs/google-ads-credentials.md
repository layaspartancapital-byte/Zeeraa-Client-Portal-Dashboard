# Google Ads credentials

What phase 3 needs from the client, and in what form. Verified against Google's
live documentation on 17 September 2026 — the requirements changed eight days
earlier and most third-party guides are still wrong about them.

Everything here is **per tenant**. Spartan reaches their ad account through
their own manager account rather than a Zeeraa MCC, so the manager account, the
OAuth consent and the Cloud project that carries the API access level all belong
to the client. Another client may arrive under a different arrangement; nothing
in the connector assumes one agency-level account covers every tenant, and there
is no agency-level piece to hoist into an environment variable.

---

## The developer token is no longer required

Google **sunset developer tokens on 9 September 2026**. The header is now
optional and ignored by their servers, and existing code that still sends one
keeps working unchanged. The connector sends it only when a connection happens
to hold one.

Two consequences worth being explicit about:

1. **API access levels moved to the Google Cloud Console.** The level is a
   property of the Cloud project used to generate the OAuth credentials, not of
   a token. Apply for or check it on that project's **Google Ads API Overview**
   page in Cloud Console.
2. **The level shown in the Ads API Center may be wrong.** Google documents the
   API Center display as possibly inaccurate and says not to apply for access
   there. So "Basic Access, no approval wait" read off that page does not
   confirm the level the API will actually enforce — the Cloud project's page is
   the only authoritative answer.

The access levels, for reference. The one that matters to us is whether the
project is above **Test**, since a Test project can only query test accounts:

| Level | Production accounts | Test accounts |
| --- | --- | --- |
| Test | not permitted | 15,000 ops/day |
| Explorer | 2,880 ops/day | 15,000 ops/day |
| Basic | 15,000 ops/day | 15,000 ops/day |
| Standard | unlimited | unlimited |

Explorer is survivable but shapes the first backfill: 2,880 operations a day is
below a full 90-day click pull in one run, so it spreads over several nights.
The click-day ledger handles that without intervention.

---

## What I need

Four secrets and two ids. **Do not paste them into chat.** Put the secrets in
Codespaces secrets the way the Salesforce ones came through and I will encrypt
them into the connection row; the two ids are not secret and can go anywhere.

| Env var | What it is | Format |
| --- | --- | --- |
| `GOOGLE_ADS_CLIENT_ID` | OAuth client from the client's Cloud project | `<project-number>-<hash>.apps.googleusercontent.com` |
| `GOOGLE_ADS_CLIENT_SECRET` | Same OAuth client | `GOCSPX-…` |
| `GOOGLE_ADS_REFRESH_TOKEN` | Generated once, see below | `1//0…` |
| `GOOGLE_ADS_LOGIN_CUSTOMER_ID` | Spartan Capital MCC | `6962685494` — ten digits, dashes stripped |
| `GOOGLE_ADS_CUSTOMER_ID` | Spartan Business Solutions LLC | `4677473505` |

`GOOGLE_ADS_DEVELOPER_TOKEN` is **not** needed. If one is supplied it is stored
and sent, and it changes nothing.

Confirmed 17 September 2026: Cloud project `scg-ads-conversions`, **Basic**
access (15,000 operations a day, full API functionality), reporting on Spartan
Business Solutions LLC (`4677473505`) through the Spartan Capital MCC
(`6962685494`). Basic comfortably covers a 90-day click backfill in a single
run — 90 requests against a 15,000 ceiling.

A second account under the same manager would be a second connection row, not a
second value here: one connection reports on one account.

### Check the consent screen's publishing status first

Cloud Console → APIs & Services → **OAuth consent screen**.

If the publishing status is **Testing** and the user type is **External**, every
refresh token it issues **expires seven days after consent**. The integration
then dies a week after it starts working, with an `invalid_grant` that looks
exactly like a revoked grant and arrives long after anyone connects it to this
setting.

Set the app to **In production**, or to **Internal** if the granting Google
account is in the Workspace organisation that owns the project. Internal also
lifts the 100-test-user cap.

Publishing afterwards does **not** extend a token already issued — the token has
to be generated again. So this is a pre-flight check, not a cleanup task.

### The OAuth client must be a **Desktop app**

Cloud Console → APIs & Services → Credentials → Create credentials → OAuth
client ID → Application type: **Desktop app**. A Web application client refuses
the loopback redirect the token script uses, and fails with
`redirect_uri_mismatch`.

The Cloud project also needs the **Google Ads API** enabled, and it is that
project whose access level governs the connection.

### Generating the refresh token

```bash
pnpm --filter @zeeraa/connectors google-ads-token
```

Reads `GOOGLE_ADS_CLIENT_ID` and `GOOGLE_ADS_CLIENT_SECRET` from the
environment, prints a consent URL, and prints the refresh token once you
approve. Three settings in it are load-bearing and each fails differently:
`access_type=offline` (or there is nothing to store), `prompt=consent` (or a
*second* authorisation silently returns no refresh token at all), and the
`adwords` scope.

**Running it from a Codespace.** Google requires a loopback redirect for a
Desktop client, so `http://localhost:<port>` is the only address it will accept
— a forwarded `*.app.github.dev` URL is rejected, however convenient it looks.
The listener is on the container's loopback and your browser is not, so the
callback usually cannot reach it, and the browser lands on "unable to connect".

That page is not an error. The authorisation code is in the address bar. The
script races the listener against a paste, so copying the whole URL back into
the terminal completes it either way, and you do not have to know in advance
which route will work. `GOOGLE_ADS_OAUTH_PORT` pins the port if you do have
loopback forwarding set up and want it predictable.

### What the grant depends on

A refresh token is a person's consent, not a service identity. Google Ads does
not accept a service account except through Workspace domain-wide delegation,
which needs a Workspace domain the ad account generally is not behind. So the
connection breaks when the granting user loses access to the account, changes
their password, or removes the app from their Google permissions — and it
reports that as `waiting_on_client` rather than as a failure, because
re-consenting is the only fix and it is theirs to do.

Pick someone who will still have access in a year.

---

## Sources

- [Developer token](https://developers.google.com/google-ads/api/docs/api-policy/developer-token)
- [Cloud-managed access levels](https://developers.google.com/google-ads/api/docs/concepts/no-developer-token)
- [Access levels and permissible use](https://developers.google.com/google-ads/api/docs/api-policy/access-levels)
- [Authorization and HTTP headers](https://developers.google.com/google-ads/api/rest/auth)
- [Using OAuth 2.0 to access Google APIs — refresh token expiration](https://developers.google.com/identity/protocols/oauth2)
- [OAuth app state overview](https://developers.google.com/identity/protocols/oauth2/production-readiness/overview)
