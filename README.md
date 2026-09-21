# JRNEE Website Hub

Private back office for client website analytics. Runs on Render as a Web Service.

## Render environment variables

| Key | What it is |
|---|---|
| `ADMIN_PASSWORD` | The password you sign in with |
| `SESSION_SECRET` | Any long random string |
| `GOOGLE_SERVICE_ACCOUNT` | The full contents of the Google service-account JSON key |
| `NETLIFY_TOKEN` | Netlify personal access token |

Never commit the Google key file or any of these values to GitHub.

## Adding a client

1. **Google Analytics** — Admin → Property access management → add the hub's
   service-account email as **Viewer**. Copy the **Property ID** from Admin → Property details.
2. **Search Console** — Settings → Users and permissions → add the same email (**Restricted** is fine).
   - Domain property → use `sc-domain:example.com`
   - URL-prefix property → use `https://example.com/` (with the trailing slash)
3. **Netlify** — Site configuration → General → Site details → copy the **Site ID**.
4. Add an entry to `clients.json` and commit:

```json
{
  "id": "short-id-no-spaces",
  "name": "Client Name",
  "legal": "Client Legal Name, LLC",
  "domain": "example.com",
  "initials": "CN",
  "status": "Live",
  "ga4PropertyId": "123456789",
  "gscSiteUrl": "sc-domain:example.com",
  "netlifySiteId": "abcd1234-..."
}
```

Any of the three IDs can be left as `""` — that section just shows as not connected.

## Notes

- Numbers are cached for 10 minutes. Use **Refresh** to pull fresh ones.
- Search Console data runs 2–3 days behind; the report accounts for that.
- **Present** hides admin controls and any unconnected sections. Esc exits.
- The hub reads data, it doesn't create it: the client site needs the GA4 tag installed,
  and its forms need to be Netlify Forms for leads to appear.
