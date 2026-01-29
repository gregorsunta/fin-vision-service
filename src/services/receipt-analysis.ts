import { GoogleGenerativeAI, Part } from '@google/generative-ai';

// Updated structure to include keywords, quantity units, and item type
export interface ReceiptItem {
  description: string;
  quantity: number;
  quantityUnit?: string;
  unitPrice: number;
  lineTotal?: number; // Computed after parsing: quantity × unitPrice
  keywords?: string[];

  itemType?: 'product' | 'discount' | 'tax' | 'tip' | 'fee' | 'refund' | 'adjustment';

  discountMetadata?: {
    type?: 'percentage' | 'fixed' | 'coupon' | 'loyalty' | 'promotion';
    value?: number;
    code?: string;
    originalPrice?: number;
  };
}

export interface ValidationIssue {
  severity: 'warning' | 'error';
  type: 'PRICE_MISMATCH' | 'TOTAL_MISMATCH' | 'INVALID_PRICE' | 'UNREALISTIC_PRICE';
  message: string;
  details?: any;
}

export interface ReceiptData {
  merchantName: string;
  transactionDate: string;
  transactionTime: string;
  items: ReceiptItem[];
  subtotal: number | null;
  tax: number | null;
  total: number;
  currency: string;
  keywords?: string[];
  validationIssues?: ValidationIssue[]; // Added by validation
}

export class ReceiptAnalysisService {
  private genAI: GoogleGenerativeAI;
  private readonly GEMINI_API_KEY: string;

  constructor() {
    this.GEMINI_API_KEY = process.env.GEMINI_API_KEY!;
    if (!this.GEMINI_API_KEY) {
      throw new Error('GEMINI_API_KEY is not set in the environment variables');
    }
    this.genAI = new GoogleGenerativeAI(this.GEMINI_API_KEY);
  }

  /**
   * Analyzes a single receipt image and extracts structured data.
   * @param image A Buffer containing the receipt image.
   * @returns A promise that resolves to an array containing a single ReceiptData object.
   */
  public async analyzeReceipts(images: Buffer[]): Promise<ReceiptData[]> {
    if (images.length === 0) {
      return [];
    }
    // This service now processes one image at a time as per the new workflow,
    // but we keep the array input to maintain a consistent interface and handle the single image.
    const image = images[0];

    const model = this.genAI.getGenerativeModel({ model: 'gemini-2.5-flash' });

    const imagePart: Part = {
      inlineData: {
        data: image.toString('base64'),
        mimeType: 'image/jpeg',
      },
    };

    const prompt = `
      You are an expert receipt OCR and data extraction system. Your task is to analyze receipt images with EXTREME PRECISION.
      
      STEP 1: IMAGE QUALITY CHECK
      - If the image is too blurry, dark, or unreadable, return an empty JSON object: {}
      - Only proceed if you can confidently read all text
      
      STEP 2: UNDERSTAND THE RECEIPT LAYOUT
      Most receipts follow this pattern:
      [Item Description] [Quantity/Weight] [Unit Price] [Total Line Price]

      Example receipt line:
      Coca Cola 500ml    2 x €1.50    €3.00
      └─ Description ─┘  └Qty×Unit─┘  └Total─┘

      STEP 3: EXTRACT DATA WITH PRECISION

      CRITICAL RULES FOR PRICE EXTRACTION:
      ════════════════════════════════════
      1. Each PRODUCT results in exactly ONE item in the output - never duplicate items
      2. The 'unitPrice' field is the PRICE PER UNIT (per piece, per kg, etc.) — NOT the line total
      3. If a line has multiple numbers, identify which is:
         - Product code (usually near start, no currency symbol) - IGNORE
         - Quantity (small number like 1, 2, 3 or weight like 0.350)
         - Unit price (the price for ONE unit — THIS IS WHAT YOU EXTRACT as 'unitPrice')
         - Line total (rightmost column — DO NOT extract this; it will be computed in code)
      4. For items with quantity=1, the unit price and line total are the same — extract that number as 'unitPrice'
      5. Match each unit price to its description EXACTLY - do not mix up lines

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
      → Extract: description="Coca Cola 500ml", quantity=2, unitPrice=1.50 (the per-unit price!)
      
      IMPORTANT VALIDATION:
      - After extracting all items, compute each line total as quantity × unitPrice and sum them
      - The sum should equal the receipt TOTAL (not subtotal - item prices include tax)
      - If your sum is off by more than €0.50, YOU MADE A MISTAKE - go back and review:
        1. Are you extracting the correct per-unit price for 'unitPrice'?
        2. Are you creating duplicate items from multi-line quantity breakdowns?
        3. If the same item name appears multiple times, is it genuinely bought separately
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
      
      DISCOUNTS - IMPORTANT:
      When you see discount lines (e.g., "Popust 10%", "DISCOUNT -€2.00", "Rabatt", "Sale"), you MUST:
      1. Set itemType: "discount"
      2. Use negative unitPrice: unitPrice=-2.00 (discounts are always negative)
      3. Include discount metadata:
         - If percentage discount (e.g., "10% off"): 
           discountMetadata: { type: "percentage", value: 10 }
         - If fixed amount discount (e.g., "-€15"):
           discountMetadata: { type: "fixed", value: 15 }
         - If coupon/promo code is visible (e.g., "HSC Welcome", "SUMMER20"):
           discountMetadata: { type: "coupon", code: "HSC_WELCOME", value: 15 }
      
      IMPORTANT: Slovenian receipts often use "Popust" for discounts - always mark these as itemType: "discount"
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
      - For 'keywords' at the item level, provide specific categories for each item (e.g., "fruit", "vegetable", "beverage", "CPU").
      - If a value is not present, use null where allowed (subtotal, tax, quantityUnit).
      - Ensure all monetary values are numbers, not strings.
      - Include package sizes in the description when visible on the receipt (e.g., write "Coca Cola 500ml" not just "Coca Cola").
      
      REQUIRED JSON STRUCTURE:
      {
        "merchantName": "Store Name",
        "transactionDate": "YYYY-MM-DD",
        "transactionTime": "HH:MM:SS",
        "items": [
          {
            "description": "Item name with package size if visible",
            "quantity": 1.5,
            "quantityUnit": "pc" or "kg" or "g" or "L" or "ml",
            "unitPrice": 8.66,
            "keywords": ["category1", "category2"],
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
      
      SUBTOTAL                  €333.98
      TAX (22%)                  €73.48
      TOTAL                     €407.46
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
            "keywords": ["clothing", "pants"],
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
            "keywords": ["clothing", "jacket", "ski"],
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
        "subtotal": 333.98,
        "tax": 73.48,
        "total": 407.46,
        "currency": "EUR",
        "keywords": ["shopping", "sports", "clothing"]
      }
      
      FINAL INSTRUCTION:
      Return ONLY the JSON object. No markdown, no explanation, no code fences. Just pure JSON.
    `;

    try {
      const result = await model.generateContent([prompt, imagePart]);
      const responseText = result.response.text();
      
      // Clean potential markdown fences - handle various formats Gemini might return
      let cleanedText = responseText.trim();
      // Remove markdown code blocks: ```json ... ``` or ```\n ... ```
      cleanedText = cleanedText.replace(/^```(?:json)?\n?/gm, '');
      cleanedText = cleanedText.replace(/\n?```$/gm, '');
      cleanedText = cleanedText.trim();
      
      console.log('Gemini raw response (first 200 chars):', responseText.substring(0, 200));
      console.log('Cleaned text (first 200 chars):', cleanedText.substring(0, 200));
      
      const analysisResult: ReceiptData = JSON.parse(cleanedText);

      // Compute lineTotal from quantity × unitPrice in code
      if (analysisResult.items) {
        for (const item of analysisResult.items) {
          item.lineTotal = Math.round(item.quantity * item.unitPrice * 100) / 100;
        }
      }

      // Validate and log price discrepancies
      this.validatePrices(analysisResult);
      
      // Return as an array to match the expected return type
      return [analysisResult];
    } catch (error) {
      console.error('Error analyzing receipt with Gemini:', error);
      throw new Error('Failed to analyze receipt. The model may have returned an invalid format.');
    }
  }

  /**
   * Validates that the extracted prices make sense and returns validation issues.
   */
  private validatePrices(receipt: ReceiptData): void {
    const issues: ValidationIssue[] = [];
    
    try {
      // Calculate sum of all item line totals
      const calculatedTotal = receipt.items.reduce((sum, item) => sum + (item.lineTotal ?? 0), 0);
      
      // Check if the sum of item prices matches the total (not subtotal - item prices usually include VAT)
      // Allow 0.50 variance for rounding
      const diff = Math.abs(calculatedTotal - receipt.total);
      if (diff > 0.50) {
        const issue: ValidationIssue = {
          severity: 'warning',
          type: 'PRICE_MISMATCH',
          message: `Sum of item prices (${calculatedTotal.toFixed(2)}) differs from receipt total (${receipt.total.toFixed(2)}) by ${diff.toFixed(2)}`,
          details: {
            calculatedTotal: calculatedTotal.toFixed(2),
            receiptTotal: receipt.total.toFixed(2),
            difference: diff.toFixed(2),
            items: receipt.items.map(i => ({ description: i.description, lineTotal: i.lineTotal })),
          },
        };
        issues.push(issue);
        console.warn(`⚠️  Price validation warning: ${issue.message}`);
      }
      
      // Check if total makes sense (subtotal + tax ≈ total)
      if (receipt.subtotal !== null && receipt.tax !== null) {
        const expectedTotal = receipt.subtotal + receipt.tax;
        const totalDiff = Math.abs(expectedTotal - receipt.total);
        if (totalDiff > 0.50) {
          const issue: ValidationIssue = {
            severity: 'warning',
            type: 'TOTAL_MISMATCH',
            message: `Subtotal (${receipt.subtotal.toFixed(2)}) + Tax (${receipt.tax.toFixed(2)}) = ${expectedTotal.toFixed(2)}, but Total is ${receipt.total.toFixed(2)}`,
            details: {
              subtotal: receipt.subtotal,
              tax: receipt.tax,
              expectedTotal: expectedTotal.toFixed(2),
              actualTotal: receipt.total,
              difference: totalDiff.toFixed(2),
            },
          };
          issues.push(issue);
          console.warn(`⚠️  Price validation warning: ${issue.message}`);
        }
      }
      
      // Check for unrealistic or invalid prices
      receipt.items.forEach((item, index) => {
        const lt = item.lineTotal ?? 0;
        const itemType = item.itemType || (lt < 0 ? 'discount' : 'product');

        if (lt === 0) {
          const issue: ValidationIssue = {
            severity: 'error',
            type: 'INVALID_PRICE',
            message: `Item "${item.description}" has a line total of zero.`,
            details: {
              itemIndex: index,
              description: item.description,
              unitPrice: item.unitPrice,
              lineTotal: lt,
              itemType,
            },
          };
          issues.push(issue);
          console.warn(`⚠️  Price validation warning: ${issue.message}`);
        }

        if (lt < 0 && itemType === 'product') {
          const issue: ValidationIssue = {
            severity: 'warning',
            type: 'INVALID_PRICE',
            message: `Item "${item.description}" has a negative line total (${lt}) but is marked as a product. Should be marked as discount/refund.`,
            details: {
              itemIndex: index,
              description: item.description,
              unitPrice: item.unitPrice,
              lineTotal: lt,
              itemType,
            },
          };
          issues.push(issue);
          console.warn(`⚠️  Price validation warning: ${issue.message}`);
        }

        if ((itemType === 'discount' || itemType === 'refund') && lt > 0) {
          const issue: ValidationIssue = {
            severity: 'warning',
            type: 'INVALID_PRICE',
            message: `Item "${item.description}" is marked as ${itemType} but has a positive line total (${lt}). Discounts should be negative.`,
            details: {
              itemIndex: index,
              description: item.description,
              unitPrice: item.unitPrice,
              lineTotal: lt,
              itemType,
            },
          };
          issues.push(issue);
          console.warn(`⚠️  Price validation warning: ${issue.message}`);
        }

        if (itemType === 'product' && lt > 10000) {
          const issue: ValidationIssue = {
            severity: 'warning',
            type: 'UNREALISTIC_PRICE',
            message: `Item "${item.description}" has an unusually high line total: ${lt}`,
            details: {
              itemIndex: index,
              description: item.description,
              unitPrice: item.unitPrice,
              lineTotal: lt,
              itemType,
            },
          };
          issues.push(issue);
          console.warn(`⚠️  Price validation warning: ${issue.message}`);
        }
      });
      
      // Attach validation issues to the receipt
      if (issues.length > 0) {
        receipt.validationIssues = issues;
      }
      
    } catch (error) {
      console.error('Error during price validation:', error);
      // Don't throw - validation is best-effort
    }
  }
}