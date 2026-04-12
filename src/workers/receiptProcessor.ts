import { Worker, UnrecoverableError } from 'bullmq';
import { AIRateLimitExceededError } from '../ai/errors.js';
import { eq } from 'drizzle-orm';
import fs from 'fs/promises';
import sharp from 'sharp';
import { db } from '../db/index.js';
import { lineItems, processingErrors, receipts, receiptUploads } from '../db/schema.js';
import { ReceiptJobData } from '../queue/index.js';
import { checkForDuplicates, markReceiptAsDuplicate } from '../services/duplicate-detector.js';
import { ImageSplitterService } from '../services/image-splitter.js';
import { ReceiptAnalysisService } from '../services/receipt-analysis.js';
import { saveFile, compressToWebP } from '../utils/file-utils.js';
import { ReceiptItem, ReceiptData } from '../services/receipt-analysis.js';
import dotenv from 'dotenv';

dotenv.config();

function isRateLimitError(err: unknown): boolean {
    return extractRateLimitError(err) !== null;
}

function extractRateLimitError(err: unknown): AIRateLimitExceededError | null {
    let current: any = err;
    for (let i = 0; i < 5 && current; i++) {
        if (current instanceof AIRateLimitExceededError) return current;
        current = current.cause;
    }
    return null;
}

function deriveReceiptCategory(items: ReceiptItem[]): string | null {
    const counts = new Map<string, number>();
    for (const item of items) {
        if (item.category && item.itemType !== 'discount' && item.itemType !== 'tax') {
            counts.set(item.category, (counts.get(item.category) || 0) + 1);
        }
    }
    if (counts.size === 0) return null;
    let best = '';
    let bestCount = 0;
    for (const [cat, count] of counts) {
        if (count > bestCount) {
            best = cat;
            bestCount = count;
        }
    }
    return best;
}

async function saveExtractedData(
    dbConn: typeof db,
    extractedData: ReceiptData,
    receiptId: number,
    uploadId: number,
    receiptCategory: string | null,
) {
    await dbConn.update(receipts)
        .set({
            status: 'processed',
            storeName: extractedData.merchantName,
            totalAmount: extractedData.total.toString(),
            taxAmount: extractedData.tax?.toString(),
            transactionDate: new Date(`${extractedData.transactionDate}T${extractedData.transactionTime || '00:00:00'}`),
            currency: extractedData.currency || 'USD',
            keywords: extractedData.keywords,
            category: receiptCategory,
            ocrText: extractedData.ocrText ?? null,
            processingMetadata: extractedData.processingMetadata,
            confidenceScores: extractedData.confidenceScores ?? null,
        })
        .where(eq(receipts.id, receiptId));

    if (extractedData.items && extractedData.items.length > 0) {
        await dbConn.insert(lineItems).values(
            extractedData.items.map(item => ({
                receiptId: receiptId,
                description: item.description,
                amount: item.quantity.toString(),
                unit: item.quantityUnit || 'pc',
                pricePerUnit: item.unitPrice.toString(),
                totalPrice: (item.lineTotal ?? 0).toString(),
                keywords: item.keywords,
                category: item.category || null,
                subcategory: item.subcategory || null,
                itemType: item.itemType || ((item.lineTotal ?? 0) < 0 ? 'discount' : 'product'),
                discountMetadata: item.discountMetadata || null,
                parentLineItemId: null,
                confidence: item.confidence?.toString() ?? null,
            }))
        );
    }

    if (extractedData.validationIssues && extractedData.validationIssues.length > 0) {
        for (const issue of extractedData.validationIssues) {
            await dbConn.insert(processingErrors).values({
                uploadId: uploadId,
                receiptId: receiptId,
                category: 'VALIDATION_WARNING',
                message: `${issue.type}: ${issue.message}`,
                metadata: {
                    severity: issue.severity,
                    type: issue.type,
                    details: issue.details,
                },
            });
        }
    }
}

async function processSingleReceipt(job: any, uploadId: number, receiptId: number, receiptImagePath: string) {
    const [uploadJob] = await db.select().from(receiptUploads).where(eq(receiptUploads.id, uploadId));
    if (!uploadJob) {
        throw new Error(`Upload job ${uploadId} not found.`);
    }

    try {
        let fullPath: string;
        if (receiptImagePath.startsWith('/')) {
            fullPath = receiptImagePath;
        } else if (receiptImagePath.startsWith('uploads/')) {
            fullPath = receiptImagePath;
        } else {
            fullPath = `uploads/${receiptImagePath}`;
        }

        console.log(`Job ${job.id}: Reading receipt image from: ${fullPath}`);
        const receiptImageBuffer = await fs.readFile(fullPath);
        await job.updateProgress(10);

        const receiptAnalyzer = new ReceiptAnalysisService();

        try {
            const analysisResult = await receiptAnalyzer.analyzeReceipts([receiptImageBuffer]);
            const extractedData = analysisResult[0];

            if (!extractedData || !extractedData.total) {
                throw new Error('Invalid or empty data returned from analysis.');
            }

            const receiptCategory = deriveReceiptCategory(extractedData.items);

            await saveExtractedData(db, extractedData, receiptId, uploadId, receiptCategory);

            console.log(`Job ${job.id}: Single receipt ${receiptId} processed successfully. Checking for duplicates...`);
            const duplicateCheck = await checkForDuplicates(receiptId, uploadJob.userId);
            if (duplicateCheck.isDuplicate && duplicateCheck.matchedReceipt) {
                await markReceiptAsDuplicate(receiptId, duplicateCheck.matchedReceipt.id, duplicateCheck.confidenceScore);
            }
        } catch (err: any) {
            console.error(`Job ${job.id}: Error processing single receipt ${receiptId}:`, err);
            const rateLimitErr = extractRateLimitError(err);
            if (rateLimitErr) {
                // Mark as 'rate_limited' so it can be resumed once the limit
                // resets. Record a fresh RATE_LIMITED error with the new
                // reset time.
                await db.update(receipts)
                    .set({ status: 'rate_limited' })
                    .where(eq(receipts.id, receiptId));
                await db.insert(processingErrors).values({
                    uploadId: uploadId,
                    receiptId: receiptId,
                    category: 'SYSTEM_ERROR',
                    message: `AI rate limit hit on resume: ${err.message}`,
                    metadata: {
                        errorType: 'RATE_LIMITED',
                        provider: rateLimitErr.provider,
                        resetTime: rateLimitErr.resetTime.toISOString(),
                    },
                });
            } else {
                await db.update(receipts).set({ status: 'failed' }).where(eq(receipts.id, receiptId));
                await db.insert(processingErrors).values({
                    uploadId: uploadId,
                    receiptId: receiptId,
                    category: 'EXTRACTION_FAILURE',
                    message: err.message || 'An unknown error occurred during analysis.',
                    metadata: { stack: err.stack },
                });
            }
        }

        // Recalculate upload status. 'rate_limited' receipts are NOT actively
        // being processed — they wait for the user to click resume — so they
        // count toward `partly_completed` rather than keeping the upload in
        // 'processing' (which would show as "Analyzing" in the UI).
        const allReceipts = await db.select().from(receipts).where(eq(receipts.uploadId, uploadId));
        const allProcessed = allReceipts.every(r => r.status === 'processed');
        const allFailedOrLimited = allReceipts.every(
            r => r.status === 'failed' || r.status === 'unreadable' || r.status === 'rate_limited'
        );
        const allFailed = allReceipts.every(r => r.status === 'failed' || r.status === 'unreadable');

        let finalStatus: 'completed' | 'partly_completed' | 'failed';
        if (allProcessed) {
            finalStatus = 'completed';
        } else if (allFailed) {
            finalStatus = 'failed';
        } else if (allFailedOrLimited) {
            finalStatus = 'partly_completed';
        } else {
            finalStatus = 'partly_completed';
        }

        await db.update(receiptUploads).set({ status: finalStatus }).where(eq(receiptUploads.id, uploadId));
        await job.updateProgress(100);
        console.log(`Job ${job.id}: Single receipt reprocessing finished. Upload status: ${finalStatus}`);

    } catch (err: any) {
        console.error(`Job ${job.id} (Single receipt ${receiptId}) failed critically:`, err);
        await db.update(receipts).set({ status: 'failed' }).where(eq(receipts.id, receiptId));

        // Recalculate upload status
        const allReceipts = await db.select().from(receipts).where(eq(receipts.uploadId, uploadId));
        const allFailed = allReceipts.every(r => r.status === 'failed' || r.status === 'unreadable');
        await db.update(receiptUploads)
            .set({ status: allFailed ? 'failed' : 'partly_completed' })
            .where(eq(receiptUploads.id, uploadId));

        throw err;
    }
}

const connection = {
    host: process.env.REDIS_HOST || '127.0.0.1',
    port: Number(process.env.REDIS_PORT) || 6379,
};

const receiptProcessorWorker = new Worker<ReceiptJobData>('receipt-processing', async (job) => {
    const { uploadId, imagePath, receiptId, receiptImagePath } = job.data;

    // Handle single receipt reprocessing
    if (receiptId && receiptImagePath) {
        console.log(`Processing single receipt job ${job.id} for receipt ${receiptId} (upload ${uploadId})`);
        await processSingleReceipt(job, uploadId, receiptId, receiptImagePath);
        return;
    }

    console.log(`Processing job ${job.id} for upload ${uploadId}`);

    const [uploadJob] = await db.select().from(receiptUploads).where(eq(receiptUploads.id, uploadId));
    if (!uploadJob) {
        throw new Error(`Upload job ${uploadId} not found.`);
    }

    if (uploadJob.status === 'duplicate') {
        console.log(`Job ${job.id}: Upload ${uploadId} is a duplicate — skipping processing.`);
        return;
    }

    try {
        // imagePath can be:
        // 1. Full absolute path: /Users/.../uploads/file.jpg (from initial upload)
        // 2. Relative path: uploads/file.jpg (from reprocess)
        // 3. Just filename: file.jpg (shouldn't happen but handle it)
        let fullImagePath: string;
        
        if (imagePath.startsWith('/')) {
            // Absolute path - use as is
            fullImagePath = imagePath;
        } else if (imagePath.startsWith('uploads/')) {
            // Already has uploads/ prefix - use as is
            fullImagePath = imagePath;
        } else {
            // Just filename - add uploads/ prefix
            fullImagePath = `uploads/${imagePath}`;
        }
        
        console.log(`Job ${job.id}: Reading image from: ${fullImagePath}`);
        // Image is already EXIF-normalized and metadata-stripped by compressToWebP() at upload time.
        // No additional .rotate() or orientation correction needed.
        const imageBuffer = await fs.readFile(fullImagePath);

        // 1. Split the image
        await job.updateProgress(5);
        console.log(`Job ${job.id}: Splitting image...`);
        const imageSplitter = new ImageSplitterService();
        const splitResult = await imageSplitter.splitImage(imageBuffer);

        if (splitResult.images.length === 0) {
            await db.update(receiptUploads).set({ status: 'completed', hasReceipts: 0 }).where(eq(receiptUploads.id, uploadId));
            console.log(`Job ${job.id}: Processing complete. No receipts were found.`);
            await job.updateProgress(100);
            return;
        }
        
        await db.update(receiptUploads).set({ hasReceipts: 1 }).where(eq(receiptUploads.id, uploadId));

        // 2. Save split metadata and create marked image
        await job.updateProgress(10);
        let markedImageBuffer = imageBuffer;
        if (splitResult.splitMetadata?.mergedBoundingBoxes) {
            const { width, height } = await sharp(imageBuffer).metadata();
            const rects = splitResult.splitMetadata.mergedBoundingBoxes.map(box => {
                const left = Math.round((box.x / 1000) * width!);
                const top = Math.round((box.y / 1000) * height!);
                const rectWidth = Math.round((box.width / 1000) * width!);
                const rectHeight = Math.round((box.height / 1000) * height!);
                return `<rect x="${left}" y="${top}" width="${rectWidth}" height="${rectHeight}" stroke="red" stroke-width="5" fill="none"/>`;
            });
            const svgOverlay = `<svg width="${width}" height="${height}">${rects.join('')}</svg>`;
            const buffer = await sharp(imageBuffer).composite([{ input: Buffer.from(svgOverlay), blend: 'over' }]).toBuffer();
            markedImageBuffer = Buffer.from(buffer);
        }
        const compressedMarked = await compressToWebP(markedImageBuffer);
        const { publicUrl: markedImageUrl } = await saveFile(compressedMarked, `marked-${uploadId}.webp`);
        await db.update(receiptUploads).set({
            markedImageUrl,
            splitMetadata: splitResult.splitMetadata ?? null,
        }).where(eq(receiptUploads.id, uploadId));

        // 3. Process each receipt individually
        console.log(`Job ${job.id}: Found ${splitResult.images.length} receipts. Analyzing each...`);
        const receiptAnalyzer = new ReceiptAnalysisService();
        let allSucceeded = true;
        let rateLimitedReached = false;
        const totalReceipts = splitResult.images.length;

        for (let i = 0; i < totalReceipts; i++) {
            const receiptImageBuffer = splitResult.images[i];
            const progress = 15 + Math.round((i / totalReceipts) * 80);
            await job.updateProgress(progress);

            const compressedReceipt = await compressToWebP(receiptImageBuffer);
            const { publicUrl: receiptImageUrl } = await saveFile(compressedReceipt, `receipt-${uploadId}-${i}.webp`);

            const receiptInsertResult = await db.insert(receipts).values({
                uploadId: uploadId,
                status: 'pending',
                imageUrl: receiptImageUrl,
            });
            const receiptRecordId = receiptInsertResult[0].insertId;

            // If we already hit a rate limit on a previous receipt in this batch,
            // skip the AI call entirely — mark the receipt as 'rate_limited'
            // and record a RATE_LIMITED error so the user can resume later.
            if (rateLimitedReached) {
                await db.update(receipts)
                    .set({ status: 'rate_limited' })
                    .where(eq(receipts.id, receiptRecordId));
                await db.insert(processingErrors).values({
                    uploadId: uploadId,
                    receiptId: receiptRecordId,
                    category: 'SYSTEM_ERROR',
                    message: 'Skipped: previous receipt in this batch hit AI rate limit.',
                    metadata: { errorType: 'RATE_LIMITED', skipped: true },
                });
                allSucceeded = false;
                continue;
            }

            try {
                const analysisResult = await receiptAnalyzer.analyzeReceipts([receiptImageBuffer]);
                const extractedData = analysisResult[0];

                if (!extractedData || !extractedData.total) {
                    throw new Error('Invalid or empty data returned from analysis.');
                }

                const receiptCategory = deriveReceiptCategory(extractedData.items);

                await saveExtractedData(db, extractedData, receiptRecordId, uploadId, receiptCategory);

                console.log(`Job ${job.id}: Receipt ${i+1}/${totalReceipts} processed successfully. Checking for duplicates...`);
                const duplicateCheck = await checkForDuplicates(receiptRecordId, uploadJob.userId);

                if (duplicateCheck.isDuplicate && duplicateCheck.matchedReceipt) {
                    await markReceiptAsDuplicate(
                        receiptRecordId,
                        duplicateCheck.matchedReceipt.id,
                        duplicateCheck.confidenceScore
                    );
                    console.log(`Job ${job.id}: Receipt ${receiptRecordId} marked as duplicate.`);
                }
            } catch (err: any) {
                allSucceeded = false;
                const rateLimitErr = extractRateLimitError(err);
                const errorMessage = err.message || 'An unknown error occurred during analysis.';
                console.error(`Job ${job.id}: Error processing receipt ${receiptRecordId}:`, err);

                if (rateLimitErr) {
                    // Mark receipt as 'rate_limited' so the frontend can
                    // distinguish it from receipts actively being processed
                    // ('pending'). The resume endpoint filters on this status.
                    // Stop processing remaining receipts in this batch — they
                    // would all fail anyway.
                    rateLimitedReached = true;
                    await db.update(receipts)
                        .set({ status: 'rate_limited' })
                        .where(eq(receipts.id, receiptRecordId));
                    await db.insert(processingErrors).values({
                        uploadId: uploadId,
                        receiptId: receiptRecordId,
                        category: 'SYSTEM_ERROR',
                        message: `AI rate limit hit: ${errorMessage}`,
                        metadata: {
                            errorType: 'RATE_LIMITED',
                            provider: rateLimitErr.provider,
                            resetTime: rateLimitErr.resetTime.toISOString(),
                        },
                    });
                } else {
                    await db.update(receipts).set({ status: 'failed' }).where(eq(receipts.id, receiptRecordId));
                    await db.insert(processingErrors).values({
                        uploadId: uploadId,
                        receiptId: receiptRecordId,
                        category: 'EXTRACTION_FAILURE',
                        message: errorMessage,
                        metadata: { stack: err.stack },
                    });
                }
            }
        }

        // 4. Finalize
        const finalStatus = allSucceeded ? 'completed' : 'partly_completed';
        await db.update(receiptUploads).set({ status: finalStatus }).where(eq(receiptUploads.id, uploadId));
        await job.updateProgress(100);
        console.log(`Job ${job.id}: Processing finished with status: ${finalStatus}`);

    } catch (err: any) {
        console.error(`Job ${job.id} (Upload ID: ${uploadId}) failed critically:`, err);
        await db.update(receiptUploads).set({ status: 'failed' }).where(eq(receiptUploads.id, uploadId));
        await db.insert(processingErrors).values({
            uploadId: uploadId,
            category: 'SYSTEM_ERROR',
            message: err.message,
            metadata: { stack: err.stack },
        });
        // Rate limit errors should NOT be retried — retries just waste more quota.
        // Wrap as UnrecoverableError so BullMQ marks the job as permanently failed.
        if (isRateLimitError(err)) {
            throw new UnrecoverableError(`Rate limit hit: ${err.message}`);
        }
        throw err;
    }
}, { connection });


receiptProcessorWorker.on('completed', (job) => {
    console.log(`Job ${job.id} has completed.`);
});

receiptProcessorWorker.on('failed', (job, err) => {
    console.error(`Job ${job?.id} has failed with error: ${err.message}`);
});

export default receiptProcessorWorker;
