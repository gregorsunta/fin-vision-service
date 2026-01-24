/**
 * Duplicate Receipt Detection Service
 * 
 * Uses multi-factor fuzzy matching with confidence scoring to detect duplicate receipts.
 * Handles OCR errors, blurred images, and AI guessing with intelligent threshold-based matching.
 */

import { db } from '../db/index.js';
import { receipts, lineItems, duplicateMatches, receiptUploads } from '../db/schema.js';
import { eq, and, sql, ne, inArray } from 'drizzle-orm';

// Levenshtein distance for fuzzy string matching
function levenshteinDistance(str1: string, str2: string): number {
  const len1 = str1.length;
  const len2 = str2.length;
  const matrix: number[][] = [];

  for (let i = 0; i <= len1; i++) {
    matrix[i] = [i];
  }

  for (let j = 0; j <= len2; j++) {
    matrix[0][j] = j;
  }

  for (let i = 1; i <= len1; i++) {
    for (let j = 1; j <= len2; j++) {
      if (str1[i - 1] === str2[j - 1]) {
        matrix[i][j] = matrix[i - 1][j - 1];
      } else {
        matrix[i][j] = Math.min(
          matrix[i - 1][j - 1] + 1, // substitution
          matrix[i][j - 1] + 1,     // insertion
          matrix[i - 1][j] + 1      // deletion
        );
      }
    }
  }

  return matrix[len1][len2];
}

// Calculate similarity percentage between two strings
function stringSimilarity(str1: string, str2: string): number {
  if (!str1 || !str2) return 0;
  
  const normalized1 = str1.toLowerCase().replace(/[^a-z0-9]/g, '');
  const normalized2 = str2.toLowerCase().replace(/[^a-z0-9]/g, '');
  
  if (normalized1 === normalized2) return 100;
  
  const maxLen = Math.max(normalized1.length, normalized2.length);
  if (maxLen === 0) return 100;
  
  const distance = levenshteinDistance(normalized1, normalized2);
  const similarity = ((maxLen - distance) / maxLen) * 100;
  
  return Math.max(0, Math.min(100, similarity));
}

// Normalize store names for better matching (reserved for future use)
// function normalizeStoreName(name: string | null): string {
//   if (!name) return '';
//   
//   return name
//     .toLowerCase()
//     .replace(/[^a-z0-9]/g, '')
//     // Handle common variations
//     .replace(/supercenter/g, '')
//     .replace(/supermarket/g, '')
//     .replace(/store/g, '')
//     .replace(/\d+/g, '') // Remove store numbers
//     .trim();
// }

// Calculate store name matching score (0-30 points)
function calculateStoreNameScore(name1: string | null, name2: string | null): { score: number; similarity: number } {
  if (!name1 || !name2) return { score: 0, similarity: 0 };
  
  const similarity = stringSimilarity(name1, name2);
  
  let score = 0;
  if (similarity === 100) {
    score = 30;
  } else if (similarity >= 90) {
    score = 28;
  } else if (similarity >= 80) {
    score = 23;
  } else if (similarity >= 70) {
    score = 18;
  } else if (similarity >= 60) {
    score = 12;
  }
  
  return { score, similarity: Math.round(similarity) };
}

// Calculate total amount matching score (0-25 points)
function calculateTotalAmountScore(amount1: string | null, amount2: string | null): { score: number; difference: number } {
  if (!amount1 || !amount2) return { score: 0, difference: 0 };
  
  const num1 = parseFloat(amount1);
  const num2 = parseFloat(amount2);
  
  if (isNaN(num1) || isNaN(num2)) return { score: 0, difference: 0 };
  
  const difference = Math.abs(num1 - num2);
  
  let score = 0;
  if (difference === 0) {
    score = 25;
  } else if (difference <= 0.01) {
    score = 23;
  } else if (difference <= 0.10) {
    score = 20;
  } else if (difference <= 1.00) {
    score = 15;
  } else if (difference <= 5.00) {
    score = 10;
  }
  
  return { score, difference: Math.round(difference * 100) / 100 };
}

// Calculate date matching score (0-20 points)
function calculateDateScore(date1: Date | null, date2: Date | null): { score: number; daysDifference: number } {
  if (!date1 || !date2) return { score: 0, daysDifference: 0 };
  
  const time1 = date1.getTime();
  const time2 = date2.getTime();
  const daysDiff = Math.abs(Math.floor((time1 - time2) / (1000 * 60 * 60 * 24)));
  
  let score = 0;
  if (daysDiff === 0) {
    score = 20;
  } else if (daysDiff === 1) {
    score = 15; // Could be OCR error
  } else if (daysDiff === 2 || daysDiff === 3) {
    score = 10;
  }
  
  return { score, daysDifference: daysDiff };
}

// Calculate item count matching score (0-15 points)
function calculateItemCountScore(count1: number, count2: number): { score: number; difference: number } {
  const difference = Math.abs(count1 - count2);
  
  let score = 0;
  if (difference === 0) {
    score = 15;
  } else if (difference === 1) {
    score = 12;
  } else if (difference === 2) {
    score = 8;
  } else if (difference === 3) {
    score = 5;
  }
  
  return { score, difference };
}

// Calculate tax amount matching score (0-10 points)
function calculateTaxAmountScore(tax1: string | null, tax2: string | null): { score: number; difference: number } {
  if (!tax1 || !tax2) return { score: 0, difference: 0 };
  
  const num1 = parseFloat(tax1);
  const num2 = parseFloat(tax2);
  
  if (isNaN(num1) || isNaN(num2)) return { score: 0, difference: 0 };
  
  const difference = Math.abs(num1 - num2);
  
  let score = 0;
  if (difference === 0) {
    score = 10;
  } else if (difference <= 0.01) {
    score = 8;
  } else if (difference <= 0.10) {
    score = 5;
  }
  
  return { score, difference: Math.round(difference * 100) / 100 };
}

// Classify confidence level
function classifyConfidence(score: number): string {
  if (score >= 95) return 'DEFINITE_DUPLICATE';
  if (score >= 85) return 'LIKELY_DUPLICATE';
  if (score >= 70) return 'POSSIBLE_DUPLICATE';
  if (score >= 50) return 'UNCERTAIN';
  return 'NOT_DUPLICATE';
}

interface DuplicateCheckResult {
  isDuplicate: boolean;
  confidenceScore: number;
  confidenceLevel: string;
  matchedReceipt: any | null;
  matchFactors: any | null;
}

/**
 * Check if a receipt is a duplicate of existing receipts for the same user
 * 
 * @param receiptId - ID of the receipt to check
 * @param userId - ID of the user who owns the receipt
 * @returns Duplicate check result with confidence score and match details
 */
export async function checkForDuplicates(receiptId: number, userId: number): Promise<DuplicateCheckResult> {
  // Get the receipt to check
  const [currentReceipt] = await db
    .select()
    .from(receipts)
    .where(eq(receipts.id, receiptId));

  if (!currentReceipt) {
    throw new Error('Receipt not found');
  }

  // Get line items count for current receipt
  const currentItems = await db
    .select()
    .from(lineItems)
    .where(eq(lineItems.receiptId, receiptId));

  const currentItemCount = currentItems.length;

  // Step 1: Find all uploads by this user
  const userUploads = await db
    .select({ id: receiptUploads.id })
    .from(receiptUploads)
    .where(eq(receiptUploads.userId, userId));

  if (userUploads.length === 0) {
    return {
      isDuplicate: false,
      confidenceScore: 0,
      confidenceLevel: 'NOT_DUPLICATE',
      matchedReceipt: null,
      matchFactors: null,
    };
  }

  const userUploadIds = userUploads.map(u => u.id);

  // Step 2: Build query conditions
  const conditions = [
    inArray(receipts.uploadId, userUploadIds),
    eq(receipts.status, 'processed'),
    ne(receipts.id, receiptId)
  ];

  // Add date filter if available
  const dateFilter = currentReceipt.transactionDate;
  if (dateFilter) {
    const startDate = new Date(dateFilter);
    startDate.setDate(startDate.getDate() - 3);
    
    const endDate = new Date(dateFilter);
    endDate.setDate(endDate.getDate() + 3);
    
    // Use SQL for date comparison since it's stored as date type
    conditions.push(sql`${receipts.transactionDate} >= ${startDate.toISOString().split('T')[0]}`);
    conditions.push(sql`${receipts.transactionDate} <= ${endDate.toISOString().split('T')[0]}`);
  }

  // Find candidate receipts
  const candidates = await db
    .select()
    .from(receipts)
    .where(and(...conditions));

  if (candidates.length === 0) {
    return {
      isDuplicate: false,
      confidenceScore: 0,
      confidenceLevel: 'NOT_DUPLICATE',
      matchedReceipt: null,
      matchFactors: null,
    };
  }

  // Step 2: Calculate confidence scores for each candidate
  let bestMatch: any = null;
  let highestScore = 0;
  let bestMatchFactors: any = null;

  for (const candidateReceipt of candidates) {

    // Get item count for candidate
    const candidateItems = await db
      .select()
      .from(lineItems)
      .where(eq(lineItems.receiptId, candidateReceipt.id));

    const candidateItemCount = candidateItems.length;

    // Calculate individual factor scores
    const storeNameMatch = calculateStoreNameScore(
      currentReceipt.storeName,
      candidateReceipt.storeName
    );

    const totalAmountMatch = calculateTotalAmountScore(
      currentReceipt.totalAmount,
      candidateReceipt.totalAmount
    );

    const dateMatch = calculateDateScore(
      currentReceipt.transactionDate,
      candidateReceipt.transactionDate
    );

    const itemCountMatch = calculateItemCountScore(
      currentItemCount,
      candidateItemCount
    );

    const taxAmountMatch = calculateTaxAmountScore(
      currentReceipt.taxAmount,
      candidateReceipt.taxAmount
    );

    // Calculate total confidence score
    const totalScore =
      storeNameMatch.score +
      totalAmountMatch.score +
      dateMatch.score +
      itemCountMatch.score +
      taxAmountMatch.score;

    // Track best match
    if (totalScore > highestScore) {
      highestScore = totalScore;
      bestMatch = candidateReceipt;
      bestMatchFactors = {
        storeName: storeNameMatch,
        totalAmount: totalAmountMatch,
        date: dateMatch,
        itemCount: itemCountMatch,
        taxAmount: taxAmountMatch,
      };
    }
  }

  // Step 3: Classify and return result
  const confidenceLevel = classifyConfidence(highestScore);
  const isDuplicate = highestScore >= 85; // LIKELY_DUPLICATE threshold

  // Store duplicate match in database if significant
  if (highestScore >= 70 && bestMatch) {
    await db.insert(duplicateMatches).values({
      receiptId: receiptId,
      potentialDuplicateId: bestMatch.id,
      confidenceScore: highestScore.toFixed(2),
      matchFactors: bestMatchFactors,
      userAction: 'pending',
    });
  }

  return {
    isDuplicate,
    confidenceScore: Math.round(highestScore * 100) / 100,
    confidenceLevel,
    matchedReceipt: bestMatch,
    matchFactors: bestMatchFactors,
  };
}

/**
 * Update receipt with duplicate information
 */
export async function markReceiptAsDuplicate(
  receiptId: number,
  duplicateOfId: number,
  confidenceScore: number
): Promise<void> {
  await db.update(receipts)
    .set({
      isDuplicate: true,
      duplicateOfReceiptId: duplicateOfId,
      duplicateConfidenceScore: confidenceScore.toFixed(2),
      duplicateCheckedAt: new Date(),
    })
    .where(eq(receipts.id, receiptId));
}

/**
 * Allow user to override duplicate detection
 */
export async function overrideDuplicateFlag(receiptId: number): Promise<void> {
  await db.update(receipts)
    .set({
      isDuplicate: false,
      duplicateOverride: true,
    })
    .where(eq(receipts.id, receiptId));

  // Update all duplicate matches involving this receipt
  await db.update(duplicateMatches)
    .set({
      userAction: 'override',
    })
    .where(eq(duplicateMatches.receiptId, receiptId));
}
