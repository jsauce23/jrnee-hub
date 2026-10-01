# JRNEE Website Hub

Private back office for client website analytics. Runs on Render as a Web Service.

## Render environment variables

| Key | What it is |
|---|---|
| `ADMIN_PASSWORD` | Your JRNEE password — the only one that opens the full client list |
| `CLIENT_PASSWORDS` | One password per client: `marco:Marco1234, nextclient:TheirPass` |
| `SESSION_SECRET` | Any long random string |
| `GOOGLE_SERVICE_ACCOUNT` | The full contents of the Google service-account JSON key |
| `NETLIFY_TOKEN` | Netlify personal access token |
| `GHL_TOKENS` | GoHighLevel tokens for clients on that platform: `clientid:pit-xxxxxxxx` |
| `API_KEYS` | Read-only API keys, one per client (see below). Leave unset if nobody needs the API |
| `DATA_DIR` | Where reports are stored. Set to `/var/data` and attach a Render disk at that path |

Never commit the Google key file or any of these values to GitHub.

## How sign-in works

- Your admin password opens **My Dashboard**: totals across all clients, alerts, a combined lead inbox
  and a setup checklist. The **Clients** tab lists every client; open any report and use **Present**.
- A client's password takes them straight to **their own report** and nothing else. The server
  enforces this — they can't reach the client list or another client's report even by editing the URL.
- Every password must be different. Commas aren't allowed inside a password.
- Remove a client from `CLIENT_PASSWORDS` and anyone logged in as them is signed out immediately.

## Reports

Reports are saved as files under `DATA_DIR`. **On Render you must attach a disk**, or every
deploy wipes them:

1. Render -> jrnee-hub -> **Disks** -> **Add Disk**
2. Name `hub-data`, mount path `/var/data`, size 1 GB
3. **Environment** -> add `DATA_DIR` = `/var/data`

Building one: **Reports** tab -> pick a client -> **New report** -> choose the period ->
**Pull the numbers**. Paste what you did and what's next, hit **Build the report**, edit any
text in place, then **Save draft** or **Publish to client**.

Nothing reaches the client until you hit **Publish**. Before that it's a draft only you can see,
and **Delete draft** removes it (also available as the x on any draft in the list).

- **Download** saves a standalone `.html` file of the report — opens in any browser, keeps the
  charts and colours, works offline. Good for emailing or filing.
- **Print / Save as PDF** opens the browser's print dialog, where "Save as PDF" gives you a PDF.

Clients get both buttons on their own copy.

Clients only ever see published reports, under their own **Reports** tab. Unpublishing hides
a report again immediately.

Periods available: last month, this month so far, last 30 days, last 90 days, or custom dates.
Every period is compared against the same number of days immediately before it.

## Clients on GoHighLevel

Instead of a Netlify site ID, give them a location ID:

```json
"ghlLocationId": "DFvqy4IoiWRyMxqjSeJu",
"ghlSource": "",
"ghlTags": []
```

Then add their private integration token in Render: `GHL_TOKENS` = `clientid:pit-xxxxxxxx`.
Get the token from their sub-account under Settings -> Private Integrations, with read access
to contacts.

GoHighLevel contacts are not the same as website enquiries — imports, manual adds and
missed-call text-backs all create contacts. If their account is mixed, narrow it:

- `"ghlSource": "website"` — only contacts whose source mentions that word
- `"ghlTags": ["web-lead"]` — only contacts carrying one of these tags

Leave both empty to count every new contact.

## Ask JRNEE

It sits in two places: under every section of a monthly report, **and** under every section of
their live dashboard. On the dashboard it answers from whatever period they're looking at
(7, 28 or 90 days), using the same figures on screen.

Under every section the client sees **"Have a question about this? Ask JRNEE"**.
It opens in place, offers three questions written for that section, and they can type their own.

Every question and answer is kept, whether it came from a report or the dashboard.
**Questions** tab -> a row per client per report ("Marco had 3 questions about the August report",
or "Dashboard - October 2026" for ones asked on the live dashboard) -> open it for the full back-and-forth.
Unread ones carry a blue dot; flagged ones are tinted and listed first.

Two things are never answered and always come to you instead:

- anything about billing, scope, pricing or "am I getting my money's worth"
- anything legal

Pointed questions — results down over more than one period, frustration, talk of cancelling —
are answered from the data *and* flagged, so you see them before the email arrives.

### Turning on AI answers

Add `ANTHROPIC_API_KEY` in Render -> Environment. That's the only required step. Optionally set
`ASK_MODEL` (defaults to `claude-sonnet-5`; `claude-haiku-4-5` is cheaper and faster).

With a key set, questions go to the model with the whole report as context, and it can follow a
conversation across several questions. Without one — or if the API call fails — answers fall back
to the figures, so the feature never breaks.

What the model is **not** allowed to do, enforced in code before the call is made:

- billing, pricing, scope or value questions never reach it; they route to you
- legal questions never reach it; they route to you

Its instructions: talk like an expert who enjoys explaining things, three to five sentences,
plain language. Lead with the number, give the honest reason, and **always close with what Joel
and the team are doing about it** — taken from the plans already in the report, so it's real work
rather than reassurance.

It may reason about likely causes (seasonal demand, a competitor moving, a page slipping) as long
as it flags them as likely and the figures fit. It never invents a number, never promises results,
never claims our work caused an improvement, and never criticises JRNEE or the client. It also
won't hide a cause that's visible in the figures — it states it neutrally and goes straight to the
plan.

There is a quiet cap of 60 questions per client per hour. If it trips, the client still gets a
real answer from the figures — they never see a limit or an error.

## Giving a client API access

Only set this up for clients who ask for it.

1. Make a long random key, e.g. `jrnee_live_` plus 32 random characters.
2. In Render -> **Environment**, add or edit `API_KEYS`:
   - `marco:jrnee_live_xxxxx` - numbers only
   - `marco:jrnee_live_xxxxx:leads` - numbers plus lead names, emails, phones and messages
   - Separate multiple clients with commas.
3. Send them the key and the docs link: `https://your-hub-address/v1`

Keys are read-only, limited to 120 requests an hour, and can only ever return that client's
own data. Removing a key from `API_KEYS` switches it off immediately.

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

5. In Render → **Environment**, edit `CLIENT_PASSWORDS` and add `, theirid:TheirPassword` to the end.
   The id has to match the `"id"` in `clients.json` exactly.

## Notes

- Numbers are cached for 10 minutes. Use **Refresh** to pull fresh ones.
- Search Console data runs 2–3 days behind; the report accounts for that.
- **Present** hides admin controls and any unconnected sections. Esc exits.
- The hub reads data, it doesn't create it: the client site needs the GA4 tag installed,
  and its forms need to be Netlify Forms for leads to appear.
