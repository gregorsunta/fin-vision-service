# Fin-Vision Service

This project is a receipt and invoice analysis server built with Node.js, Fastify, Drizzle ORM, and BullMQ. It uses Google Gemini for structured data extraction from receipt images.

## Project Architecture

-   **/src/api**: Fastify API for handling requests.
-   **/src/workers**: BullMQ workers for asynchronous job processing.
-   **/src/db**: Drizzle ORM schema and database utilities.
-   **/src/queue**: BullMQ queue setup.
-   **/src/services**: Services for interacting with external APIs like Gemini.
-   **/drizzle**: Auto-generated database migration files.
-   **docker-compose.yml**: Defines the services, networks, and volumes for the application.
-   **Dockerfile**: A multi-stage Dockerfile for building optimized production images.

## Prerequisites

-   Node.js (v22+)
-   NPM
-   Docker and Docker Compose

## Getting Started

### 1. Clone the Repository

```bash
git clone <repository-url>
cd fin-vision-service
```

### 2. Install Dependencies

```bash
npm install
```

### 3. Set Up Google Cloud Authentication

This service requires credentials to use the Google Vision and Gemini APIs.

1.  Create a Google Cloud Platform project and enable the "Cloud Vision API" and the "Vertex AI API".
2.  Create a service account with the "Vertex AI User" and "Cloud Vision AI User" roles.
3.  Download the JSON key file for this service account.
4.  Place the key file in the root of this project and name it `gcp-credentials.json`.

### 4. Configure Environment Variables

Create a `.env` file in the project root by copying from `.env.example`:

```bash
cp .env.example .env
```

Now, open the `.env` file and fill in the required values, especially:
-   `GEMINI_API_KEY`: Your Google Gemini API key.
-   `INTERNAL_API_KEY`: A strong, random string for internal service-to-service authentication.
-   `DATABASE_URL`: The connection string for MySQL.
-   `REDIS_URL`: The connection string for Redis.
-   `GOOGLE_APPLICATION_CREDENTIALS`: Ensure this points to `./gcp-credentials.json` if you placed the key file there.

**Important**: Do not commit your `.env` file to version control. It is already included in `.gitignore`.

### 5. Create the External Docker Network

This service is designed to connect to a pre-existing external Docker network. Create it by running:

```bash
docker network create fin-vision-net
```

### 6. Run Database Migrations

First, start the database service to allow the migration script to connect.

```bash
docker-compose up -d mysql
```

Wait a few seconds for the database to initialize, then apply any pending migrations. If this is the first time, you may need to generate them first.

```bash
# Optional: Generate migration files if you changed the schema
npm run db:generate

# Apply the migrations to the database
npm run db:migrate
```

## Universal `run.sh` Script

This project uses a `./run.sh` script to simplify running Docker Compose. It automatically detects your environment (`local` or `production`) based on the `APP_ENV` variable in your `.env` file and uses the correct configuration.

-   **`APP_ENV=local`**: Uses `docker-compose.override.yml` for local development settings (port mappings, local volumes).
-   **`APP_ENV=production`**: Uses `docker-compose.prod.yml` for production settings (bind mounts).

---

## Getting Started (Local Development)

### 1. Configure Environment

Create a `.env` file from the example:

```bash
cp .env.example .env
```

Ensure `APP_ENV` is set to `local` and fill in your secrets (e.g., `GEMINI_API_KEY`).

### 2. Set Up Google Cloud Authentication

1.  Enable the "Cloud Vision API" and "Vertex AI API" in your GCP project.
2.  Create a service account with "Vertex AI User" and "Cloud Vision AI User" roles.
3.  Download the service account's JSON key and save it as `gcp-credentials.json` in the project root.

### 3. Create the Docker Network

```bash
docker network create fin-vision-net
```

### 4. Run the Application

Use the `run.sh` script to build and start all services.

```bash
./run.sh up --build
```

The API will be available at `http://localhost:3000`. To stop the services, run `./run.sh down`.

---

## Database Migrations

First, ensure the database container is running (`./run.sh up -d mysql`), then run the migration command:

```bash
# Optional: Generate migration files if you changed the schema
npm run db:generate

# Apply the migrations to the database
npm run db:migrate
```

## Production Deployment

1.  On your server, create a `.env` file and set **`APP_ENV=production`**. Fill in your production secrets.
2.  Create your persistent storage directories (e.g., `/srv/fin-vision-data/mysql`).
3.  Edit `docker-compose.prod.yml` and update the host paths for the bind mounts to match the directories you just created.
4.  Deploy the application using the same `run.sh` script. It will automatically detect `APP_ENV=production` and apply the production configuration.
    ```bash
    ./run.sh up -d --build
    ```
## API Endpoints

-   `POST /api/receipts`: Upload a receipt image for processing. The request should be a `multipart/form-data` with a file field.
-   `GET /health`: Health check endpoint.

## Database Management

-   **Generate Migrations**: `npm run db:generate`
-   **Apply Migrations**: `npm run db:migrate`
-   **Drizzle Studio (GUI)**: `npm run db:studio` (requires the database to be running)