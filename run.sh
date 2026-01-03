#!/bin/bash
set -e

# This script is a wrapper for Docker Compose that automatically selects the correct
# override file based on the APP_ENV environment variable.
#
# USAGE:
# ./run.sh up --build
# ./run.sh down
#
# For production, ensure APP_ENV is set to 'production' in your server's
# environment or in the .env file.

# Source environment variables from .env file if it exists, to get APP_ENV
if [ -f .env ]; then
  source .env
fi

# Default to 'local' if APP_ENV is not set
APP_ENV=${APP_ENV:-local}

echo "Running with APP_ENV: $APP_ENV"

# Base command
COMPOSE_CMD="docker compose"

if [ "$APP_ENV" = "production" ]; then
  # For production, explicitly specify both files to ensure correct override
  COMPOSE_CMD="$COMPOSE_CMD -f docker-compose.yml -f docker-compose.prod.yml"
  echo "Using production configuration..."
else
  # For local dev, Docker Compose automatically finds docker-compose.yml and docker-compose.override.yml
  echo "Using local development configuration..."
fi

# Execute the final docker compose command with all arguments passed to the script
$COMPOSE_CMD "$@"
