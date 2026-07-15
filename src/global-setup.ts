import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { resolve } from 'path';
import * as dotenv from 'dotenv';
import { getEmailPreviewService } from './utils/service-factory';
import { sanitizeFilename } from './utils/filename';
import axios from 'axios';

dotenv.config();

export interface GeneratedPreview {
  name: string;
  url: string;
  client: string;
}

const TEMP_DIR = resolve(__dirname, '..', 'temp');
const ARCHIVE_DIR = resolve(TEMP_DIR, 'archives');
const EMAILS_DIR = resolve(__dirname, '..', 'emails');
const DEFAULT_CLIENTS_FILE = resolve(__dirname, '..', 'default-clients-eoa.json');

async function globalSetup() {
  const taskName = process.env.TASK_NAME;
  const existingTestId =
    process.env.EXISTING_EOA_TEST_ID ||
    process.env.EOA_TEST_ID || 
    '';

  if (!taskName) {
    console.warn('WARNING: TASK_NAME is not set. Exiting setup (tests will skip).');
    return;
  }

  // Standardized hyphen-based task name
  const sanitizedTaskName = sanitizeFilename(taskName);
  const GENERATED_URLS_FILE = resolve(TEMP_DIR, `generated-preview-urls-${sanitizedTaskName}.json`);

  const now = new Date();
  const verboseTimestamp = now.toISOString().replace(/[:.]/g, '-').split('T').join('-');

  console.log(`--- Global Setup Start: Task "${taskName}" ---`);
  if (existingTestId) {
    console.log(`Mode: USING EXISTING Email on Acid test (ID: ${existingTestId})`);
  } else {
    console.log('Mode: CREATING NEW Email on Acid test from local HTML');
  }

  // Determine which email clients to request (still needed for both modes)
  const desiredApiClients = getDesiredApiClients();

  // Fetch credentials (still needed even when reusing an existing test, for polling)
  const { serviceToUse, apiKey, accountPassword } = getServiceCredentials();

  // Ensure output folders exist
  if (!existsSync(TEMP_DIR)) mkdirSync(TEMP_DIR, { recursive: true });
  if (!existsSync(ARCHIVE_DIR)) mkdirSync(ARCHIVE_DIR, { recursive: true });

  // Instantiate the preview service
  const previewService = getEmailPreviewService(serviceToUse, apiKey, accountPassword);

  // STEP A: Obtain a test ID (either reuse existing or create via HTML injection)
  let testId: string;
  try {
    if (existingTestId) {
      // Reuse path: no HTML required, just validate minimal format
      testId = existingTestId.trim();
      if (!testId) throw new Error('Provided existing test ID is empty.');
    } else {
      // Create path: need local HTML file
      const emailHtmlFileName = `${sanitizedTaskName}.html`;
      const EMAIL_HTML_FILE = resolve(EMAILS_DIR, emailHtmlFileName);

      if (!existsSync(EMAIL_HTML_FILE)) {
        throw new Error(
          `Could not find email HTML file at ${EMAIL_HTML_FILE}. Place it there or set EXISTING_EOA_TEST_ID.`
        );
      }

      const emailHtmlContent = readFileSync(EMAIL_HTML_FILE, 'utf-8');
      const emailSubject = `${taskName} - EOA Preview - ${now.toLocaleString()}`;

      console.log('Uploading HTML to create a new EOA test...');
      const injectionResponse = await previewService.injectHtml(emailHtmlContent, emailSubject, {
        clients: desiredApiClients,
      });
      testId = injectionResponse.test_id;
      console.log(`New test created. ID: ${testId}`);
    }
  } catch (error) {
    handleError(error);
    return;
  }

  // STEP B: Poll for preview URLs
  try {
    const previewUrlsMap = await previewService.getPreviewUrls(
      { test_id: testId },
      desiredApiClients
    );

    const generatedPreviews: GeneratedPreview[] = Object.entries(previewUrlsMap).map(
      ([client, url]) => ({
        name: `${client.replace(/_/g, ' ').replace(/\b\w/g, char => char.toUpperCase())} Preview`,
        url,
        client,
      })
    );

    // Persist main file consumed by blueprint test
    writeFileSync(GENERATED_URLS_FILE, JSON.stringify(generatedPreviews, null, 2));
    console.log(`Saved preview list: ${GENERATED_URLS_FILE}`);

    // Archive copy for history
    archiveGeneratedUrls(sanitizedTaskName, verboseTimestamp, generatedPreviews);
  } catch (error) {
    handleError(error);
    return;
  }

  console.log('--- Global Setup Finished ---');
}

function getDesiredApiClients() {
  if (!existsSync(DEFAULT_CLIENTS_FILE)) {
    throw new Error(`Missing default clients config: ${DEFAULT_CLIENTS_FILE}`);
  }
  const clientsConfigString = readFileSync(DEFAULT_CLIENTS_FILE, 'utf-8');
  const clientsConfig = JSON.parse(clientsConfigString);
  return Object.values(clientsConfig).map((client: any) => client.id);
}

function getServiceCredentials() {
  const serviceToUse = process.env.EMAIL_PREVIEW_SERVICE?.toLowerCase();
  const apiKey = process.env[`${serviceToUse?.toUpperCase()}_API_KEY`];
  const accountPassword = process.env.EMAILONACID_ACCOUNT_PASSWORD;

  if (!serviceToUse || !apiKey || !accountPassword) {
    throw new Error(
      'Missing EMAIL_PREVIEW_SERVICE, its API key, or EMAILONACID_ACCOUNT_PASSWORD.'
    );
  }
  return { serviceToUse, apiKey, accountPassword };
}

function archiveGeneratedUrls(
  sanitizedTaskName: string,
  verboseTimestamp: string,
  generatedPreviews: GeneratedPreview[]
) {
  const archiveFileName = `generated-preview-urls-${sanitizedTaskName}-${verboseTimestamp}.json`;
  const archiveFilePath = resolve(ARCHIVE_DIR, archiveFileName);
  writeFileSync(archiveFilePath, JSON.stringify(generatedPreviews, null, 2));
  console.log(`Archived: ${archiveFilePath}`);
}

function handleError(error: any) {
  console.error('Setup error:', error.message);
  if (axios.isAxiosError(error) && error.response) {
    console.error('API response:', JSON.stringify(error.response.data, null, 2));
  }
  // Intentionally throw so Playwright marks setup as failed (tests will skip gracefully)
  throw new Error(`Preview generation failed: ${error.message}`);
}

export default globalSetup;