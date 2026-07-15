// PURPOSE: Chooses which email preview service implementation to use.
// Currently only Email on Acid is active. Litmus skeleton is present for future.

// Interface that all services must implement (injectHtml + getPreviewUrls).
import { IEmailPreviewService } from '../interfaces/i-email-preview-service';
import { EmailOnAcidService } from '../services/email-on-acid-service';
// import { LitmusService } from '../services/litmus-service'; // (Future expansion)

export function getEmailPreviewService(
  serviceName: string,
  apiKey: string,
  accountPassword?: string
): IEmailPreviewService {
  switch (serviceName.toLowerCase()) {
    case 'emailonacid':
      if (!accountPassword) {
        throw new Error('EmailOnAcidService requires both API key and password.');
      }
      return new EmailOnAcidService(apiKey, accountPassword);

    case 'litmus':
      // Placeholder:
      // return new LitmusService(apiKey);

    default:
      throw new Error(`Unsupported preview service: ${serviceName}`);
  }
}