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
| `GOOGLE_ADS_CUSTOMER_ID` | The account being reported on | ten digits, dashes stripped |

`GOOGLE_ADS_DEVELOPER_TOKEN` is **not** needed. If one is supplied it is stored
and sent, and it changes nothing.

The account id is the one still outstanding: the manager account may hold more
than one, and the connector reports on exactly one per connection. Confirm which
account is in scope for the engagement.

### The OAuth client must be a **Desktop app**

Cloud Console → APIs & Services → Credentials → Create credentials → OAuth
client ID → Application type: **Desktop app**. A Web application client refuses
the loopback redirect the token script uses, and fails with
`redirect_uri_mismatch`.

The Cloud project also needs the **Google Ads API** enabled, and it is that
project whose access level governs the connection.

### Generating the refresh token

On a machine with a browser, signed in as a user with access to the manager
account:

```bash
GOOGLE_ADS_CLIENT_ID=... GOOGLE_ADS_CLIENT_SECRET=... \
  pnpm --filter @zeeraa/connectors google-ads-token
```

It opens a local listener, prints a URL, and prints the refresh token once you
consent. Three settings in it are load-bearing and each fails differently:
`access_type=offline` (or there is nothing to store), `prompt=consent` (or a
*second* authorisation silently returns no refresh token at all), and the
`adwords` scope.

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
