// PURPOSE: Talks to the "Email on Acid" service to:
// 1) Upload email HTML and start a preview test.
// 2) Poll for screenshot URLs for specified clients.

import axios from 'axios';
import { IEmailPreviewService } from '../interfaces/i-email-preview-service';

// Builds the Basic Authorization header (API key + password).
function createAuthHeader(apiKey: string, password: string): string {
  return `Basic ${Buffer.from(`${apiKey}:${password}`).toString('base64')}`;
}

export class EmailOnAcidService implements IEmailPreviewService {
  private readonly apiKey: string;
  private readonly password: string;
  private readonly baseUrl = 'https://api.emailonacid.com';

  constructor(apiKey: string, password: string) {
    if (!apiKey || !password) {
      throw new Error('EmailOnAcidService: API key and password are required.');
    }
    this.apiKey = apiKey;
    this.password = password;
  }

  // STEP 1: Upload the email HTML and create a new test.
  async injectHtml(
    htmlContent: string,
    subject?: string,
    options?: Record<string, any>
  ): Promise<{ test_id: string }> {
    const headers = {
      Authorization: createAuthHeader(this.apiKey, this.password),
      'Content-Type': 'application/json',
      Accept: 'application/json',
    };

    // The payload includes subject, raw HTML, and the list of clients if provided.
    const payload = {
      subject: subject || `Email Test - ${new Date().toLocaleString('en-US', { timeZone: 'America/Argentina/Buenos_Aires' })}`,
      html: htmlContent,
      ...(options?.clients ? { clients: options.clients } : {}),
      ...options,
    };

    try {
      console.log('📤 Uploading email to Email on Acid...');
      const response = await axios.post(`${this.baseUrl}/v5/email/tests`, payload, { headers });
      
      if (!response.data?.id) {
        throw new Error('Email on Acid did not return a test ID.');
      }
      
      console.log(`✅ Test created. ID: ${response.data.id}`);
      return { test_id: response.data.id };
    } catch (error: any) {
      console.error('❌ Upload failed:', error.message);
      if (axios.isAxiosError(error) && error.response) {
        console.error(`   API status: ${error.response.status}`);
      }
      throw error;
    }
  }

  // STEP 2: Poll the API until screenshots are ready for requested clients.
  async getPreviewUrls(
    injectionResponse: { test_id: string },
    emailClients: string[]
  ): Promise<Record<string, string>> {
    const testId = injectionResponse.test_id;
    if (!testId) throw new Error('Missing test ID');

    // Polling behavior can be tuned with environment variables.
    const maxAttempts = Number(process.env.EOA_MAX_ATTEMPTS || 60);
    const waitSeconds = Number(process.env.EOA_WAIT_SECONDS || 10);
    const showDebug = process.env.EOA_DEBUG === 'true';

    console.log(`\n⏳ Gathering ${emailClients.length} screenshot(s)...`);
    console.log(`   Checking every ${waitSeconds}s (up to ${maxAttempts} times)\n`);

    const capturedUrls: Record<string, string> = {};

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      const results = await this.fetchResults(testId, waitSeconds, showDebug);
      
      // If API call failed transiently, wait and retry.
      if (!results) {
        await this.wait(waitSeconds, attempt, maxAttempts);
        continue;
      }

      const clientsInResults = this.processClientResults(
        results,
        emailClients,
        capturedUrls,
        showDebug
      );

      // Decide if it's time to stop polling early.
      const shouldExit = this.checkIfShouldExit(
        emailClients,
        results,
        capturedUrls,
        clientsInResults,
        attempt,
        showDebug
      );

      if (shouldExit) {
        console.log('\n✅ Finished collecting available screenshots.');
        break;
      }

      this.showProgress(emailClients, results, capturedUrls, attempt, showDebug);
      await this.wait(waitSeconds, attempt, maxAttempts);
    }

    // Return only successful screenshot URLs.
    return this.buildFinalResults(emailClients, capturedUrls);
  }

  // INTERNAL: Fetch current status of the test from the API.
  private async fetchResults(
    testId: string,
    timeoutSeconds: number,
    showDebug: boolean
  ): Promise<Record<string, any> | null> {
    if (showDebug) {
      console.log(`\n  📊 Polling test (ID: ${testId})`);
    }

    try {
      const headers = {
        Authorization: createAuthHeader(this.apiKey, this.password),
        Accept: 'application/json',
      };

      const response = await axios.get(
        `${this.baseUrl}/v5/email/tests/${testId}/results`,
        { headers, timeout: timeoutSeconds * 1000 * 0.9 }
      );

      return response.data || {};
    } catch (error: any) {
      if (axios.isAxiosError(error)) {
        const status = error.response?.status;
        if (status === 401) {
          throw new Error('Authentication failed - check your API credentials');
        }
        if (showDebug && status !== 404) {
          console.log(`   ⚠️ API error ${status}, will retry...`);
        }
      }
      return null;
    }
  }

  // INTERNAL: Examine each client’s status and store URLs if ready.
  private processClientResults(
    results: Record<string, any>,
    requestedClients: string[],
    capturedUrls: Record<string, string>,
    showDebug: boolean
  ): string[] {
    const clientsToCheck = requestedClients.length > 0 ? requestedClients : Object.keys(results);
    const clientsFound: string[] = [];

    for (const clientId of clientsToCheck) {
      const client = results[clientId];

      if (!client) {
        if (showDebug) console.log(`   ⏳ ${clientId} - not ready yet`);
        continue;
      }

      clientsFound.push(clientId);
      const status = client.status;

      if (status === 'Complete') {
        this.handleCompleteClient(clientId, client, capturedUrls, showDebug);
      } else if (status === 'Failed' || status === 'Bounced') {
        this.handleFailedClient(clientId, status, capturedUrls);
      } else if (showDebug) {
        console.log(`   ⏳ ${clientId} - ${status}`);
      }
    }

    return clientsFound;
  }

  // INTERNAL: When a client finishes successfully, capture its screenshot URL.
  private handleCompleteClient(
    clientId: string,
    client: any,
    capturedUrls: Record<string, string>,
    showDebug: boolean
  ): void {
    const screenshotUrl = client.screenshots?.default;

    if (screenshotUrl && typeof screenshotUrl === 'string') {
      if (!capturedUrls[clientId]) {
        capturedUrls[clientId] = screenshotUrl;
        console.log(`   ✅ ${clientId}`);
      }
    } else if (showDebug) {
      console.log(`   ⚠️ ${clientId} - Complete but screenshot not ready`);
    }
  }

  // INTERNAL: Mark failed or bounced clients (so we don’t wait forever).
  private handleFailedClient(
    clientId: string,
    status: string,
    capturedUrls: Record<string, string>
  ): void {
    if (!capturedUrls[clientId]) {
      console.log(`   ❌ ${clientId} - ${status}`);
      capturedUrls[clientId] = ''; // Empty signals a failure
    }
  }

  // INTERNAL: Decide if polling loop should stop.
  private checkIfShouldExit(
    requestedClients: string[],
    results: Record<string, any>,
    capturedUrls: Record<string, string>,
    clientsInResults: string[],
    attempt: number,
    showDebug: boolean
  ): boolean {
    if (Object.keys(results).length === 0) return false;

    const clientsToCheck = requestedClients.length > 0 ? requestedClients : Object.keys(results);
    const appearedClients = clientsToCheck.filter(id => results[id]);

    const finishedClients = appearedClients.filter(id => {
      const status = results[id]?.status;
      return status === 'Complete' || status === 'Failed' || status === 'Bounced';
    });

    const allFinished = finishedClients.length === appearedClients.length;
    const allRequestedAppeared = appearedClients.length === clientsToCheck.length;
    const waitedLongEnough = attempt >= 10;

    if (!allFinished) return false;
    if (!allRequestedAppeared && !waitedLongEnough) return false;

    const completeClients = appearedClients.filter(id => results[id].status === 'Complete');
    const completeWithUrls = completeClients.filter(id => capturedUrls[id] && capturedUrls[id] !== '');
    const allCompleteHaveUrls = completeWithUrls.length === completeClients.length;
    const triedEnoughForScreenshots = attempt >= 15;

    if (allCompleteHaveUrls || triedEnoughForScreenshots) return true;

    if (showDebug) {
      const waiting = completeClients.length - completeWithUrls.length;
      console.log(`   Waiting for ${waiting} screenshot URL(s)...`);
    }

    return false;
  }

  // INTERNAL: Periodic progress summary.
  private showProgress(
    requestedClients: string[],
    results: Record<string, any>,
    capturedUrls: Record<string, string>,
    attempt: number,
    showDebug: boolean
  ): void {
    if (attempt % 5 !== 0 && !showDebug) return;

    const successCount = Object.keys(capturedUrls).filter(id => capturedUrls[id] !== '').length;
    console.log(`   Progress: ${successCount}/${requestedClients.length} captured`);

    if (!showDebug) return;

    const pending = requestedClients.filter(id => {
      const client = results[id];
      return !client || (client.status !== 'Complete' && client.status !== 'Failed' && client.status !== 'Bounced');
    });

    const completeNoUrl = requestedClients.filter(id => {
      const client = results[id];
      return client?.status === 'Complete' && !capturedUrls[id];
    });

    if (pending.length > 0) {
      console.log(`   Pending: ${pending.join(', ')}`);
    }
    if (completeNoUrl.length > 0) {
      console.log(`   Complete but URL missing: ${completeNoUrl.join(', ')}`);
    }
  }

  // INTERNAL: Wait between attempts (basic delay).
  private async wait(seconds: number, currentAttempt: number, maxAttempts: number): Promise<void> {
    if (currentAttempt < maxAttempts) {
      await new Promise(resolve => setTimeout(resolve, seconds * 1000));
    }
  }

  // INTERNAL: Build final result set (exclude failures).
  private buildFinalResults(
    requestedClients: string[],
    capturedUrls: Record<string, string>
  ): Record<string, string> {
    const successfulUrls: Record<string, string> = {};
    for (const [id, url] of Object.entries(capturedUrls)) {
      if (url && url !== '') {
        successfulUrls[id] = url;
      }
    }

    const successCount = Object.keys(successfulUrls).length;
    const failedCount = Object.values(capturedUrls).filter(url => url === '').length;
    const neverAppeared = requestedClients.filter(id => !(id in capturedUrls));

    if (successCount === requestedClients.length) {
      console.log(`\n✅ All ${successCount} screenshot(s) ready.\n`);
    } else {
      console.warn(`\n⚠️ Captured ${successCount}/${requestedClients.length}.`);
      if (failedCount > 0) {
        const failed = Object.entries(capturedUrls).filter(([, url]) => url === '').map(([id]) => id);
        console.warn(`   Failed/Bounced: ${failed.join(', ')}`);
      }
      if (neverAppeared.length > 0) {
        console.warn(`   Never appeared (possibly unsupported): ${neverAppeared.join(', ')}\n`);
      }
    }

    return successfulUrls;
  }

  // SECONDARY: Get full list of supported clients (not used in main flow).
  async getSupportedClients(): Promise<string[]> {
    try {
      const headers = {
        Authorization: createAuthHeader(this.apiKey, this.password),
        Accept: 'application/json',
      };
      const response = await axios.get(`${this.baseUrl}/v5/email/clients`, { headers });
      return Object.keys(response.data || {});
    } catch (error: any) {
      console.error('Unable to fetch supported clients:', error.message);
      return [];
    }
  }
}