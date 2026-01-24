# API Endpoints Quick Reference

## Base URL
- Development: `http://localhost:3000`
- Production: TBD

## Endpoint List

### Authentication & Users
| Method | Endpoint | Auth Required | Description |
|--------|----------|---------------|-------------|
| GET | `/health` | No | Health check |
| POST | `/api/users` | No | Register new user |
| POST | `/api/auth/login` | No | Login (returns JWT + refresh cookie) |
| POST | `/api/auth/refresh-token` | Cookie | Refresh access token |
| POST | `/api/auth/logout` | Yes | Logout user |

### Receipt Processing & Retrieval
| Method | Endpoint | Auth Required | Description |
|--------|----------|---------------|-------------|
| POST | `/api/image/split-and-analyze` | Yes | Upload & process receipt image(s) |
| GET | `/api/receipts/:uploadId` | Yes | Get upload with all receipts & items |
| GET | `/api/receipts/:uploadId/receipt/:receiptId` | Yes | Get specific receipt details |
| POST | `/api/receipts/:uploadId/reprocess` | Yes | Re-trigger processing for an existing upload |

### Files & Export
| Method | Endpoint | Auth Required | Description |
|--------|----------|---------------|-------------|
| GET | `/api/files/:filename` | Yes | Get uploaded image file |
| GET | `/api/users/me/uploads` | Yes | Get all uploads for user (paginated) |
| GET | `/api/users/me/receipts/export-csv` | Yes | Export all receipts as CSV |

---

## Key Workflows

### 1. User Registration & Login
```
1. POST /api/users → Get userId, email, apiKey
2. POST /api/auth/login → Get accessToken (refresh token in cookie)
3. Use accessToken in Authorization: Bearer <token> header
```

### 2. Upload & Process Receipts
```
1. POST /api/image/split-and-analyze (multipart/form-data)
   → Returns uploadId, originalImageUrl, markedImageUrl, receipts[]
   
2. GET /api/receipts/:uploadId (to get comprehensive upload details)
   → Returns complete object with:
     - images: {original, marked, splitReceipts[]}
     - statistics: {totalDetected, successful, failed, processing}
     - receipts: {successful[], failed[], processing[], all[]}
     - errors[], message, status
   
3. GET /api/files/:filename (to display images)
   → Pass filename from imageUrl fields

4. POST /api/receipts/:uploadId/reprocess (to retry failed/incorrect processing)
   → Clears existing receipts and re-queues processing job
   → Returns 202 Accepted with uploadId and statusUrl
```

### 3. View Individual Receipt
```
1. GET /api/receipts/:uploadId/receipt/:receiptId
   → Returns receipt with storeName, total, tax, date, lineItems[]
   
2. GET /api/files/:filename (to display receipt image)
   → Use imageUrl from receipt object
```

### 4. View Upload History
```
GET /api/users/me/uploads
→ Returns paginated list of all user uploads with statistics
→ Query params: ?limit=50&offset=0&sortBy=createdAt&sortOrder=desc&status=completed
```

### 5. Export Data
```
GET /api/users/me/receipts/export-csv
→ Download CSV file with all user receipts
```

---

## Important Notes

### Authentication
- **Access Token**: Short-lived JWT, store in memory/state
- **Refresh Token**: Long-lived, stored in HttpOnly cookie
- When 401 error, call `/api/auth/refresh-token` to get new access token

### File Uploads
- Max size: 10 MB
- Supported formats: JPEG, PNG
- Use `multipart/form-data` with field name `file`

### Image Display
Images require authentication, so you can't use `<img src="...">` directly:
```javascript
// Fetch and create object URL
const response = await fetch(imageUrl, {
  headers: { 'Authorization': `Bearer ${accessToken}` }
});
const blob = await response.blob();
const objectUrl = URL.createObjectURL(blob);
// Use in <img src={objectUrl} />
```

### Receipt Processing
- System automatically detects multiple receipts in one image
- `markedImageUrl` shows detection rectangles (red boxes) around found receipts
- Each receipt is individually analyzed by AI
- Line items extracted include: description, quantity, price, keywords

### Data Format
- All monetary values returned as strings (decimal: "45.67")
- Dates in ISO format: "2024-01-15T10:30:00.000Z"
- Keywords as JSON arrays: ["grocery", "food"]

---

## Response Examples

### Upload Response
```json
{
  "uploadId": 123,
  "originalImageUrl": "/files/abc123.jpg",
  "markedImageUrl": "/files/marked-abc123.jpg",
  "successful_receipts": [{
    "receiptId": 456,
    "imageUrl": "/files/receipt-0-abc123.jpg",
    "data": {
      "merchantName": "Walmart",
      "total": 45.67,
      "items": [...]
    }
  }]
}
```

### Get Upload Response
```json
{
  "uploadId": 123,
  "status": "completed",
  "images": {
    "original": "/files/abc123.jpg",
    "marked": "/files/marked-abc123.jpg",
    "splitReceipts": [
      "/files/receipt-0-abc123.jpg",
      "/files/receipt-1-abc123.jpg"
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
    "successful": [{
      "id": 456,
      "storeName": "Walmart",
      "totalAmount": "45.67",
      "lineItems": [...]
    }],
    "failed": [],
    "processing": [],
    "all": [...]
  }
}
```

---

## Error Handling

| Status | Meaning |
|--------|---------|
| 400 | Bad request / validation error |
| 401 | Not authenticated (missing/invalid token) |
| 403 | Forbidden (accessing another user's data) |
| 404 | Resource not found |
| 409 | Conflict (e.g., user already exists) |
| 500 | Server error |

---

For complete details, see **API_DOCUMENTATION.md**
