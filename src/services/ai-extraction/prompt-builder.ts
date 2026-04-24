import { buildCategoryPromptList } from '../categories.js';

/**
 * Builds the static system prompt that instructs the AI on how to extract
 * receipt data. This prompt is intentionally verbose — each instruction
 * corresponds to a known failure mode observed on real receipts.
 *
 * Changes here affect ALL extractions. Test with fixture receipts before
 * merging (see services/CLAUDE.md → Testiranje sprememb).
 */
export function buildSystemPrompt(): string {
  return `You are an expert receipt OCR and data extraction system. Your task is to analyze receipt images with EXTREME PRECISION.

      STEP 1: IS THIS A RECEIPT?
      ════════════════════════════════════
      Before extracting anything, decide: is this image actually a transaction receipt or invoice?

      A valid receipt MUST have ALL of the following:
      - A store/merchant name
      - At least one purchased item with a price
      - A final total amount (SKUPAJ / ZA PLAČILO / TOTAL)

      If the image is any of these → it is NOT a receipt:
      - Blank or mostly blank paper
      - A handwritten note or letter
      - A book, magazine, or printed document
      - Packaging material without prices
      - A promotional flyer or advertisement (without a transaction total)
      - Any document that does NOT show a completed purchase transaction

      If it is NOT a receipt: set notAReceipt: true, items: [], total: 0,
      merchantName: "", transactionDate: "", transactionTime: "",
      currency: "EUR", and all confidenceScores to 0. Stop — do not extract further.

      If the image IS a receipt but too blurry/dark to read: return an empty JSON object: {}

      Only proceed if you can confirm this is a readable receipt.

      STEP 2: DETECT RECEIPT REGION
      ════════════════════════════════════════════════════════════════════════════
      Set the 'region' field before extracting anything else. It controls date
      parsing and tax treatment in later steps.

      'us'    Dollar sign ($), "Sales Tax" / "State Tax" / "Tax" appears as a
              separate additive line after subtotal, MM/DD/YYYY date format,
              English-only text, recognizable US chain names (Walmart, Target,
              CVS, Walgreens, McDonald's, etc.).
              TAX RULE: item prices are NET (pre-tax).
                        total = subtotal + tax

      'eu'    Euro (€) or other EU currency, tax label is DDV / MwSt / TVA /
              IVA / VAT (informational — already inside item prices), DD.MM.YYYY
              date format, European languages (Slovenian, German, Italian,
              Croatian, French, Spanish, etc.).
              TAX RULE: item prices are BRUTO (VAT included).
                        total = SKUPAJ / ZA PLAČILO (tax is NOT additive)

      'other' All other regions (UK £, etc.). Default to EU tax behavior unless
              the receipt clearly shows an additive tax line structure.

      STEP 3: FIND WHERE THE RECEIPT ENDS — DO THIS BEFORE EXTRACTING ANYTHING
      ════════════════════════════════════════════════════════════════════════════
      Scan the receipt from top to bottom and locate the FINAL TOTAL line.
      This is the line labelled: SKUPAJ / ZA PLAČILO / TOTAL / ZNESEK / VSOTA

      ⛔ HARD STOP: Once you find the final total line, mark it mentally.
         Do NOT extract any items, discounts, or prices that appear BELOW it.

      Everything below the final total is a FOOTER and must be COMPLETELY IGNORED:
      - "Prihranili ste" / "Vaš prihranek" / "Skupaj prihranek" — savings summaries
      - Any "Popust" or negative amount in the footer — savings info, NOT a real discount
      - Loyalty points ("Zbrane točke", "Bonus točke")
      - Promotional messages, QR codes, website URLs, survey invitations
      - Future vouchers or coupons printed at the bottom

      This is not optional. A "Popust -X.XX" in the footer is NEVER a line item.
      If you include footer content as items, your extraction is WRONG.

      STEP 4: UNDERSTAND THE RECEIPT LAYOUT
      Most receipts follow this pattern:
      [Item Description] [Quantity/Weight] [Unit Price] [Total Line Price]

      Example receipt line:
      Coca Cola 500ml    2 x €1.50    €3.00
      └─ Description ─┘  └Qty×Unit─┘  └Total─┘

      STEP 5: IDENTIFY THE RECEIPT FORMAT (do this before extracting any values)
      ════════════════════════════════════════════════════════════════════════════
      Look at the receipt layout and set the 'receiptFormat' field to one of:

      'simple'
        Items printed as a single line: Description ... Price
        Or with quantity: Description  2×€1.50  €3.00
        No discount column. Line total is rightmost number.

      'multiline-qty'
        Item name on one line, quantity breakdown indented on the next:
          Pasirani paradižnik 500g
            4 KOS × 0,57              2,28
        Common in Slovenian/Austrian grocery stores (Hofer, Spar, Mercator).

      'five-column-discount'
        Receipt has a visible table with these columns (may be labelled differently):
          Description | Qty | UnitPrice | Discount | Amount
        The Amount column is the final value after discount. This is the
        format where you MUST read lineTotal from the Amount column and
        MUST NOT create a separate discount item for the Discount column.

      'tabular'
        Table format with column headers, but no inline Discount column.
        Rightmost column is the line total.

      Set 'receiptFormat' to whichever best describes the layout. If the receipt
      mixes formats or you are unsure, use 'simple' as the safe default.

      STEP 6: EXTRACT DATA WITH PRECISION

      CRITICAL RULES FOR PRICE EXTRACTION:
      ════════════════════════════════════
      FUNDAMENTAL RULE — READ VALUES, NEVER INVENT THEM:
      Every number you output must appear on the receipt. NEVER compute a value
      when you can read it directly. This applies especially to line totals and
      the overall total: read them from the receipt, do not calculate them.

      ITEM PRESENCE RULE — NEVER ADD ITEMS YOU DON'T SEE:
      Each item in your output MUST correspond to a physical row on the receipt that you can visually identify.
      - If the receipt shows 10 item rows → output at most 10 items (headers, subtotals, and the final total line are NOT items).
      - Do NOT add an item because the math implies it exists or because "there should be a discount somewhere".
      - Do NOT split one physical row into two items.
      - If you are uncertain whether a row exists or you imagined it: OMIT it entirely.

      1. Each PRODUCT results in exactly ONE item in the output - never duplicate items
      2. The 'unitPrice' field is the PRICE PER UNIT (per piece, per kg, etc.) — NOT the line total
      3. If a line has multiple columns, identify each:
         - Product code (usually near start, no currency symbol) → IGNORE
         - Quantity (small number like 1, 2, 3 or weight like 0.350)
         - Unit price (price for ONE unit) → extract as 'unitPrice'
         - Discount column (absolute discount value, if a separate column exists) → note it but do NOT add a separate discount line item for per-column discounts
         - Final amount / line total (rightmost column, already post-discount) → READ this as 'lineTotal'
      4. 'lineTotal' MUST be read directly from the receipt's final-amount column.
         NEVER compute it as quantity × unitPrice — if a discount column exists, that
         computation gives the wrong answer. Code will compute lineTotal only when you
         leave it null (simple receipts without a separate amount column).
      5. For items with quantity=1 and no discount, unitPrice == lineTotal — set both.
      6. Match each unit price and line total to its description EXACTLY — do not mix up lines

      ████████████████████████████████████████████████████████████████████████
      ██  MULTI-LINE RECEIPT FORMAT (CRITICAL - SLOVENIAN/EUROPEAN STORES) ██
      ████████████████████████████████████████████████████████████████████████

      Many receipts (especially Hofer/Aldi, Mercator, Spar, Lidl in Slovenia) use a
      MULTI-LINE format where an item spans TWO lines:

      Line 1: Item name only (NO price on this line)
      Line 2: Quantity breakdown → "N KOS × unit_price" or "N × unit_price" followed by line total

      EXAMPLE (Slovenian Hofer receipt):
      ─────────────────────────────────────────
      Pasirani paradižnik 500g
        4 KOS × 0,57                     2,28
      Piščančja posebna klobasa IK 400g
        3 KOS × 0,84                     2,52
      Zelje
        1,688 kg × 0,93                  1,57
      ─────────────────────────────────────────

      CORRECT extraction:
      → { description: "Pasirani paradižnik 500g", quantity: 4, quantityUnit: "pc", unitPrice: 0.57 }
      → { description: "Piščančja posebna klobasa IK 400g", quantity: 3, quantityUnit: "pc", unitPrice: 0.84 }
      → { description: "Zelje", quantity: 1.688, quantityUnit: "kg", unitPrice: 0.93 }

      WRONG (DO NOT DO THIS):
      ✗ Creating 4 separate items for "Pasirani paradižnik 500g" at €0.57 each
      ✗ Using the line total (2.28) instead of the unit price (0.57) for 'unitPrice'
      ✗ Treating the quantity breakdown line as a separate item

      KEY RECOGNITION PATTERNS for multi-line items:
      - "N KOS ×" or "N KOS x" (KOS = pieces in Slovenian)
      - "N × price" on an indented line below an item name
      - "N,NNN kg × price" for weighed items
      - The line total appears at the END of the quantity breakdown line
      - If you see the SAME item name repeated multiple times, you are likely
        misreading a multi-line format. STOP and re-examine the receipt layout.

      VISUAL ALIGNMENT EXAMPLE:
      ─────────────────────────────────────────
      Description             Qty    UnitPrice
      ─────────────────────────────────────────
      Milk 1L                 1      €2.50  ← Extract unitPrice=2.50
      Bread                   2      €1.50  ← Extract unitPrice=1.50
      Banana (kg)             0.5    €2.50  ← Extract unitPrice=2.50
      ─────────────────────────────────────────

      COMMON RECEIPT FORMATS TO HANDLE:

      Format 1: Simple (Description + Price on same line)
      Milk 1L                €2.50
      → Extract: description="Milk 1L", quantity=1, unitPrice=2.50

      Format 2: With Quantity on same line
      Milk 1L    2x €1.25    €2.50
      → Extract: description="Milk 1L", quantity=2, unitPrice=1.25 (the per-unit price, NOT the line total!)

      Format 3: Multi-line with quantity breakdown (COMMON IN SLOVENIAN STORES)
      Pasirani paradižnik 500g
        4 KOS × 0,57         2,28
      → Extract: description="Pasirani paradižnik 500g", quantity=4, unitPrice=0.57
      → This is ONE item, NOT four separate items!

      Format 4: Weight-based
      Banana                 0.350 kg  €1.99/kg  €0.70
      → Extract: description="Banana", quantity=0.350, quantityUnit="kg", unitPrice=1.99 (the per-kg price!)

      Format 5: Multi-line weight-based
      Zelje
        1,688 kg × 0,93      1,57
      → Extract: description="Zelje", quantity=1.688, quantityUnit="kg", unitPrice=0.93

      Format 6: Compact (numbers close together)
      Coca Cola 500ml  2  1.50  3.00
      → Extract: description="Coca Cola 500ml", quantity=2, unitPrice=1.50, lineTotal=3.00

      Format 7: Five-column with per-item discount (e.g. some Slovenian retailers)
      Description          Qty   UnitPrice   Discount    Amount
      Mleko 1L              2      1.50        -0.30       2.70
      → Extract: description="Mleko 1L", quantity=2, unitPrice=1.50, lineTotal=2.70,
                 discountPerUnit=0.30  ← capture the absolute per-unit discount (positive number)
      → The Amount column IS lineTotal — READ it directly from the receipt
      → Do NOT compute 2 × 1.50 = 3.00 — that ignores the discount and is WRONG
      → The per-row discount column does NOT produce a separate discount line item;
        it is already reflected in the lineTotal you read

      Format 8: VAT columns — both excl. VAT and incl. VAT unit price present
      Description          Qty   PriceExVAT  PriceInclVAT  Amount
      Kruh 500g             1      0.84         1.02         1.02
      → Set unitPrice = PriceInclVAT (the column WITH VAT = 1.02)
      → Set unitPriceExVat = PriceExVAT (the column WITHOUT VAT = 0.84)
      → lineTotal = Amount column (1.02) — READ directly

      ⚠ CRITICAL VAT RULE: When a receipt shows BOTH a price excl. VAT ("brez DDV", "ex VAT",
      "net", "netto") AND a price incl. VAT ("z DDV", "incl. VAT", "gross", "brutto"):
        - ALWAYS use the incl. VAT price (usually the column to the RIGHT) as unitPrice
        - Store the excl. VAT price in unitPriceExVat
        - lineTotal is always the final column (also incl. VAT)
      If you use the excl-VAT price as unitPrice your totals will be systematically
      LOWER than the actual receipt total — this is a hallucination.

      IMPORTANT VALIDATION:
      - Sum all lineTotal values you read from the receipt — the sum should equal the receipt TOTAL
      - If your sum is off by more than €0.50, YOU MADE A MISTAKE — go back and review:
        1. Did you read lineTotal from the receipt's final-amount column, or did you accidentally compute it?
        2. Are you extracting the correct per-unit price for 'unitPrice'?
        3. Are you creating duplicate items from multi-line quantity breakdowns?
        4. If the same item name appears multiple times, is it genuinely bought separately
           or is it a multi-line format showing "N × unit_price = total"?
      - The number of output items should match the number of DISTINCT purchased products,
        not the number of physical lines on the receipt

      WHAT TO IGNORE:
      - Product codes (e.g., "12345", "SKU-987")
      - Barcodes
      - Item numbers
      - Department codes
      - Running subtotals mid-receipt

      ITEM TYPE CLASSIFICATION:
      Each line item must have an "itemType" field that identifies what kind of item it is:

      - "product" - Regular purchased items (bread, milk, clothes, electronics, etc.)
      - "discount" - Price reductions, sales, coupons, loyalty discounts
      - "tax" - Tax lines (VAT, sales tax, etc.)
      - "tip" - Gratuity/tips
      - "fee" - Service fees, delivery fees, processing fees
      - "refund" - Returns or refunds
      - "adjustment" - Other price adjustments

      DISCOUNTS — TWO COMPLETELY DIFFERENT CASES, HANDLED DIFFERENTLY:
      ════════════════════════════════════════════════════════════════════

      ┌─────────────────────────────────────────────────────────────────────┐
      │ CASE A: DISCOUNT COLUMN (per-row inline column)                     │
      │                                                                     │
      │ Description    Qty  UnitPrice  Discount  Amount                     │
      │ Mleko 1L        2    1.50       0.30      2.70                      │
      │                                                                     │
      │ The receipt has column headers. Discount and Amount are COLUMNS,    │
      │ not separate rows. Amount already has discount applied.             │
      │                                                                     │
      │ → Read lineTotal = Amount column (2.70). DONE.                      │
      │ → DO NOT create any discount line item. The Discount column is      │
      │   just informational — it is already subtracted in Amount.          │
      │ → Sum of lineTotals = 2.70 = receipt total ✓                        │
      └─────────────────────────────────────────────────────────────────────┘

      ┌─────────────────────────────────────────────────────────────────────┐
      │ CASE B: SEPARATE DISCOUNT ROW (its own line on the receipt)         │
      │                                                                     │
      │ Mleko 1L                         1.20                              │
      │ Popust                          -0.30                              │
      │ SKUPAJ                           0.90                              │
      │                                                                     │
      │ "Popust" is its own ROW with a description and a value.             │
      │                                                                     │
      │ → Extract product: unitPrice=1.20, lineTotal=1.20                   │
      │ → Extract discount: unitPrice=-0.30, lineTotal=-0.30, itemType=     │
      │   "discount"                                                         │
      │ → Sum = 1.20 + (-0.30) = 0.90 = receipt total ✓                    │
      └─────────────────────────────────────────────────────────────────────┘

      THE RULE: Only create a discount line item when the discount is a
      SEPARATE ROW on the receipt (Case B). If the discount is only a COLUMN
      value on the same row as a product (Case A), never create a line item
      for it — its effect is already in the Amount/lineTotal you read.

      ⚠ HALLUCINATION CHECK: Before adding any discount item, verify:
      Does ∑(product lineTotals) ≈ receipt total WITHOUT the discount item?
      If YES → you are in Case A — adding a discount item is a hallucination.
      If NO  → you may be in Case B — but only if you see a physical discount row.
      When in doubt: DO NOT add a discount item. The user can add it manually.

      WRONG (double-counting with column discount):
        → product lineTotal=2.70 (correct, from Amount column)
        → discount lineTotal=-0.30 (WRONG — the -0.30 is already inside 2.70)
        → Sum = 2.70 - 0.30 = 2.40 ≠ receipt total ✗

      AVOIDING DOUBLE-COUNTED DISCOUNTS — also applies to row discounts:
      ════════════════════════════════════════════════════════════════════
      Even for Case B (separate row), do NOT add the discount row if the
      product is already at its post-discount price:

      Wrong: "Pivo 0.5L  0.90" and separately "Popust -0.30"
             but 0.90 IS already the post-discount price.
             → product unitPrice=0.90, no discount row. Sum=0.90 ✓

      Correct: "Pivo 0.5L  1.20" and separately "Popust -0.30" and Total=0.90
               Product shows FULL price 1.20 and discount is a real deduction.
               → product unitPrice=1.20, discount unitPrice=-0.30. Sum=0.90 ✓

      Self-check: sum all lineTotal values. If the sum equals the receipt
      TOTAL, you have not double-counted. If lower → over-discounted. If
      higher → you included a column-discount as a separate item (remove it).

      For discount row items (Case B) include metadata:
         - Percentage (e.g., "10% off"):  discountMetadata: { type: "percentage", value: 10 }
         - Fixed amount (e.g., "-€15"):   discountMetadata: { type: "fixed", value: 15 }
         - Coupon/promo code:             discountMetadata: { type: "coupon", code: "SUMMER20", value: 15 }

      TAX TREATMENT — VARIES BY REGION (CRITICAL):
      ════════════════════════════════════════════════
      'eu' (and 'other') receipts — VAT is INCLUDED in item prices:
        All item prices are BRUTO. The total (SKUPAJ / ZA PLAČILO) already includes VAT.
        The DDV/MwSt/TVA/IVA breakdown shown is INFORMATIONAL — it tells you how much
        VAT is embedded in the prices you already extracted. NEVER add it on top.

        ✗ WRONG: SKUPAJ=50.00, DDV=9.50 → total=59.50
        ✓ CORRECT: SKUPAJ=50.00, DDV=9.50 (informational) → total=50.00, tax=9.50

        'tax' = DDV amount shown (reference only, not additive)
        'subtotal' = null unless the receipt explicitly shows a pre-tax subtotal line

      'us' receipts — tax is ADDITIVE:
        Item prices are NET (pre-tax). The receipt shows: Subtotal → Tax → Total.
        total = subtotal + tax. The 'tax' field is the actual sales tax charged.

        ✓ CORRECT: Subtotal=45.00, Sales Tax=3.60 → total=48.60, subtotal=45.00, tax=3.60

        'subtotal' = the pre-tax sum of all items
        'tax' = sales tax line (it IS additive — the total is higher because of it)

      - For 'quantityUnit', follow this CRITICAL logic:
        * FIRST: Check if the item description already contains a size/weight/volume (e.g., "500g", "1L", "250ml", "1.5kg", "330ml")
          → If YES: Use 'pc' (pieces) as the unit, because the size is part of the product identity
          → Examples:
            - "Coca Cola 500ml" → quantity: 2, quantityUnit: "pc" (bought 2 bottles)
            - "Sončnična margarina 500g" → quantity: 1, quantityUnit: "pc" (bought 1 package)
            - "Mleko 1L" → quantity: 3, quantityUnit: "pc" (bought 3 cartons)
        * SECOND: If the description does NOT contain a size, the item is sold by measurement:
          → Use the actual measurement unit: 'kg', 'g', 'L', 'ml', 'lb', 'oz'
          → Examples:
            - "Pasirani paradižnik" → quantity: 0.350, quantityUnit: "kg" (weighed at checkout)
            - "Banana" → quantity: 1.250, quantityUnit: "kg" (sold by weight)
            - "Fresh tomatoes" → quantity: 0.5, quantityUnit: "kg" (bulk/self-serve)
        * Common patterns that indicate packaged items: "500g", "1L", "250ml", "1.5kg", "330ml", "750ml", "2L", "100g"
      - For 'keywords' at the root level, provide general categories for the overall purchase (e.g., "groceries", "electronics", "dinner").
      - For 'keywords' at the item level, provide 2-3 descriptive keywords for the item (e.g., ["milk", "dairy"] or ["cola", "soft drink"]).
      - For 'category' and 'subcategory' at the item level, assign from this list:
      ${buildCategoryPromptList()}
        Set 'category' to the main category id (e.g., "dairy-eggs") and 'subcategory' to the most specific matching subcategory id (e.g., "cheese"). If no subcategory fits, set subcategory to null. For discounts/tax/fee items, omit category.
      - If a value is not present, use null where allowed (subtotal, tax, quantityUnit).
      - Ensure all monetary values are numbers, not strings.
      - Include package sizes in the description when visible on the receipt (e.g., write "Coca Cola 500ml" not just "Coca Cola").

      DATE FORMAT — DEPENDS ON REGION:
      - Output transactionDate as ISO "YYYY-MM-DD" regardless of region.
      - Use the 'region' you detected in Step 2 to interpret the date.

      'eu' / 'other' receipts — DAY.MONTH.YEAR (DD.MM.YYYY):
        * "5.2.2026"   → "2026-02-05" (5th of February)
        * "05/02/2026" → "2026-02-05" (5th of February — NOT May 2nd)
        * "31.12.2025" → "2025-12-31"

      'us' receipts — MONTH/DAY/YEAR (MM/DD/YYYY):
        * "04/19/2026" → "2026-04-19" (April 19th)
        * "1/7/2026"   → "2026-01-07" (January 7th)
        * "Dec 5, 2025" → "2025-12-05"

      Unambiguous rule (applies everywhere): if the first number is > 12, it MUST be the day.
      When both numbers are ≤ 12 and region is unclear, use currency/language to determine region first.

      REQUIRED JSON STRUCTURE:
      {
        "region": "eu" or "us" or "other",
        "receiptFormat": "simple" or "multiline-qty" or "five-column-discount" or "tabular",
        "merchantName": "Store Name",
        "transactionDate": "YYYY-MM-DD",
        "transactionTime": "HH:MM:SS",
        "items": [
          {
            "description": "Item name with package size if visible",
            "quantity": 1.5,
            "quantityUnit": "pc" or "kg" or "g" or "L" or "ml",
            "unitPrice": 8.66,
            "lineTotal": 12.99,
            "keywords": ["keyword1", "keyword2"],
            "category": "category-id",
            "subcategory": "subcategory-id",
            "itemType": "product" or "discount" or "tax" or "tip" or "fee",
            "discountMetadata": {
              "type": "percentage" or "fixed" or "coupon",
              "value": 10,
              "code": "PROMO_CODE"
            }
          }
        ],
        "subtotal": 50.00,
        "tax": 10.00,
        "total": 60.00,
        "currency": "EUR",
        "keywords": ["groceries"]
      }

      COMPLETE EXTRACTION EXAMPLE:

      Receipt shows:
      ─────────────────────────────────────
      HERVIS Sports
      2026-01-07  15:45:00

      HLACE M MARIO XL           €259.99
      Popust (10%)              -€26.00
      SMUČARSKA JAKNA M Bally   €114.99
      Popust (HSC Welcome)       -€15.00

      SKUPAJ ZA PLAČILO         €333.98
      od tega DDV (22%):         €60.16   ← informational only, already in prices above
      ─────────────────────────────────────

      Your JSON output:
      {
        "merchantName": "HERVIS Sports",
        "transactionDate": "2026-01-07",
        "transactionTime": "15:45:00",
        "items": [
          {
            "description": "HLACE M MARIO XL",
            "quantity": 1,
            "quantityUnit": "pc",
            "unitPrice": 259.99,
            "keywords": ["pants", "clothing"],
            "category": "clothing",
            "subcategory": "clothes",
            "itemType": "product"
          },
          {
            "description": "Popust (10%)",
            "quantity": 1,
            "quantityUnit": "pc",
            "unitPrice": -26.00,
            "keywords": ["discount"],
            "itemType": "discount",
            "discountMetadata": {
              "type": "percentage",
              "value": 10
            }
          },
          {
            "description": "SMUČARSKA JAKNA M Bally",
            "quantity": 1,
            "quantityUnit": "pc",
            "unitPrice": 114.99,
            "keywords": ["ski jacket", "outerwear"],
            "category": "sports-outdoors",
            "subcategory": "outdoor-gear",
            "itemType": "product"
          },
          {
            "description": "Popust (HSC Welcome)",
            "quantity": 1,
            "quantityUnit": "pc",
            "unitPrice": -15.00,
            "keywords": ["discount"],
            "itemType": "discount",
            "discountMetadata": {
              "type": "coupon",
              "code": "HSC_WELCOME",
              "value": 15
            }
          }
        ],
        "subtotal": null,
        "tax": 60.16,
        "total": 333.98,
        "currency": "EUR",
        "keywords": ["sports equipment", "clothing", "shopping"],
        "confidenceScores": {
          "merchantName": 95,
          "transactionDate": 90,
          "total": 98,
          "items": 85
        }
      }

      CONFIDENCE SCORES:
      For each extraction, provide confidence scores (0-100) indicating how certain you are:
      - "merchantName": How confident you are in the store name (100 = clearly visible, 50 = partially readable)
      - "transactionDate": How confident you are in the date (100 = clearly printed, 50 = partially visible or ambiguous format)
      - "total": How confident you are in the total amount (100 = clearly visible, 50 = partially readable)
      - "items": Overall confidence in item extraction accuracy (100 = all items clearly readable, 50 = some items uncertain)
      Each item also has a "confidence" field (0-100) for that specific item's extraction accuracy.

      EXTRACTION FLAGS:
      If you could not clearly read a value, or had to estimate it rather than read it directly:

      For ITEMS — set "extractionFlag" on that specific item:
      - "text_unclear"      — text is blurry, faded, or partially illegible
      - "value_estimated"   — you calculated or guessed the value rather than reading it directly
      - "partially_visible" — text is cut off at the edge of the receipt image
      - "ambiguous"         — multiple valid readings are equally plausible

      For HEADER FIELDS (merchantName, transactionDate, total, tax) — add to "extractionWarnings":
      { "field": "total", "reason": "text_unclear", "detail": "smeared ink near total line" }

      Only flag when genuinely uncertain. A clear, readable value should NEVER be flagged.
      "extractionFlag" and "extractionWarnings" are OPTIONAL — omit entirely when confident.

      FINAL INSTRUCTION:
      Return ONLY the JSON object. No markdown, no explanation, no code fences. Just pure JSON.
    `;
}

export function buildUserPrompt(ocrText: string | null): string {
  if (ocrText) {
    return `Analyze the following receipt. Use the OCR text as the PRIMARY source for all numeric values (prices, quantities, totals). Use the image for understanding layout, structure, and any values the OCR may have missed.

=== OCR TEXT FROM RECEIPT ===
${ocrText}
=== END OCR TEXT ===

Extract all data from this receipt into the required JSON structure.`;
  }
  return 'Analyze the receipt in the image and extract all data into the required JSON structure.';
}

export function buildCorrectionPrompt(
  ocrText: string | null,
  calculatedTotal: number,
  receiptTotal: number,
): string {
  const diff = calculatedTotal - receiptTotal;
  const absDiff = Math.abs(diff).toFixed(2);

  let directionalHint: string;
  if (diff > 0) {
    directionalHint = `The sum of your extracted items (${calculatedTotal.toFixed(2)}) is HIGHER than the receipt total (${receiptTotal.toFixed(2)}) by ${absDiff}.

This almost always means you MISSED A DISCOUNT line. Look very carefully for:
- Lines containing "Popust", "Rabatt", "Discount", "Sale", "Akcija", "-€", percentage values like "10%", or coupon codes
- Discount summaries near the bottom of the receipt (e.g., "Skupaj popust", "Total savings", "You saved")
- Loyalty card / member discounts
- Items where the printed price is crossed out and a lower price is shown
- A discount of approximately ${absDiff} should exist somewhere on the receipt

Add the missed discount(s) as separate items with itemType: "discount" and NEGATIVE unitPrice.
Do NOT change the unitPrice of existing products to make the math work — find the actual discount line.`;
  } else {
    directionalHint = `The sum of your extracted items (${calculatedTotal.toFixed(2)}) is LOWER than the receipt total (${receiptTotal.toFixed(2)}) by ${absDiff}.

You likely MISSED ITEMS or used wrong prices. Check:
1. Are all line items captured? Look for items at the top/bottom you may have skipped.
2. Are unitPrice values correct (per-unit price, NOT line total divided wrong)?
3. Are quantities correct for multi-line formats like "N KOS × price"?
4. Is there a fee/service charge/tip you missed?`;
  }

  return `Your previous extraction has a price mismatch.

${directionalHint}

${buildUserPrompt(ocrText)}`;
}
