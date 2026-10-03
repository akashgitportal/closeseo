# Google Search Console and Google Analytics

CloseSEO reads **your own** Search Console and Analytics 4 data through Google's official APIs, read-only.
It never writes to Google and stores nothing but encrypted access/refresh tokens and which property each project uses.

Everything here is optional. Without it the 12 Google tools return a clear "not configured / not connected" result.

## 1) Create a Google Cloud OAuth client (about 10 minutes, free)

1. Open <https://console.cloud.google.com/>, create or pick a project.
2. **APIs & Services → Library**: enable **Google Search Console API**, **Google Analytics Data API** and **Google Analytics Admin API**.
3. **OAuth consent screen**: choose *External*, fill in the app name and your email. Leave it in **Testing** and add every Google
   account that will connect as a **test user** (otherwise Google answers `access_denied`). Testing mode needs no verification.
4. **Credentials → Create credentials → OAuth client ID → Web application**. Add these **Authorized redirect URIs**, exactly
   (scheme, host and port must match how you open CloseSEO, no trailing slash):

   | Where you run CloseSEO | Redirect URIs |
   |---|---|
   | Your computer | `http://localhost:3001/api/gsc/oauth/callback` and `http://localhost:3001/api/ga4/oauth/callback` |
   | A server | `https://your-domain/api/gsc/oauth/callback` and `https://your-domain/api/ga4/oauth/callback` |

5. Copy the **Client ID** and **Client secret**.

## 2) Configure CloseSEO

```sh
GOOGLE_CLIENT_ID=...apps.googleusercontent.com
GOOGLE_CLIENT_SECRET=...
CLOSESEO_SECRET=$(openssl rand -hex 32)      # at least 32 characters; encrypts stored tokens
PUBLIC_URL=http://localhost:3001             # must match the redirect URIs above
```

Keep `CLOSESEO_SECRET` stable: tokens encrypted with one secret cannot be read with another (you would just reconnect).
Restart CloseSEO, open a project → **Integrations**, press **Connect a Google account**, approve, then pick the property.
Open the app at the same address as `PUBLIC_URL` (use `localhost`, not `127.0.0.1`, if you registered `localhost`).

## What it does

| Tool | Source |
|---|---|
| `get_search_console_performance`, `inspect_urls` | Search Console API (performance, URL inspection) |
| `get_google_analytics_*` (landing pages, page performance, key events, traffic acquisition, ecommerce, site search, audience), `…_organic_overview`, `…_measurement_health` | Analytics Data and Admin APIs |
| `get_search_opportunities` | Both: pages ranking 4-20 in Search Console joined to Analytics landing pages and scored |

Access tokens are refreshed automatically. If Google revokes access the tools say "reconnect" and link to the Integrations page.

## Security notes

* Scopes are read-only: `webmasters.readonly` and `analytics.readonly`, plus `openid email profile` to show which account connected.
* Sign-in uses PKCE (S256) and a single-use, 10-minute state tied to the project and provider; replayed or forged callbacks are refused.
* Tokens are encrypted at rest with AES-256-GCM (key derived from `CLOSESEO_SECRET`) and never returned by any API.
* In `AUTH_MODE=api_key` the two OAuth callback URLs are public (Google cannot send your bearer token); the state is their credential.
* Anyone who can use the CloseSEO API can use every connected Google account's data for the projects it is attached to. Do not connect an
  account you would not share with every user of the server.
