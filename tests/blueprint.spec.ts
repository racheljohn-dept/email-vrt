import { test, expect } from '@playwright/test';
import { readFileSync, existsSync } from 'fs';
import { resolve } from 'path';
import type { GeneratedPreview } from '../src/global-setup';
import { sanitizeFilename } from '../src/utils/filename';

// TASK_NAME selects which generated preview JSON we read.
// QA: Make sure TASK_NAME matches the HTML file used in setup.
const taskId = process.env.TASK_NAME;

// If no task name, skip entire suite (prevents confusing failures).
if (!taskId) {
test.skip('TASK_NAME not set', () => {
console.error('Please set TASK_NAME before running tests.');
  });
} else {
// Hyphen-style consistent with setup.
const sanitizedTaskId = sanitizeFilename(taskId);
const GENERATED_URLS_FILE = resolve(
__dirname,
'..',
'temp',
`generated-preview-urls-${sanitizedTaskId}.json`
  );

let generatedPreviews: GeneratedPreview[] = [];

// Attempt to load preview URL list produced by global setup.
if (existsSync(GENERATED_URLS_FILE)) {
try {
generatedPreviews = JSON.parse(readFileSync(GENERATED_URLS_FILE, 'utf-8'));
console.log(
`[Test] Loaded ${generatedPreviews.length} preview URL(s) for "${taskId}".`
      );
    } catch (error: any) {
console.error(`[Test] Could not parse preview file: ${error.message}`);
    }
  } else {
console.error(`[Test] Preview file missing: ${GENERATED_URLS_FILE}`);
  }

// If we have previews, generate one test per email client.
if (generatedPreviews.length > 0) {
    test.describe(`Visual Email Checks: ${taskId}`, () => {
      generatedPreviews.forEach(preview => {
test(`${preview.name} (${preview.client})`, async ({ page }, testInfo) => {
// Screenshot filename (derived from client ID).
const screenshotName = `${preview.client
            .toLowerCase()
            .replace(/[^a-z0-9]+/g, '-')}.png`;

// Annotations appear in the HTML report (extra context for QA).
            test.info().annotations.push({ type: 'client', description: preview.client });
            test.info().annotations.push({ type: 'previewUrl', description: preview.url });

// Navigate to the remote screenshot page from the preview service.
await page.goto(preview.url, { waitUntil: 'networkidle' });

// toHaveScreenshot only attaches actual/diff/expected images when the
// comparison FAILS — on a pass there's nothing to show by Playwright's
// own logic. Capture our own copy unconditionally so the report UI has
// something to display either way.
const capturedBuffer = await page.screenshot({ fullPage: true });
await testInfo.attach('captured', { body: capturedBuffer, contentType: 'image/png' });

// Compare the full page screenshot to stored baseline.
// QA: If this fails, open the HTML report to see differences.
// maxDiffPixelRatio now reads from VRT_MAX_DIFF_RATIO, set by the
// UI's sensitivity slider (email-visual-tester-ui/server.js). Falls
// back to 0.05 if run manually without that env var set.
await expect(page).toHaveScreenshot(screenshotName, {
fullPage: true,
timeout: 10000,
maxDiffPixelRatio: Number(process.env.VRT_MAX_DIFF_RATIO ?? 0.05),
            });
        });
      });
    });
  } else {
// Graceful skip when no previews were generated.
    test.describe(`No Previews Available: ${taskId}`, () => {
      test.skip('No preview URLs found; global setup may have failed.', () => {});
    });
  }
}
