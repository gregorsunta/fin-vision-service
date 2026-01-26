import { GoogleGenerativeAI, Part } from '@google/generative-ai';

// Updated structure to include keywords, quantity units
export interface ReceiptItem {
  description: string; // Includes package size if applicable (e.g., "Coca Cola 500ml")
  quantity: number;
  quantityUnit?: string; // "pc" for packaged items with size in description, or "kg"/"g"/"L"/"ml" for bulk/measured items
  price: number;
  keywords?: string[];
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
      1. Each line item has ONE price - this is the TOTAL for that line (quantity × unit price)
      2. The line total is ALWAYS the rightmost number on the line (ignore any numbers before it)
      3. Process the receipt line by line, from top to bottom
      4. If a line has multiple numbers, identify which is:
         - Product code (usually near start, no currency symbol)
         - Quantity (small number like 1, 2, 3 or weight like 0.350)
         - Unit price (middle column, may have "×" before it)
         - LINE TOTAL (rightmost column - THIS IS WHAT YOU EXTRACT as 'price')
      5. Match each line total to its description EXACTLY - do not mix up lines
      
      VISUAL ALIGNMENT EXAMPLE:
      ─────────────────────────────────────────
      Description             Qty    Price
      ─────────────────────────────────────────
      Milk 1L                 1      €2.50  ← Extract €2.50
      Bread                   2      €3.00  ← Extract €3.00
      Banana (kg)             0.5    €1.25  ← Extract €1.25
      ─────────────────────────────────────────
      SUBTOTAL                       €6.75
      TAX (20%)                      €1.35
      TOTAL                          €8.10
      ─────────────────────────────────────────
      
      COMMON RECEIPT FORMATS TO HANDLE:
      
      Format 1: Simple (Description + Price)
      Milk 1L                €2.50
      → Extract: description="Milk 1L", price=2.50
      
      Format 2: With Quantity
      Milk 1L    2x €1.25    €2.50
      → Extract: description="Milk 1L", quantity=2, price=2.50 (NOT 1.25!)
      
      Format 3: Weight-based
      Banana                 0.350 kg  €1.99/kg  €0.70
      → Extract: description="Banana", quantity=0.350, price=0.70 (NOT 1.99!)
      
      Format 4: Compact (numbers close together)
      Coca Cola 500ml  2  1.50  3.00
      → Extract: description="Coca Cola 500ml", quantity=2, price=3.00 (rightmost!)
      
      IMPORTANT VALIDATION:
      - After extracting all items, sum their prices
      - The sum should equal the receipt TOTAL (not subtotal - item prices include tax)
      - If your sum is off by more than €0.50, YOU MADE A MISTAKE - review each line again
      
      WHAT TO IGNORE:
      - Product codes (e.g., "12345", "SKU-987")
      - Barcodes
      - Item numbers
      - Department codes
      - Running subtotals mid-receipt
      
      DISCOUNTS:
      - If you see a discount line (e.g., "DISCOUNT -€2.00"), create a separate item
      - Use negative price: price=-2.00
      - Description should include "Discount" or "Rabatt"
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
            "price": 12.99,
            "keywords": ["category1", "category2"]
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
      SuperMart Store
      2024-01-24  14:30:15
      
      Milk 1L                    €2.50
      Bread                      €1.80
      Coca Cola 500ml  2x €1.50  €3.00
      Banana        0.450kg @€2.20/kg  €0.99
      
      SUBTOTAL                   €8.29
      TAX (9%)                   €0.75
      TOTAL                      €9.04
      ─────────────────────────────────────
      
      Your JSON output:
      {
        "merchantName": "SuperMart Store",
        "transactionDate": "2024-01-24",
        "transactionTime": "14:30:15",
        "items": [
          {
            "description": "Milk 1L",
            "quantity": 1,
            "quantityUnit": "pc",
            "price": 2.50,
            "keywords": ["dairy", "beverage"]
          },
          {
            "description": "Bread",
            "quantity": 1,
            "quantityUnit": "pc",
            "price": 1.80,
            "keywords": ["bakery"]
          },
          {
            "description": "Coca Cola 500ml",
            "quantity": 2,
            "quantityUnit": "pc",
            "price": 3.00,
            "keywords": ["beverage", "soft drink"]
          },
          {
            "description": "Banana",
            "quantity": 0.450,
            "quantityUnit": "kg",
            "price": 0.99,
            "keywords": ["fruit"]
          }
        ],
        "subtotal": 8.29,
        "tax": 0.75,
        "total": 9.04,
        "currency": "EUR",
        "keywords": ["groceries"]
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
      // Calculate sum of all item prices
      const calculatedTotal = receipt.items.reduce((sum, item) => sum + item.price, 0);
      
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
            items: receipt.items.map(i => ({ description: i.description, price: i.price })),
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
      
      // Check for unrealistic prices (e.g., zero or extremely high)
      // Note: Negative prices are ALLOWED for discounts/refunds
      receipt.items.forEach((item, index) => {
        // Check if item is a discount (negative price is valid)
        const isDiscount = item.price < 0 || 
                           item.description.toLowerCase().includes('discount') ||
                           item.description.toLowerCase().includes('popust') ||
                           item.description.toLowerCase().includes('rabatt') ||
                           item.description.toLowerCase().includes('refund');
        
        // Only flag as invalid if price is zero (not negative discount, not positive regular item)
        if (item.price === 0) {
          const issue: ValidationIssue = {
            severity: 'error',
            type: 'INVALID_PRICE',
            message: `Item "${item.description}" has invalid price: ${item.price}`,
            details: {
              itemIndex: index,
              description: item.description,
              price: item.price,
            },
          };
          issues.push(issue);
          console.warn(`⚠️  Price validation warning: ${issue.message}`);
        }
        
        // Flag negative prices that are NOT discounts (suspicious)
        if (item.price < 0 && !isDiscount) {
          const issue: ValidationIssue = {
            severity: 'warning',
            type: 'INVALID_PRICE',
            message: `Item "${item.description}" has negative price but doesn't appear to be a discount: ${item.price}`,
            details: {
              itemIndex: index,
              description: item.description,
              price: item.price,
            },
          };
          issues.push(issue);
          console.warn(`⚠️  Price validation warning: ${issue.message}`);
        }
        if (item.price > 10000) {
          const issue: ValidationIssue = {
            severity: 'warning',
            type: 'UNREALISTIC_PRICE',
            message: `Item "${item.description}" has unusually high price: ${item.price}`,
            details: {
              itemIndex: index,
              description: item.description,
              price: item.price,
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