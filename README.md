# Meta Bulk Builder

Turns a Meta (Facebook and Instagram) campaign structure doc into one file you can bulk import into Ads Manager. Load the doc, check what the tool found, fix anything it flags, and download the .xlsx.

It is the Meta counterpart of the Campaign Bulk Builder for Google Ads, and it reads the same kind of docs. In a doc that plans both Google and Meta, this tool reads only the Meta sections.

It runs entirely in the browser. Docs are never uploaded. The only time doc text leaves your computer is when you choose AI reading.

## Ways to use it

**Online.** Once GitHub Pages is switched on (see below), the tool lives at `https://xeeshan7342.github.io/MetaAds/`.

**On claude.ai, with your Claude plan.** Open the tool as a Claude artifact. AI reading then runs on your own Claude plan (Pro, Max or Team) with no API key and no API credit. Each person who opens it uses their own plan, and Claude asks once before the first read.

**Offline, by double-click.** Download `meta-builder.html` (linked at the bottom of the online tool, or build it with `npm run build`) and open it in Chrome, Edge, Firefox or Safari. Everything is inside that one file.

**From a copy of this repo.** Open `app/index.html` directly. It needs no server and no build step.

## What docs it understands

Word (.docx), Excel (.xlsx, every visible tab), CSV and TSV, text and Markdown. From Google Docs use File, Download, Microsoft Word (.docx). From Google Sheets use .xlsx. You can also paste text.

- Campaigns from a campaign table (`Campaign | Objective | Monthly Budget | Ad Sets`) or headings such as `Campaign 1: Intro Offer`. When the table lists ad sets, later headings are matched to them by name, so `Core Interest: Weight Management` lands on the ad set `Weight Management`.
- Ad sets as headings, bold lines (`Ad Set 2: Lookalike 1%`), table rows, spreadsheet rows, or a plain name line right before its targeting.
- Targeting: locations with radius (`Austin, TX + 15 mile radius`, `15 to 25 mile radius of Naperville, IL`, town lists that share one state), age, gender, interests, custom audiences, lookalikes, exclusions, placements (`Instagram Feed, Stories and Reels; Facebook Feed`), and free text such as `Audience Focus: Age 30 to 55, interests in weight loss, fitness`.
- Ad copy as lists, numbered lines (`Primary Text 2: ...`), `Option 1:` lines, one block per ad (`Ad 1 – Studio tour reel`), or an ad table (`Ad | Primary Text | Headline | CTA`). Primary text can run over several lines, with emoji. When an ad set lists several primary texts and headlines, the tool makes one ad per primary text and pairs the headlines in order.
- Every objective with the conversion locations Ads Manager offers for it:
  - **Awareness:** reach, impressions, ad recall lift, ThruPlay and 2-second video plays.
  - **Traffic:** website, app, message destinations, Instagram or Facebook profile, calls.
  - **Engagement:** on your ad (interactions, video views, event responses, reminders set), message destinations (Messenger, Instagram, WhatsApp), Instagram live video, calls, website, app, Instagram or Facebook (Page or profile visits).
  - **Leads:** website, instant forms, message destinations, calls, app.
  - **App promotion:** app installs and app events.
  - **Sales:** website, app, message destinations, calls.

  Write it the way you would say it (`Engagement – Video views`, `Engagement – Messages on WhatsApp`, `Leads (Instant Form)`, `Traffic to Instagram profile`, `App installs`). Each ad set's performance goal list matches what Ads Manager shows for that choice, in the same wording.
- Campaign settings: budgets (daily, monthly, weekly or lifetime, at campaign or ad set level, in any currency format), special ad category, bid strategy (`Cost cap $25`), conversion event, start and end dates, Page, pixel and lead form IDs, and UTM parameters.
- Shared targeting written once for the whole account, or for one campaign, applies to every ad set that does not set its own.
- Docs written as settings tables, one section per level (`Campaign level settings`, `Ad set level settings`, `Ad level settings`). A `Level | Name | Purpose` table names the campaign, ad set and ads, and the settings sections below it fill them in. Placement tables with a Keep/Remove column keep only the rows marked Keep, and lines such as `Facebook only. Instagram and Audience Network unchecked` leave the unchecked platforms out.
- Ads built from an existing Page or Instagram post (`Ad setup: Use existing post`, `ExistingPost` in the ad name). They need no copy in the doc.
- Blanks such as `[Client Page name]` or `[date]` are listed once at the top instead of being read as values, and a note in brackets is treated as advice: `None (select one only if the Page covers housing…)` means no special ad category.
- Answers copied from ChatGPT or Claude (icons, bold labels, `---` rules).

Sections for Google, Microsoft, LinkedIn, TikTok and other platforms are skipped as one unit. Keyword lists, notes, KPIs, metrics, optimisation plans, testing plans and launch checklists are not imported. Every line the tool could not place is listed in the import report with the reason.

## The import report and memory

For each line in the import report you can:

- **Add it** as primary text, a headline, a description, an interest, a custom audience or an exclusion to the right ad set.
- **Teach the tool** what lines like it mean, for example that "Hook lines" is a primary text label or that a heading is an ad set name. The doc is read again straight away, and the lesson applies to every doc you load afterwards.

Taught labels, saved **client profiles** (Page ID, pixel ID, lead form ID, website, UTM parameters, default call to action, locations, age and gender) and your Ads Manager template are kept in this browser. Use **Export memory** to save them to a file and **Import memory** on another computer or for a teammate. A profile loads by itself when a doc's website matches it. A new doc never inherits the previous client's settings.

## AI reading

For docs the rules can't follow, open **AI reading**. Claude reads the whole doc and returns the structure as JSON. The result goes through the same model, checks and export as the rule-based read, and anything Claude could not place shows up in the import report. **Back to the rule-based read** switches back. There are three ways to run it:

1. **With your Claude plan.** Shown when the tool is open as a Claude artifact on claude.ai. Uses your Pro, Max or Team plan. No key, no credit. Pick Balanced, or Most capable for messy docs.
2. **With a Claude chat (any plan, including free).** Click **Copy prompt**, paste it into a new chat at claude.ai, copy Claude's whole reply, paste it back and click **Use this reply**. The prompt carries the rules, the exact JSON shape and the doc.
3. **With an API key.** Billed as Anthropic API credit, which is separate from a Claude plan. Models: Claude Opus 5.5 (most accurate), Claude Sonnet 5.5 (faster) and Claude Haiku 4.5 (cheapest, roughly a quarter of the Opus cost). The tool shows the token use and cost after each read. The key is only kept while the page is open unless you tick **Remember on this device**.

A Claude Pro plan does not include API credit, so route 1 or 2 is the way to use AI reading without buying credit.

## Checks before export

Export is blocked until errors are fixed. Errors cover what Ads Manager would reject: a missing Page ID, a missing pixel on conversion ad sets, a missing lead form on instant form ads, campaigns without an objective or budget, lifetime budgets without an end date, ad sets without a location, ages outside 13 to 65, special ad categories with age or gender targeting or a radius under 15 miles, ads without primary text or a valid URL, bid caps without an amount, duplicate campaign or ad set names, and cities from more than one country in one ad set.

Warnings don't block export: primary text over 125 characters, headlines over 40, descriptions over 30 (Meta's guidance for Feed), cities that Ads Manager matches by name, budgets the doc gave without saying daily or monthly, and anything that has to be finished after import.

## The after-import list

The import file cannot carry everything. Interests, custom audiences, lookalikes and exclusions need Meta's own audience IDs, and images and videos have to be in the account's media library. Some settings are also safer to set by hand, based on test imports:

- **Bid strategy.** Ads Manager rejected the bid strategy column on import, so the file leaves it at the default (Highest volume). A cost cap, bid cap or ROAS goal from the doc goes on the list with its amount.
- **Cities.** Ads Manager can fail to match a city name, and then the ad set keeps only the country. Every city goes on the list so you can check it.
- **Videos.** A video ad without a video ID is rejected as "Missing video", so it imports as a link ad and the video goes on the list.
- **Existing posts.** The import file cannot point an ad at a Page post, so these ads are left out of the file (their ad set still imports) and listed by name, with what the doc says about each post. In Ads Manager, add the ad, choose **Use existing post** under Ad setup and pick the post.
- **Settings with no import column.** Advantage+ audience, Advantage+ creative enhancements, multi-advertiser ads, text translation, brand safety, A/B tests and similar settings from the doc are listed so you can set them by hand.
- **Events and lives.** Event response, reminder and Instagram live ads need the event or live picked in Ads Manager. The tool keeps these on an **After import** list per ad set, with every interest and audience name from the doc, so nothing gets lost. Download or copy it, and work through it before turning ads on. If you already have an image hash or video ID from the media library, paste it on the ad and it goes into the file.

## Importing into Ads Manager

1. In Ads Manager, open the **Import and export** menu above the table and choose **Import ads in bulk**.
2. Pick the .xlsx (or CSV). Ads Manager checks every row and lists anything it cannot read.
3. Fix or skip flagged rows, then **Import**. Everything arrives paused unless you chose Active.
4. Work through the after-import list.
5. Check one ad set's locations and one ad's preview, then publish.

If Ads Manager says **Not allowed to publish imported ads** (error #3738001), the restriction is on the ad account, not in the file. Meta allows publishing imported ads only after the account has run ads that follow its policies for several weeks, so a new account cannot publish an import yet. The ad set error that comes with it ("there's an error with the campaign it's associated with") is only a knock-on from the campaign. Until the account qualifies, build campaigns by hand in Ads Manager with the values from the tool. Ads run that way also count toward the weeks Meta asks for.

Call ads take the phone number from Account defaults (or the campaign), and app ads take the App Store or Google Play link and app ID. Those fields appear once a campaign needs them.

The file uses Ads Manager's import column names (`Campaign Objective`, `Ad Set Run Status`, `Body`, `Title`, `Link Object ID` and so on) with one row per ad. Meta changes its template from time to time, so for a new ad account either import one campaign first, or download the blank template from Ads Manager's import screen and load it under **Your Ads Manager template**. The export then uses that template's exact column names and order, and the tool tells you about any data the template has no column for.

## Development

```bash
npm install        # dev tools: jsdom, jszip, mammoth, the Anthropic SDK, esbuild
npm test           # node:test suite in tests/
npm run build      # writes dist/meta-builder.html
npm run build:artifact  # writes dist/meta-builder-artifact.html, the page published as a Claude artifact
npm run vendor     # refreshes app/vendor/ after a dependency upgrade
```

The app is plain JavaScript with no build step. Files in `app/js`:

| File | What it does |
|---|---|
| `engine.js` | Reads blocks (headings, paragraphs, lists, tables) into campaigns, ad sets and ads, validates, and writes the Ads Manager rows and the after-import list. Runs in Node for the tests. |
| `readers.js` | Turns .docx, .xlsx, CSV and text files into blocks, writes the .xlsx export and reads a template's header row. |
| `memory.js` | Taught labels, client profiles and the saved template, stored in the browser, with export and import. |
| `ai.js` | AI reading: the Claude plan route, the copy and paste prompt, the API request and schema, and conversion to the engine's format. |
| `app.js` | The page. |
| `sample.js` | The made-up sample doc. |

`app/vendor` holds mammoth (Word), JSZip (Excel) and a bundled copy of the Anthropic SDK, so the tool works offline and loads nothing from a CDN except fonts. Versions are in `app/vendor/VERSIONS.txt`.

Never commit real client documents to this repository. It is public.

## Deploying to GitHub Pages

The workflow in `.github/workflows/pages.yml` runs the tests on every push and pull request, and deploys the site from the repository's default branch. To switch it on once: in the repository go to **Settings > Pages** and set **Source** to **GitHub Actions**, then re-run the workflow (Actions tab) or push again. The tool is then live at `https://xeeshan7342.github.io/MetaAds/`, with the offline file at `/meta-builder.html`.
