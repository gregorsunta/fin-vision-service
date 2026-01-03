# Google Cloud Billing Setup

The worker process is now successfully authenticating with Google Cloud! This means your `gcp-credentials.json` file and the `GOOGLE_APPLICATION_CREDENTIALS` environment variable are correctly configured.

However, the new error indicates a **billing issue**:

`PERMISSION_DENIED: This API method requires billing to be enabled.`

Google Cloud Vision API and Vertex AI API (which includes the Gemini model) are not part of Google Cloud's always-free tier. You need to enable a billing account for your Google Cloud Project to use these services.

**Steps to Resolve:**

1.  **Enable Billing:**
    *   Visit the Google Cloud Console link provided in the error message (or go to **Billing** in your Google Cloud Project):
        *   `https://console.developers.google.com/billing/enable?project=700342514386` (Note: The project number might be different for your specific project).
    *   Follow the instructions to enable a billing account for your project. This typically involves linking a payment method.

2.  **Wait for Propagation:**
    *   After enabling billing, it can take a few minutes for the changes to propagate across Google Cloud's systems. It's advisable to wait 5-10 minutes.

---

Once billing is enabled and propagated:

1.  **Restart the services (important!):**
    *   ```bash
        ./run.sh up --build -d
        ```
    *   (The worker might have marked previous jobs as failed; a restart ensures a fresh state.)

2.  **Upload a new receipt:**
    *   ```bash
        curl -X POST -H "Authorization: YOUR_API_KEY" -F "file=@YOUR_IMAGE_FILE.jpg" http://localhost:3000/api/receipts
        ```
    *   Use a *fresh* receipt image or one that hasn't been processed, or wait for the existing one to be retried by BullMQ.

3.  **Wait for processing (a few seconds).**

4.  **Retry the CSV export:**
    *   ```bash
        curl -H "Authorization: YOUR_API_KEY" http://localhost:3000/api/users/me/receipts/export-csv
        ```

You should now finally see the processed data in your CSV output!
