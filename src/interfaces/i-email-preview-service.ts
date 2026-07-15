// src/interfaces/i-email-preview-service.ts
export interface IEmailPreviewService {
  /**
   * Injects email HTML content into the service and returns a response
   * containing information about the preview generation process.
   * The exact content of the response will depend on the service.
   * @param htmlContent The HTML content of the email.
   * @param subject Optional subject for the email preview.
   * @param options Optional additional service-specific options.
   * @returns A promise that resolves to a service-specific response object.
   */
  injectHtml(
    htmlContent: string,
    subject?: string,
    options?: Record<string, any>
  ): Promise<any>;

  /**
   * Retrieves a dictionary of preview URLs for specified email clients
   * based on the injection response.
   * @param injectionResponse The response object obtained from `injectHtml`.
   * @param emailClients A list of email client identifiers (e.g., 'gmail', 'outlook').
   * @returns A promise that resolves to a dictionary where keys are client names and values are their preview URLs.
   */
  getPreviewUrls(
    injectionResponse: any,
    emailClients: string[]
  ): Promise<Record<string, string>>;

  /**
   * Returns a list of email clients supported by the service.
   * @returns A promise that resolves to a list of supported email client identifiers.
   */
  getSupportedClients(): Promise<string[]>;
}