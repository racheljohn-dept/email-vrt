import { defineConfig } from '@playwright/test';
import { resolve } from 'path';
import * as dotenv from 'dotenv';

// 1) Loads variables from .env (like TASK_NAME) so the test run adapts per task.
//    QA: If a test isn't picking up your task, ensure .env has TASK_NAME or export it in the shell.
dotenv.config();

// 2) Turns a task name into a safe folder/file segment: lowercase, hyphens, limited length.
function sanitizeFilename(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9\s-.]/g, '').replace(/\s+/g, '-').substring(0, 100);
}

// 3) PROJECT NAME: Used for screenshot folder paths.
//    QA: Set TASK_NAME before running and your screenshots will go into visual-baselines/<task-name>/
const taskName = process.env.TASK_NAME;
const projectName = taskName ? sanitizeFilename(taskName) : 'staging';

// 4) This configuration tells Playwright:
//    - what setup code to run first,
//    - where tests live,
//    - how screenshots and reports are stored,
//    - retry behavior in CI.
export default defineConfig({
  // Runs once before ALL tests. Generates preview URLs from the email HTML.
  globalSetup: resolve(__dirname, 'src', 'global-setup.ts'),

  // Location of test specs.
  testDir: './tests',

  // Allow multiple tests at the same time (faster locally).
  fullyParallel: true,

  // Prevent accidental .only left in code from passing in CI.
  forbidOnly: !!process.env.CI,

  // If running on CI, retry failures twice. Locally: no retries.
  retries: process.env.CI ? 2 : 0,

  // In CI, run single-threaded for stability. Locally, auto-select workers.
  workers: process.env.CI ? 1 : undefined,

  // Produce an HTML report after test run (openable in a browser).
reporter: [
  ['html', { open: 'always' }]
],
  // Shared settings for every test (e.g., capture traces on first retry).
  use: {
    trace: 'on-first-retry',
    // NOTE: We purposely do NOT set screenshot thresholds here. They are managed per assertion.
  },

  // Define a single "project" (bucket of tests) named after the task.
  // QA: Only the blueprint spec is executed here.
  projects: [
    {
      name: projectName,
      testMatch: 'tests/blueprint.spec.ts'
    },
  ],

  // Raw artifacts (traces, videos if enabled, etc.).
  outputDir: 'test-results/',

  // How visual comparisons store baseline files.
  // QA: Baseline images live under visual-baselines/<projectName>/.
  expect: {
    toHaveScreenshot: {
      pathTemplate: resolve(__dirname, 'visual-baselines', '{projectName}', '{arg}{ext}'),
    },
    toMatchAriaSnapshot: {
      pathTemplate: resolve(__dirname, 'visual-baselines', '{projectName}', '{arg}{ext}'),
    },
  },
});