# Fin-Vision Service API Documentation

## Base URL
- **Development**: `http://localhost:3000`
- **Production**: (TBD based on deployment)

---

## Authentication

Most endpoints require authentication using one of two methods:

1. **JWT Access Token** (Bearer Token)
   - Include in header: `Authorization: Bearer <access_token>`
   - Short-lived token (~15 minutes typical)

2. **API Key** (for service-to-service calls)
   - Include in header: `X-API-Key: <api_key>`

3. **Refresh Token** (HttpOnly Cookie)
   - Automatically sent by browser for token refresh
   - Stored in secure, HttpOnly cookie named `refreshToken`

---

## All Endpoints Summary

### Authentication & Users (5 endpoints)
1. `GET /health` - Health check
2. `POST /api/users` - Register new user
3. `POST /api/auth/login` - Login and get access token
4. `POST /api/auth/refresh-token` - Refresh access token
5. `POST /api/auth/logout` - Logout user

### Receipt Processing (1 endpoint)
6. `POST /api/image/split-and-analyze` - Upload & process receipt images

### Receipt Retrieval (2 endpoints)
7. `GET /api/receipts/:uploadId` - **Get comprehensive upload details with all receipts** ⭐
8. `GET /api/receipts/:uploadId/receipt/:receiptId` - Get individual receipt details

### Files & Export (2 endpoints)
9. `GET /api/files/:filename` - Get uploaded image files
10. `GET /api/users/me/receipts/export-csv` - Export all user receipts as CSV

---

## Detailed Endpoint Documentation

### 1. Health Check

**GET** `/health`

Check if the API is running.

**Authentication**: None

**Response**: `200 OK`
```json
{
  "status": "ok"
}
```

---

### 2. User Registration

**POST** `/api/users`

Create a new user account.

**Authentication**: None

**Request Body**:
```json
{
  "email": "user@example.com",
  "password": "SecureP@ss123"
}
```

**Validation Rules**:
- `email`: Must be a valid email address
- `password`: 
  - Minimum 8 characters
  - At least one lowercase letter
  - At least one uppercase letter
  - At least one number
  - At least one special character

**Response**: `201 Created`
```json
{
  "userId": 1,
  "email": "user@example.com",
  "apiKey": "usk_abc123...",
  "message": "User created successfully."
}
```

**Error Responses**:
- `400 Bad Request`: Validation failed
- `409 Conflict`: User already exists

---

### 3. User Login

**POST** `/api/auth/login`

Authenticate a user and receive access token.

**Authentication**: None

**Request Body**:
```json
{
  "email": "user@example.com",
  "password": "SecureP@ss123"
}
```

**Response**: `200 OK`
```json
{
  "accessToken": "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9..."
}
```

**Note**: A `refreshToken` is also set as an HttpOnly cookie with 7 days expiration.

**Error Responses**:
- `400 Bad Request`: Validation failed
- `401 Unauthorized`: Invalid credentials

---

### 4. Refresh Access Token

**POST** `/api/auth/refresh-token`

Get a new access token using the refresh token cookie.

**Authentication**: Refresh token (from cookie)

**Request Body**: None

**Response**: `200 OK`
```json
{
  "accessToken": "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9..."
}
```

**Error Responses**:
- `401 Unauthorized`: No refresh token found
- `403 Forbidden`: Invalid or expired refresh token

---

### 5. User Logout

**POST** `/api/auth/logout`

Logout the current user and invalidate refresh token.

**Authentication**: Required (JWT Access Token)

**Request Body**: None

**Response**: `204 No Content`

---

### 6. Upload and Process Receipt Image

**POST** `/api/image/split-and-analyze`

Upload a receipt image (or multiple receipts in one image) for automatic splitting and AI analysis.

**Authentication**: Required (JWT Access Token)

**Request**: `multipart/form-data`
- **Field name**: `file`
- **Content-Type**: `image/jpeg`, `image/png`, etc.
- **Max file size**: 10 MB

**Response**: `200 OK`
```json
{
  "uploadId": 123,
  "message": "Processing complete. 2 succeeded, 0 failed.",
  "originalImageUrl": "/files/abc123...jpg",
  "markedImageUrl": "/files/marked-abc123...jpg",
  "successful_receipts": [
    {
      "receiptId": 456,
      "imageUrl": "/files/receipt-0-abc123...jpg",
      "isDuplicate": false,
      "duplicateConfidence": 0,
      "data": {
        "merchantName": "Walmart",
        "total": 45.67,
        "tax": 3.42,
        "currency": "USD",
        "transactionDate": "2024-01-15",
        "keywords": ["grocery", "food"],
        "items": [
          {
            "description": "Milk 2%",
            "quantity": 1,
            "quantityUnit": "pieces",
            "price": 3.99,
            "keywords": ["dairy", "beverage"]
          }
        ]
      }
    }
  ],
  "failed_receipts": [],
  "duplicate_warnings": [
    {
      "receiptId": 457,
      "imageUrl": "/files/receipt-1-abc123...jpg",
      "confidenceScore": 92,
      "confidenceLevel": "LIKELY_DUPLICATE",
      "matchedAgainst": {
        "receiptId": 234,
        "storeName": "Walmart",
        "totalAmount": "45.67",
        "transactionDate": "2024-01-15"
      },
      "matchFactors": {
        "storeName": { "score": 30, "similarity": 100 },
        "totalAmount": { "score": 25, "difference": 0 },
        "date": { "score": 20, "daysDifference": 0 },
        "itemCount": { "score": 15, "difference": 0 },
        "taxAmount": { "score": 2, "difference": 0.01 }
      },
      "recommendation": "This receipt appears to be a duplicate. Please review before confirming."
    }
  ]
}
```

**Duplicate Detection**:
- Each receipt is automatically checked against existing receipts from the same user
- Uses multi-factor fuzzy matching with confidence scoring (0-100)
- Matching factors: store name, total amount, date, item count, tax amount
- Confidence levels:
  - **95-100**: DEFINITE_DUPLICATE (auto-flagged)
  - **85-94**: LIKELY_DUPLICATE (user review recommended)
  - **70-84**: POSSIBLE_DUPLICATE (warning shown)
  - **<70**: NOT_DUPLICATE
- Handles OCR errors and blurred images intelligently

**Error Responses**:
- `400 Bad Request`: No file uploaded
- `401 Unauthorized`: Not authenticated
- `500 Internal Server Error`: Processing failure

---

### 7. Get Receipt Upload by ID ⭐ NEW

**GET** `/api/receipts/:uploadId`

**Returns a comprehensive object with:**
- All image URLs (original, marked with rectangles, split receipts)
- Processing statistics (total detected, successful, failed, processing)
- All receipts grouped by status
- Currency information per receipt
- Quantity units per line item

**Authentication**: Required (JWT Access Token)

**Response**: `200 OK`
```json
{
  "uploadId": 123,
  "userId": 1,
  "status": "completed",
  "hasReceipts": true,
  "createdAt": "2024-01-15T10:30:00.000Z",
  "updatedAt": "2024-01-15T10:30:15.000Z",
  
  "images": {
    "original": "/files/abc123...jpg",
    "marked": "/files/marked-abc123...jpg",
    "splitReceipts": [
      "/files/receipt-0-abc123...jpg",
      "/files/receipt-1-abc123...jpg"
    ]
  },
  
  "statistics": {
    "totalDetected": 2,
    "successful": 2,
    "failed": 0,
    "processing": 0
  },
  
  "message": "Processing complete. 2 succeeded, 0 failed.",
  
  "receipts": {
    "successful": [
      {
        "id": 456,
        "uploadId": 123,
        "storeName": "Walmart",
        "totalAmount": "45.67",
        "taxAmount": "3.42",
        "transactionDate": "2024-01-15",
        "currency": "USD",
        "status": "processed",
        "imageUrl": "/files/receipt-0-abc123...jpg",
        "keywords": ["grocery", "food"],
        "lineItems": [
          {
            "id": 789,
            "receiptId": 456,
            "description": "Milk 2%",
            "quantity": "1.000",
            "quantityUnit": "pieces",
            "unitPrice": "3.99",
            "keywords": ["dairy", "beverage"]
          },
          {
            "id": 790,
            "receiptId": 456,
            "description": "Bananas",
            "quantity": "2.500",
            "quantityUnit": "kg",
            "unitPrice": "1.99",
            "keywords": ["fruit"]
          },
          {
            "id": 791,
            "receiptId": 456,
            "description": "Orange Juice",
            "quantity": "1.000",
            "quantityUnit": "liters",
            "unitPrice": "4.50",
            "keywords": ["beverage"]
          }
        ]
      }
    ],
    "failed": [],
    "processing": [],
    "all": [...]
  },
  
  "errors": []
}
```

**Response Structure Explained**:

- **`uploadId`**: Unique identifier for this upload
- **`status`**: Overall processing status (`processing`, `completed`, `partly_completed`, `failed`)
- **`images`**: All image URLs organized
  - `original`: The uploaded image file
  - `marked`: Image with red rectangles showing detected receipt boundaries
  - `splitReceipts`: Array of individual receipt images extracted
- **`statistics`**: Quick processing overview
  - `totalDetected`: Total receipts found in the image
  - `successful`: Successfully processed receipts
  - `failed`: Receipts that failed processing
  - `processing`: Receipts still being processed
- **`message`**: Dynamic human-readable status message
- **`receipts`**: Receipts organized by processing status
  - `successful[]`: Successfully processed receipts with full data
  - `failed[]`: Failed receipts with error information
  - `processing[]`: Receipts currently being processed
  - `all[]`: All receipts in one array for convenience
- **`errors[]`**: Array of processing errors with details

**Use Cases**:
- Display upload overview dashboard
- Show processing progress with real-time updates
- Display marked image with detection visualization
- List all receipts with thumbnails and status
- Show detailed success/failure statistics
- Monitor processing status for async operations

**Error Responses**:
- `400 Bad Request`: Invalid upload ID
- `401 Unauthorized`: Not authenticated
- `403 Forbidden`: Upload belongs to another user
- `404 Not Found`: Upload not found

---

### 8. Get Individual Receipt by ID

**GET** `/api/receipts/:uploadId/receipt/:receiptId`

Retrieve a specific receipt with all its line items, including currency and quantity unit information.

**Authentication**: Required (JWT Access Token)

**URL Parameters**:
- `uploadId`: The ID of the parent receipt upload
- `receiptId`: The ID of the specific receipt

**Response**: `200 OK`
```json
{
  "id": 456,
  "uploadId": 123,
  "storeName": "Walmart",
  "totalAmount": "45.67",
  "taxAmount": "3.42",
  "transactionDate": "2024-01-15",
  "currency": "USD",
  "status": "processed",
  "imageUrl": "/files/receipt-0-abc123...jpg",
  "keywords": ["grocery", "food"],
  "lineItems": [
    {
      "id": 789,
      "receiptId": 456,
      "description": "Milk 2%",
      "quantity": "1.000",
      "quantityUnit": "pieces",
      "unitPrice": "3.99",
      "keywords": ["dairy", "beverage"]
    },
    {
      "id": 790,
      "receiptId": 456,
      "description": "Organic Bananas",
      "quantity": "2.500",
      "quantityUnit": "kg",
      "unitPrice": "1.99",
      "keywords": ["fruit", "organic"]
    },
    {
      "id": 791,
      "receiptId": 456,
      "description": "Orange Juice",
      "quantity": "1.500",
      "quantityUnit": "liters",
      "unitPrice": "4.50",
      "keywords": ["beverage", "juice"]
    }
  ]
}
```

**Use Cases**:
- View detailed information for a specific receipt
- Display receipt image alongside extracted data
- Show itemized breakdown with units and pricing
- Verify or edit receipt information
- Calculate totals with proper unit awareness

**Error Responses**:
- `400 Bad Request`: Invalid ID or receipt doesn't belong to upload
- `401 Unauthorized`: Not authenticated
- `403 Forbidden`: Upload belongs to another user
- `404 Not Found`: Upload or receipt not found

---

### 9. Re-trigger Receipt Processing

**POST** `/api/receipts/:uploadId/reprocess`

**Description**: Re-triggers the processing pipeline for an existing receipt upload. This endpoint allows users to reprocess receipts when initial processing failed, returned incorrect results, or when they want to leverage updated AI models.

**Authentication**: Required (JWT Access Token)

**URL Parameters**:
- `uploadId` (integer): The ID of the receipt upload to reprocess

**Request Body**: None required

**Processing Behavior**:
1. Validates that the upload exists and belongs to the authenticated user
2. Deletes all existing receipts, line items, and processing errors associated with this upload
3. Resets the upload record:
   - Sets status to `processing`
   - Clears `markedImageUrl` (will be regenerated)
   - Resets `hasReceipts` flag
   - Updates `updatedAt` timestamp
4. Queues a new background processing job using the original uploaded image
5. Returns immediately with 202 Accepted (processing happens asynchronously)

**Response**: `202 Accepted`
```json
{
  "uploadId": 123,
  "message": "Receipt reprocessing has been queued.",
  "statusUrl": "/receipts/123"
}
```

**Usage Flow**:
```
1. POST /api/receipts/123/reprocess
   → Returns 202 Accepted immediately
   
2. Poll GET /api/receipts/123 to monitor progress
   → Check status field: 'processing' | 'completed' | 'failed'
   
3. When status becomes 'completed', fetch the new results
   → New receipts and line items available
```

**Use Cases**:
- **Failed Processing**: Retry when initial processing encountered errors
- **Incorrect Results**: Reprocess if AI extracted wrong data (user feedback)
- **Model Updates**: Reprocess with improved AI models or detection algorithms
- **Quality Issues**: Retry after original processing returned poor quality results

**Important Notes**:
- The original uploaded image file is preserved and reused for reprocessing
- All previous receipt data (receipts, line items, errors) is permanently deleted
- The operation is idempotent - safe to call multiple times
- Processing happens asynchronously in a background worker queue
- Users can only reprocess their own uploads (enforced by authentication)

**Error Responses**:
- `400 Bad Request`: Invalid upload ID format
- `401 Unauthorized`: Missing or invalid authentication token
- `403 Forbidden`: Upload belongs to another user
- `404 Not Found`: Upload not found

**Example Request**:
```bash
curl -X POST http://localhost:3000/api/receipts/123/reprocess \
  -H "Authorization: Bearer <your_access_token>"
```

**Example Response**:
```json
{
  "uploadId": 123,
  "message": "Receipt reprocessing has been queued.",
  "statusUrl": "/receipts/123"
}
```

---

### 10. Get Receipt/Upload Image File

**GET** `/api/files/:filename`

Retrieve an uploaded image file (original, marked, or individual receipt images).

**Authentication**: Required (JWT Access Token or API Key)

**URL Parameters**:
- `filename`: The filename from any `imageUrl` field (e.g., `abc123...jpg`)

**Response**: `200 OK`
- **Content-Type**: `image/jpeg`, `image/png`, etc.
- **Body**: Binary image data (file stream)

**Authorization Rules**:
- Users can only access files from their own uploads/receipts
- Internal services with valid API key can access any file

**Error Responses**:
- `401 Unauthorized`: Not authenticated
- `403 Forbidden`: File belongs to another user
- `404 Not Found`: File not found

**Note**: Since this endpoint requires authentication, you cannot use `<img src="...">` directly in HTML. See implementation notes below.

---

### 10. Export User Receipts to CSV

**GET** `/api/users/me/receipts/export-csv`

Export all processed receipts for the authenticated user as a CSV file.

**Authentication**: Required (JWT Access Token)

**Response**: `200 OK`
- **Content-Type**: `text/csv`
- **Content-Disposition**: `attachment; filename="user_<userId>_receipts_export.csv"`

**CSV Format**:
```csv
Receipt ID,Store Name,Total,Tax,Currency,Date,Item Description,Quantity,Quantity Unit,Unit Price
456,Walmart,45.67,3.42,USD,2024-01-15,Milk 2%,1.000,pieces,3.99
456,Walmart,45.67,3.42,USD,2024-01-15,Bananas,2.500,kg,1.99
457,Target,23.45,1.87,USD,2024-01-16,Coffee,1.000,pieces,12.99
```

**Error Responses**:
- `401 Unauthorized`: Not authenticated
- `404 Not Found`: No receipts found for user

---

## Data Models

### Receipt Upload
```typescript
{
  id: number;
  userId: number;
  originalImageUrl: string;
  markedImageUrl?: string;
  status: 'processing' | 'completed' | 'partly_completed' | 'failed';
  hasReceipts?: 0 | 1;
  createdAt: Date;
  updatedAt: Date;
}
```

### Receipt
```typescript
{
  id: number;
  uploadId: number;
  storeName?: string;
  totalAmount?: number;  // decimal(10,2)
  taxAmount?: number;    // decimal(10,2)
  transactionDate?: Date;
  currency?: string;     // ISO 4217 currency code (e.g., "USD", "EUR", "GBP")
  status: 'pending' | 'processed' | 'failed' | 'unreadable';
  imageUrl?: string;
  keywords?: string[];   // JSON array
  
  // Duplicate detection fields
  isDuplicate?: boolean;
  duplicateOfReceiptId?: number;  // ID of the original receipt
  duplicateConfidenceScore?: number;  // 0-100
  duplicateCheckedAt?: Date;
  duplicateOverride?: boolean;  // User confirmed not a duplicate
}
```

### Line Item ⭐ ENHANCED
```typescript
{
  id: number;
  receiptId: number;
  description: string;
  quantity: number;      // decimal(10,3), default 1.0
  quantityUnit?: string; // e.g., "pieces", "kg", "lbs", "liters", "ml", "oz", "g", "gal"
  unitPrice: number;     // decimal(10,2)
  keywords?: string[];   // JSON array
}
```

---

## Common HTTP Status Codes

- **200 OK**: Request succeeded
- **201 Created**: Resource created successfully
- **204 No Content**: Request succeeded with no response body
- **400 Bad Request**: Invalid request data or validation error
- **401 Unauthorized**: Authentication required or failed
- **403 Forbidden**: Authenticated but not authorized for this resource
- **404 Not Found**: Resource not found
- **409 Conflict**: Resource already exists
- **500 Internal Server Error**: Server error during processing

---

## Error Response Format

All error responses follow this general format:

```json
{
  "error": "Error message here",
  "details": {
    // Optional additional error details
  }
}
```

---

## New Features ⭐

### 1. Currency Detection
- AI automatically detects currency from receipt symbols or store location
- Stored as ISO 4217 code (USD, EUR, GBP, JPY, etc.)
- Defaults to "USD" if not detected
- Accessible via `receipt.currency` field

### 2. Quantity Units
- AI intelligently detects unit of measurement for each item
- Supports:
  - **Weight**: kg, g, lbs, oz
  - **Volume**: liters, ml, gal, fl oz
  - **Count**: pieces, units, ea, pcs
- Defaults to "pieces" if not specified
- Accessible via `lineItem.quantityUnit` field

### 3. Enhanced Item Details
Each line item now includes:
- **Description**: Item name
- **Quantity**: Numeric amount (e.g., 2.500)
- **QuantityUnit**: Unit of measurement (e.g., "kg")
- **UnitPrice**: Price per unit
- **Keywords**: AI-generated categories

**Example Use Cases:**
```
"2.5 kg of bananas at $1.99/kg"
"1 piece of milk at $3.99/piece"
"1.5 liters of juice at $4.50/liter"
```

---

## Implementation Notes for Frontend

### Authentication Flow
1. User registers (`POST /api/users`)
2. User logs in (`POST /api/auth/login`) → receive `accessToken` and `refreshToken` cookie
3. Store `accessToken` in memory (or secure storage)
4. Include `accessToken` in `Authorization: Bearer <token>` header for protected endpoints
5. When `accessToken` expires (401 error), call `POST /api/auth/refresh-token` to get new token
6. On logout, call `POST /api/auth/logout` to invalidate refresh token

### File Upload Flow
1. User selects image file
2. Create `FormData` and append file
3. POST to `/api/image/split-and-analyze` with Bearer token
4. Show loading state during processing
5. Display results with image URLs
6. Use `/api/files/:filename` to display images with Bearer token in header

### Image Display with Authentication
Since `/api/files/:filename` requires authentication, you cannot use `<img src="...">` directly. Options:

**Option A**: Fetch and create object URL
```javascript
const response = await fetch('/api/files/abc123.jpg', {
  headers: { 'Authorization': `Bearer ${accessToken}` }
});
const blob = await response.blob();
const imageUrl = URL.createObjectURL(blob);
// Use imageUrl in <img src={imageUrl} />
// Remember to revoke: URL.revokeObjectURL(imageUrl)
```

**Option B**: Use proxy or API gateway to handle authentication

### CORS Considerations
Ensure your API allows cross-origin requests from your frontend domain in production.

### Cookie Configuration
The refresh token cookie requires:
- Your frontend must be on the same domain (or subdomain with proper cookie settings)
- Use `credentials: 'include'` in fetch requests to send cookies
- In development, you may need to configure proxy or use same origin

---

## Example: Complete JavaScript Implementation

```javascript
// Register
async function register(email, password) {
  const response = await fetch('/api/users', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password })
  });
  return await response.json();
}

// Login
async function login(email, password) {
  const response = await fetch('/api/auth/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    credentials: 'include', // Important for cookie
    body: JSON.stringify({ email, password })
  });
  const data = await response.json();
  return data.accessToken;
}

// Refresh token
async function refreshAccessToken() {
  const response = await fetch('/api/auth/refresh-token', {
    method: 'POST',
    credentials: 'include' // Send cookie
  });
  const data = await response.json();
  return data.accessToken;
}

// Upload receipt
async function uploadReceipt(file, accessToken) {
  const formData = new FormData();
  formData.append('file', file);
  
  const response = await fetch('/api/image/split-and-analyze', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${accessToken}`
    },
    body: formData
  });
  return await response.json();
}

// Get upload details with all receipts
async function getUploadDetails(uploadId, accessToken) {
  const response = await fetch(`/api/receipts/${uploadId}`, {
    headers: {
      'Authorization': `Bearer ${accessToken}`
    }
  });
  return await response.json();
}

// Display image with authentication
async function displayImage(imageUrl, accessToken) {
  const response = await fetch(imageUrl, {
    headers: {
      'Authorization': `Bearer ${accessToken}`
    }
  });
  const blob = await response.blob();
  const objectUrl = URL.createObjectURL(blob);
  
  // Use in img tag
  const img = document.createElement('img');
  img.src = objectUrl;
  document.body.appendChild(img);
  
  // Clean up when done
  img.onload = () => URL.revokeObjectURL(objectUrl);
}

// Logout
async function logout(accessToken) {
  await fetch('/api/auth/logout', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${accessToken}`
    },
    credentials: 'include'
  });
}
```

---

## Example: Receipt Upload Workflow

```javascript
// Complete workflow example
async function handleReceiptUpload(file) {
  try {
    // 1. Upload and process
    const result = await uploadReceipt(file, accessToken);
    console.log('Upload ID:', result.uploadId);
    
    // 2. Get comprehensive details
    const details = await getUploadDetails(result.uploadId, accessToken);
    
    // 3. Display statistics
    console.log(`Detected: ${details.statistics.totalDetected} receipts`);
    console.log(`Successful: ${details.statistics.successful}`);
    console.log(`Failed: ${details.statistics.failed}`);
    
    // 4. Show marked image with rectangles
    await displayImage(details.images.marked, accessToken);
    
    // 5. Process successful receipts
    for (const receipt of details.receipts.successful) {
      console.log(`Store: ${receipt.storeName}`);
      console.log(`Total: ${receipt.totalAmount} ${receipt.currency}`);
      
      // Display line items with units
      receipt.lineItems.forEach(item => {
        console.log(`- ${item.description}: ${item.quantity} ${item.quantityUnit} @ ${item.unitPrice} each`);
      });
    }
    
  } catch (error) {
    console.error('Upload failed:', error);
  }
}
```

---

## TypeScript Types

```typescript
interface ReceiptUpload {
  uploadId: number;
  userId: number;
  status: 'processing' | 'completed' | 'partly_completed' | 'failed';
  hasReceipts: boolean;
  createdAt: string;
  updatedAt: string;
  images: {
    original: string;
    marked: string | null;
    splitReceipts: string[];
  };
  statistics: {
    totalDetected: number;
    successful: number;
    failed: number;
    processing: number;
  };
  message: string;
  receipts: {
    successful: Receipt[];
    failed: Receipt[];
    processing: Receipt[];
    all: Receipt[];
  };
  errors: ProcessingError[];
}

interface Receipt {
  id: number;
  uploadId: number;
  storeName: string | null;
  totalAmount: string | null;
  taxAmount: string | null;
  transactionDate: string | null;
  currency: string | null;
  status: 'pending' | 'processed' | 'failed' | 'unreadable';
  imageUrl: string | null;
  keywords: string[] | null;
  lineItems: LineItem[];
}

interface LineItem {
  id: number;
  receiptId: number;
  description: string;
  quantity: string;
  quantityUnit: string | null;
  unitPrice: string;
  keywords: string[] | null;
}

interface ProcessingError {
  id: number;
  uploadId: number;
  receiptId: number | null;
  category: 'IMAGE_QUALITY' | 'EXTRACTION_FAILURE' | 'SYSTEM_ERROR';
  message: string | null;
  metadata: any;
  createdAt: string;
}
```

---

## Database Schema

The database has been updated with the following new fields:

**`receipts` table:**
- Added `currency` (varchar 10) - ISO 4217 currency code

**`line_items` table:**
- Added `quantity_unit` (varchar 50) - Unit of measurement

To apply the migration:
```bash
npm run db:migrate
```

---

## Support

For questions or issues:
- Check the README.md for setup instructions
- Review the testing_endpoints.md for examples
- Contact the development team

---

## Duplicate Detection ⭐ NEW

### Overview
Every receipt is automatically checked for duplicates against existing receipts from the same user. This prevents accidental reprocessing of the same receipt and maintains data integrity.

### How It Works

**Multi-Factor Fuzzy Matching**:
- **Store Name** (30 points max): Levenshtein distance for fuzzy matching
- **Total Amount** (25 points max): Exact or near-exact match
- **Transaction Date** (20 points max): Same day or ±1-3 days (handles OCR errors)
- **Item Count** (15 points max): Number of line items
- **Tax Amount** (10 points max): Exact or near-exact match

**Confidence Scoring**:
- **95-100%**: DEFINITE_DUPLICATE - Auto-flagged, very high confidence
- **85-94%**: LIKELY_DUPLICATE - Requires user review
- **70-84%**: POSSIBLE_DUPLICATE - Warning shown to user
- **50-69%**: UNCERTAIN - Logged for analysis
- **0-49%**: NOT_DUPLICATE - Different receipt

### API Response Structure

When duplicates are detected during upload, the response includes a `duplicate_warnings` array:

```json
{
  "uploadId": 123,
  "message": "Processing complete. 2 succeeded, 0 failed. 1 potential duplicate(s) detected.",
  "duplicate_warnings": [
    {
      "receiptId": 456,
      "imageUrl": "/files/receipt-0-abc123.jpg",
      "confidenceScore": 92,
      "confidenceLevel": "LIKELY_DUPLICATE",
      "matchedAgainst": {
        "receiptId": 234,
        "storeName": "Walmart",
        "totalAmount": "45.67",
        "transactionDate": "2024-01-15"
      },
      "matchFactors": {
        "storeName": { "score": 30, "similarity": 100 },
        "totalAmount": { "score": 25, "difference": 0 },
        "date": { "score": 20, "daysDifference": 0 },
        "itemCount": { "score": 15, "difference": 0 },
        "taxAmount": { "score": 2, "difference": 0.01 }
      },
      "recommendation": "This receipt appears to be a duplicate. Please review before confirming."
    }
  ]
}
```

### Receipt Fields

When querying receipts, duplicate information is included:

```json
{
  "id": 456,
  "storeName": "Walmart",
  "totalAmount": "45.67",
  "isDuplicate": true,
  "duplicateOfReceiptId": 234,
  "duplicateConfidenceScore": 92.00,
  "duplicateCheckedAt": "2024-01-15T10:30:15.000Z",
  "duplicateOverride": false
}
```

### Handling OCR Errors

The system intelligently handles common OCR errors:

**Store Name Variations**:
- "Walmart" vs "Wal-Mart" → 95% similarity
- "Walmart" vs "Walmar" (blurred 't') → 85% similarity
- Normalizes spaces, punctuation, case

**Date Misreads**:
- ±1 day difference still scores high (potential digit misread: 3 vs 8, 1 vs 7)
- ±2-3 days scores medium

**Amount Rounding**:
- $0.01 difference: likely rounding or OCR error
- $0.10 difference: possible partial match

### Edge Cases

**Same Store, Same Day, Different Transactions**:
- System checks item count and amounts
- Different totals = lower duplicate score
- User can mark as legitimate separate transaction

**Recurring Purchases**:
- Same store, same total (e.g., daily coffee)
- Different dates = low duplicate score
- Treated as separate transactions

**Chain Store Variations**:
- "Walmart Supercenter #123" vs "Walmart"
- Normalized for better matching

### User Actions

Frontend should provide options when duplicates are detected:

1. **View Comparison**: Show side-by-side comparison
2. **Confirm Duplicate**: Skip processing, link to original
3. **Override**: Process anyway, mark as intentional duplicate
4. **Report Error**: Flag incorrect duplicate detection

### Performance

- Only checks receipts from the last 30 days (configurable)
- Only compares within same user's receipts (privacy)
- Indexed database queries for fast lookup
- Async processing doesn't block response

### Database Tables

**`receipts` table** - Added fields:
- `is_duplicate` (boolean)
- `duplicate_of_receipt_id` (int)
- `duplicate_confidence_score` (decimal 5,2)
- `duplicate_checked_at` (timestamp)
- `duplicate_override` (boolean)

**`duplicate_matches` table** - New table:
- Tracks all potential duplicate matches
- Stores confidence scores and match factors
- Records user actions (confirmed, override, pending)

### Example Use Cases

**1. Same receipt uploaded twice**:
```
Confidence: 100%
Action: Auto-flag as DEFINITE_DUPLICATE
```

**2. Blurred store name, same date and total**:
```
Confidence: 88%
Action: Flag as LIKELY_DUPLICATE, show to user
```

**3. Same store, same day, different amounts**:
```
Confidence: 45%
Action: Treated as separate transactions
```

**4. OCR misread date by 1 digit**:
```
Date: 2024-01-15 vs 2024-01-16
Total: $45.67 vs $45.67
Store: Walmart vs Walmart
Confidence: 90%
Action: Flag as LIKELY_DUPLICATE
```

### Testing

To test duplicate detection:
1. Upload a receipt
2. Upload the same receipt again
3. Check response for `duplicate_warnings`
4. Query the receipt to see `isDuplicate: true`

### Future Enhancements

- Image similarity comparison (perceptual hashing)
- Machine learning for pattern detection
- Bulk import duplicate checking
- Receipt grouping (returns, split payments)

