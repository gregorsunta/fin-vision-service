import { Job, Worker } from 'bullmq';
import { eq } from 'drizzle-orm';
import fs from 'fs/promises';
import sharp from 'sharp';
import { db } from '../db/index.js';
import { lineItems, processingErrors, receipts, receiptUploads } from '../db/schema.js';
import { ReceiptJobData } from '../queue/index.js';
import { checkForDuplicates, markReceiptAsDuplicate } from '../services/duplicate-detector.js';
import { ImageSplitterService } from '../services/image-splitter.js';
import { ReceiptAnalysisService } from '../services/receipt-analysis.js';
import { saveFile } from '../utils/file-utils.js';
import dotenv from 'dotenv';

dotenv.config();

const connection = {
    host: process.env.REDIS_HOST || '127.0.0.1',
    port: Number(process.env.REDIS_PORT) || 6379,
};

const receiptProcessorWorker = new Worker<ReceiptJobData>('receipt-processing', async (job) => {
    const { uploadId, imagePath } = job.data;
    console.log(`Processing job ${job.id} for upload ${uploadId}`);

    const [uploadJob] = await db.select().from(receiptUploads).where(eq(receiptUploads.id, uploadId));
    if (!uploadJob) {
        throw new Error(`Upload job ${uploadId} not found.`);
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
        const imageBuffer = await fs.readFile(fullImagePath);

        // 1. Split the image
        await job.updateProgress(5);
        console.log(`Job ${job.id}: Splitting image...`);
        const imageSplitter = new ImageSplitterService();
        const splitResult = await imageSplitter.splitImage(imageBuffer, { debug: true });

        if (splitResult.images.length === 0) {
            await db.update(receiptUploads).set({ status: 'completed', hasReceipts: 0 }).where(eq(receiptUploads.id, uploadId));
            console.log(`Job ${job.id}: Processing complete. No receipts were found.`);
            await job.updateProgress(100);
            return;
        }
        
        await db.update(receiptUploads).set({ hasReceipts: 1 }).where(eq(receiptUploads.id, uploadId));

        // 2. Create Marked Image
        await job.updateProgress(10);
        let markedImageBuffer = imageBuffer;
        if (splitResult.debug?.boundingBoxes) {
            const { width, height } = await sharp(imageBuffer).metadata();
            const rects = splitResult.debug.boundingBoxes.map(box => {
                const left = Math.round((box.x / 1000) * width!);
                const top = Math.round((box.y / 1000) * height!);
                const rectWidth = Math.round((box.width / 1000) * width!);
                const rectHeight = Math.round((box.height / 1000) * height!);
                return `<rect x="${left}" y="${top}" width="${rectWidth}" height="${rectHeight}" stroke="red" stroke-width="5" fill="none"/>`;
            });
            const svgOverlay = `<svg width="${width}" height="${height}">${rects.join('')}</svg>`;
            markedImageBuffer = await sharp(imageBuffer).composite([{ input: Buffer.from(svgOverlay), blend: 'over' }]).toBuffer();
        }
        const { publicUrl: markedImageUrl } = await saveFile(markedImageBuffer, `marked-${uploadId}.jpg`);
        await db.update(receiptUploads).set({ markedImageUrl }).where(eq(receiptUploads.id, uploadId));

        // 3. Process each receipt individually
        console.log(`Job ${job.id}: Found ${splitResult.images.length} receipts. Analyzing each...`);
        const receiptAnalyzer = new ReceiptAnalysisService();
        let allSucceeded = true;
        const totalReceipts = splitResult.images.length;

        for (let i = 0; i < totalReceipts; i++) {
            const receiptImageBuffer = splitResult.images[i];
            const progress = 15 + Math.round((i / totalReceipts) * 80);
            await job.updateProgress(progress);
            
            const { publicUrl: receiptImageUrl } = await saveFile(receiptImageBuffer, `receipt-${uploadId}-${i}.jpg`);

            const receiptInsertResult = await db.insert(receipts).values({
                uploadId: uploadId,
                status: 'pending',
                imageUrl: receiptImageUrl,
            });
            const receiptRecordId = receiptInsertResult[0].insertId;

            try {
                const analysisResult = await receiptAnalyzer.analyzeReceipts([receiptImageBuffer]);
                const extractedData = analysisResult[0];

                if (!extractedData || !extractedData.total) {
                    throw new Error('Invalid or empty data returned from analysis.');
                }

                await db.update(receipts)
                    .set({
                        status: 'processed',
                        storeName: extractedData.merchantName,
                        totalAmount: extractedData.total.toString(),
                        taxAmount: extractedData.tax?.toString(),
                        transactionDate: new Date(extractedData.transactionDate),
                        currency: extractedData.currency || 'USD',
                        keywords: extractedData.keywords,
                    })
                    .where(eq(receipts.id, receiptRecordId));

                if (extractedData.items && extractedData.items.length > 0) {
                    await db.insert(lineItems).values(
                        extractedData.items.map(item => ({
                            receiptId: receiptRecordId,
                            description: item.description,
                            amount: item.quantity.toString(),
                            unit: item.quantityUnit || 'pc',
                            totalPrice: item.price.toString(),
                            keywords: item.keywords,
                        }))
                    );
                }

                // Store validation warnings in the database
                if (extractedData.validationIssues && extractedData.validationIssues.length > 0) {
                    console.warn(`Job ${job.id}: Receipt ${receiptRecordId} has ${extractedData.validationIssues.length} validation issue(s)`);
                    
                    for (const issue of extractedData.validationIssues) {
                        await db.insert(processingErrors).values({
                            uploadId: uploadId,
                            receiptId: receiptRecordId,
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
                const errorMessage = err.message || 'An unknown error occurred during analysis.';
                console.error(`Job ${job.id}: Error processing receipt ${receiptRecordId}:`, err);

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
        // Re-throw the error to let BullMQ mark the job as failed
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
