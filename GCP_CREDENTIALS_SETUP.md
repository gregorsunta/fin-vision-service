# Google Cloud Credentials Setup

The worker process is failing with "Could not load the default credentials" because it cannot authenticate with Google Cloud APIs (Vision AI and Gemini). You need to set up Google Cloud credentials for your project.

**Steps:**

1.  **Ensure a Google Cloud Project:** Make sure you have an active Google Cloud Project.
    *   If not, create one at [Google Cloud Console](https://console.cloud.google.com/).

2.  **Enable Necessary APIs:**
    *   In your Google Cloud Project, enable the following APIs:
        *   **Cloud Vision API**
        *   **Vertex AI API** (This includes access to the Gemini model.)
    *   You can enable them by searching for them in the console and clicking "ENABLE".

3.  **Create a Service Account:**
    *   Go to **IAM & Admin > Service Accounts** in your Google Cloud Console.
    *   Click "+ CREATE SERVICE ACCOUNT".
    *   Give it a name (e.g., `fin-vision-worker`).

4.  **Assign Roles to the Service Account:**
    *   After creating the service account, assign the following roles:
        *   **Cloud Vision API User**
        *   **Vertex AI User**
    *   These roles grant the necessary permissions for the worker to use the Vision AI and Gemini APIs.

5.  **Create and Download a JSON Key:**
    *   In the Service Accounts list, click on the service account you just created.
    *   Go to the "Keys" tab.
    *   Click "ADD KEY" > "Create new key".
    *   Select "JSON" as the key type and click "CREATE".
    *   A JSON file will be downloaded to your computer.

6.  **Place the JSON Key File:**
    *   **Rename** the downloaded JSON file to `gcp-credentials.json`.
    *   **Move** this `gcp-credentials.json` file into the **root directory of your `fin-vision-service` project** (the same directory where `docker-compose.yml` and `package.json` are located).

---

Once you have completed these steps and placed the `gcp-credentials.json` file in the correct location:

1.  **Restart the services:**
    ```bash
    ./run.sh up --build -d
    ```

2.  **Upload a new receipt:**
    ```bash
    curl -X POST -H "Authorization: YOUR_API_KEY" -F "file=@YOUR_IMAGE_FILE.jpg" http://localhost:3000/api/receipts
    ```
    (Use a fresh API key if you don't have one, by running `curl -X POST http://localhost:3000/api/users`)

3.  **Wait for processing (a few seconds).**

4.  **Retry the CSV export:**
    ```bash
    curl -H "Authorization: YOUR_API_KEY" http://localhost:3000/api/users/me/receipts/export-csv
    ```

You should now see the processed data in your CSV output!
