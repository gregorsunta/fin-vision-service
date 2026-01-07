To test the image splitting endpoint, follow these steps:

1.  **Ensure Docker Desktop is running.** If it's not, please start it.
2.  **Start the necessary Docker services:**
    ```bash
    docker compose up -d redis mysql
    ```
    Verify they are running with `docker ps`.
3.  **Start the API server:**
    ```bash
    npm run dev:api
    ```
    The API should be available at `http://localhost:3000`.

4.  **Set your `INTERNAL_API_KEY` and `GEMINI_API_KEY`:**
    In your `.env` file, ensure you have both `INTERNAL_API_KEY` and `GEMINI_API_KEY` set to strong random strings/keys. For example:
    ```
    INTERNAL_API_KEY="rgF4YTF4DSGX989Tsw6CwKyURw7nzMLmnryKOc8f2Wc="
    GEMINI_API_KEY="YOUR_ACTUAL_GEMINI_API_KEY_HERE"
    ```
    You will need to obtain your `GEMINI_API_KEY` from the Google AI Studio or Google Cloud Console.

5.  **Use the Image Splitting Endpoint:**

    *   **Method:** `POST`
    *   **URL:** `http://localhost:3000/api/image/split`
    *   **Headers:**
        *   `Authorization: Bearer <YOUR_INTERNAL_API_KEY>`
        *   `Content-Type: multipart/form-data`
    *   **Body:** A `multipart/form-data` request containing the image file. The field name for the file should be `file`.
    *   **Query Parameters (Optional):**
        *   `debug` (boolean): If `true`, the response will include the bounding boxes detected by Gemini.

    **`curl` Example:**

    ```bash
    curl -X POST \
      -H "Authorization: Bearer rgF4YTF4DSGX92389Tsw6CwKyURw7nzMLmnryKOc8f2Wc=" \
      -F "file=@/path/to/your/image_with_multiple_receipts.jpg" \
      "http://localhost:3000/api/image/split?debug=true"
    ```

    **Expected Response (with `debug=true`):**

    ```json
    {
      "message": "N images created.",
      "files": [
        { "url": "/files/unique_filename_1.jpg" },
        { "url": "/files/unique_filename_2.jpg" }
        // ... more split image URLs
      ],
      "debug": {
        "boundingBoxes": [
          { "x": 10, "y": 20, "width": 300, "height": 500 },
          { "x": 350, "y": 25, "width": 280, "height": 480 }
        ]
        // rawBoundingBoxes and binaryImageUrl are no longer returned
      }
    }
    ```
