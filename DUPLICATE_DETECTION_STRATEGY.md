# Receipt Duplicate Detection Strategy

## Overview
Detect duplicate receipts using multi-factor fuzzy matching with confidence scoring to handle OCR errors, blurred images, and AI guessing.

---

## Detection Strategy

### 1. Matching Factors (Weighted Scoring)

Each factor contributes to a confidence score (0-100):

#### **Primary Factors (High Weight)**
- **Store Name Match** (30 points)
  - Exact match: 30 points
  - Fuzzy match (>80% similarity): 20-25 points
  - Partial match (>60% similarity): 10-15 points
  - No match: 0 points

- **Total Amount Match** (25 points)
  - Exact match: 25 points
  - Within $0.01: 23 points
  - Within $0.10: 20 points
  - Within $1.00: 15 points
  - Within $5.00: 10 points
  - Different: 0 points

- **Transaction Date Match** (20 points)
  - Exact match: 20 points
  - 1 day difference: 15 points
  - 2-3 days difference: 10 points
  - >3 days difference: 0 points

#### **Secondary Factors (Medium Weight)**
- **Item Count Match** (15 points)
  - Exact match: 15 points
  - ±1 item: 12 points
  - ±2 items: 8 points
  - ±3 items: 5 points
  - >3 difference: 0 points

- **Tax Amount Match** (10 points)
  - Exact match: 10 points
  - Within $0.01: 8 points
  - Within $0.10: 5 points
  - Different: 0 points

#### **Tertiary Factors (Low Weight)**
- **Transaction Time Match** (optional, if available)
  - Same hour: bonus +5 points
  - Different hour but same day: +2 points

---

## Confidence Thresholds

- **95-100**: DEFINITE_DUPLICATE - Auto-flag, very high confidence
- **85-94**: LIKELY_DUPLICATE - Flag for user review
- **70-84**: POSSIBLE_DUPLICATE - Warn user, show comparison
- **50-69**: UNCERTAIN - Log for analysis, don't flag
- **0-49**: NOT_DUPLICATE - Different receipt

---

## Fuzzy Matching Algorithms

### Store Name Comparison
Use **Levenshtein Distance** with normalization:
```
1. Normalize: lowercase, remove spaces/punctuation
2. Common variations: "walmart" = "wal-mart" = "wal mart"
3. Calculate similarity percentage
4. Apply threshold scoring
```

**Example:**
- "Walmart" vs "Walmart" → 100% (30 points)
- "Walmart" vs "Wal-Mart" → 95% (28 points)
- "Walmart" vs "Walmar" (blurred 't') → 85% (23 points)
- "Walmart" vs "Target" → 0% (0 points)

### Date Handling for OCR Errors
- Allow ±1 day for potential OCR misreads (3 vs 8, 1 vs 7)
- If dates differ by exactly 1 digit in same position → still score high
- Example: "2024-01-15" vs "2024-01-16" → potential OCR error

---

## Detection Workflow

### Step 1: Initial Filter (Fast)
Query existing receipts with:
- Same user ID
- Store name fuzzy match (>60% similarity)
- Date within ±3 days
- Total amount within ±$10

### Step 2: Detailed Comparison (For filtered results)
For each candidate:
1. Calculate store name similarity
2. Compare total amounts
3. Compare dates
4. Count line items
5. Compare tax amounts
6. Calculate confidence score

### Step 3: Result Classification
- Score ≥85: Flag as duplicate
- Score 70-84: Warning to user
- Score <70: Allow processing

### Step 4: User Action Options
For flagged duplicates:
- **View comparison** side-by-side
- **Confirm duplicate** (skip processing)
- **Override** (process anyway, mark as intentional duplicate)
- **Report error** (if wrongly flagged)

---

## Database Schema Requirements

### New Fields for `receipts` table:
- `is_duplicate` (boolean) - Flagged as duplicate
- `duplicate_of_receipt_id` (int, nullable) - References original receipt
- `duplicate_confidence_score` (decimal 5,2) - Confidence percentage
- `duplicate_checked_at` (datetime) - When check was performed
- `duplicate_override` (boolean) - User confirmed it's not a duplicate

### New Table: `duplicate_matches`
```sql
CREATE TABLE duplicate_matches (
  id BIGINT PRIMARY KEY AUTO_INCREMENT,
  receipt_id BIGINT NOT NULL,
  potential_duplicate_id BIGINT NOT NULL,
  confidence_score DECIMAL(5,2) NOT NULL,
  match_factors JSON, -- Details of what matched
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  user_action ENUM('confirmed_duplicate', 'override', 'pending') DEFAULT 'pending',
  INDEX idx_receipt_id (receipt_id),
  INDEX idx_potential_duplicate_id (potential_duplicate_id)
);
```

---

## API Response Enhancements

### Upload Response (when duplicates detected)
```json
{
  "uploadId": 123,
  "message": "Processing complete. 2 succeeded, 0 failed. 1 potential duplicate detected.",
  "successful_receipts": [...],
  "duplicate_warnings": [
    {
      "receiptId": 456,
      "confidenceScore": 92,
      "matchedAgainst": {
        "receiptId": 234,
        "storeName": "Walmart",
        "totalAmount": "45.67",
        "transactionDate": "2024-01-15",
        "processedAt": "2024-01-15T10:30:00Z"
      },
      "matchFactors": {
        "storeName": { "score": 30, "similarity": 100 },
        "totalAmount": { "score": 25, "difference": 0 },
        "date": { "score": 20, "daysDifference": 0 },
        "itemCount": { "score": 15, "difference": 0 },
        "taxAmount": { "score": 10, "difference": 0.01 }
      },
      "status": "LIKELY_DUPLICATE",
      "recommendation": "This receipt appears to be a duplicate. Review before confirming."
    }
  ]
}
```

---

## Edge Cases to Handle

### 1. Same Store, Same Day, Different Transactions
**Scenario**: User shops at Walmart twice in one day
**Solution**: 
- Lower duplicate score if times are >1 hour apart
- Check item descriptions for differences
- If totals are significantly different, lower score

### 2. Split Payments / Partial Returns
**Scenario**: Receipt split into multiple payments
**Solution**:
- Flag as "RELATED_RECEIPT" instead of duplicate
- Check if total amounts are related (e.g., sum = original)

### 3. OCR Misreads on Critical Fields
**Scenario**: Store name partially read, date has 1 digit wrong
**Solution**:
- Use multiple factors - never rely on single field
- If store name uncertain but everything else matches → still flag
- Show confidence breakdown to user

### 4. Recurring Purchases
**Scenario**: Same store, same total (e.g., daily coffee)
**Solution**:
- Date difference is key factor
- If same day → high duplicate score
- If different days → low duplicate score
- Item descriptions can help (same items = routine purchase)

### 5. Chain Store Name Variations
**Scenario**: "Walmart Supercenter #123" vs "Walmart"
**Solution**:
- Normalize store names (remove "supercenter", store numbers, etc.)
- Maintain a mapping of common variations
- "Walmart Supercenter" → "Walmart"

---

## Implementation Priority

### Phase 1 (MVP)
✅ Basic duplicate detection with:
- Store name fuzzy matching
- Total amount comparison
- Date comparison
- Simple confidence scoring

### Phase 2 (Enhanced)
- Item count comparison
- Tax amount comparison
- Store name normalization database
- User override functionality

### Phase 3 (Advanced)
- Transaction time comparison
- Item description similarity
- Machine learning for pattern detection
- Bulk duplicate detection for imports

---

## Performance Considerations

### Optimization Strategies
1. **Index Critical Fields**: store_name, transaction_date, total_amount, user_id
2. **Limit Search Window**: Only check receipts from last 30 days
3. **Batch Processing**: Check duplicates async for large uploads
4. **Caching**: Cache store name normalizations

### Scalability
- For users with 1000s of receipts: partition by date ranges
- Use database full-text search for store names
- Consider Elasticsearch for large-scale fuzzy matching

---

## User Experience

### UI/UX Recommendations
1. **Visual Comparison View**: Show original vs potential duplicate side-by-side
2. **Highlight Differences**: Mark fields that don't match
3. **Quick Actions**: "Yes, skip duplicate" or "No, process anyway"
4. **Confidence Indicator**: Visual badge (🔴 High, 🟡 Medium, 🟢 Low)
5. **History**: Track which receipts were marked as duplicates

---

## Testing Strategy

### Test Cases
1. ✅ Exact duplicate (same receipt uploaded twice)
2. ✅ OCR error in store name (1-2 characters different)
3. ✅ Date off by 1 day (OCR misread)
4. ✅ Total amount within $0.01 (rounding differences)
5. ✅ Same store, same day, different totals (legitimate different transaction)
6. ✅ Same store, different dates (recurring purchase)
7. ✅ Different store, same total (coincidence)
8. ✅ Blurred receipt with multiple uncertain fields

---

## Security & Privacy

- Duplicate checks are **per-user only** (never compare across users)
- Duplicate matching data is tied to user account
- If user deletes original receipt, duplicates are unlinked
- Admin cannot see duplicate relationships across users

---

## Future Enhancements

1. **Image Similarity**: Compare receipt images using perceptual hashing
2. **ML-Based Detection**: Train model on duplicate patterns
3. **Bulk Import Protection**: Check entire CSV import for duplicates
4. **Receipt Grouping**: Group related receipts (returns, split payments)
5. **Smart Notifications**: "You uploaded this receipt 3 days ago"

