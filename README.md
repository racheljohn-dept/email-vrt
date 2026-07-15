# Email Visual Regression Tester

An email visual regression testing project created to conduct visual checks for email builds, capturing how it renders across real email clients, and comparing each render against a saved baseline to catch layout regressions. A browser UI sits on top of the underlying Playwright test suite so the team can run tests, review diffs, and generate reports without touching the command line.

## Project structure

```
email-vrt/
  playwright.config.ts
  tests/blueprint.spec.ts
  src/                        # global-setup, EOA service, utils
  visual-baselines/           # saved baseline screenshots per task
  email-visual-tester-ui/     # web UI + server (this is what you run)
    server.js
    public/index.html
```

## Prerequisites

- Node.js 18+
- An Email on Acid account (API key + account password)
- An EOA test ID for the build you want to check (the token from your EOA preview URL)
- Jira Cloud account, if you want the "Create Jira ticket" feature (optional)

## 1. Clone

```bash
git clone <repo-url>
cd email-vrt
```

## 2. Install the root project

```bash
npm install
npx playwright install
```

## 3. Set up credentials

Create a `.env` file in the project root (this is gitignored — never commit it):

```
EMAIL_PREVIEW_SERVICE=emailonacid
EMAILONACID_API_KEY=your_api_key
EMAILONACID_ACCOUNT_PASSWORD=your_password
```

You can also skip this and enter credentials once via the UI's Settings tab instead — same file, same effect. The EOA test ID and task name are **not** set here; they're entered per run in the UI.

## 4. Install the UI/server

```bash
cd email-visual-tester-ui
npm install
npx playwright install chromium
```

(This is a separate Playwright install from step 2 — it's only used to render PDF reports, not to run tests.)

## 5. Run it

From inside `email-visual-tester-ui`:

```bash
npm start
```

Open **http://localhost:4500**.

### How to Run the Tests

## Baseline Creation (First Run)

When running the tests for the very first time on a new email or a new client combination, the framework will execute a specific sequence:

1.  **Missing Baseline:** The comparison script will detect that the required baseline image does not exist.
2.  **Expected Failure:** The test for that specific client **will fail** because no comparison could be made.
3.  **Automatic Capture:** The framework will then **automatically save the newly rendered image** into the `/baselines` folder, naming it correctly.
4.  **Action:** You must then **rerun the test** immediately. The second time, the comparison will succeed, assuming the new image matches the newly created baseline.

## For every new task

1. **Settings** — Enter EOA and Jira credentials once; they're saved to `.env` and reused automatically for every run after that.
2. **New Run** — Paste the EOA test ID, enter a task name, set diff sensitivity, click Run.
3. **First run** -  For a given task creates baseline images; later runs compare against them.
4. **Results** — Each client card shows the captured screenshot with a toggle to the diff heatmap, pass/fail status, diff %. Override a status if a diff is a false positive, add a note, set who tested it, and click on generate report.
5. **Generate PDF report** - Once all notes/overrides are finalized, then download it.
