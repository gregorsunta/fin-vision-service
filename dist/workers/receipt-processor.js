import { db, receipts, lineItems } from '../db';
import { eq } from 'drizzle-orm';
import { GoogleGenerativeAI } from '@google/generative-ai';
import { ImageAnnotatorClient } from '@google-cloud/vision';
import { PromptManager } from '../services/PromptManager';
// Initialize Google Cloud clients
const visionClient = new ImageAnnotatorClient();
const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
const promptManager = new PromptManager();
/**
 * Fetches an image from the internal API and performs OCR using Google Cloud Vision.
 * @param imageUrl The relative path of the image (e.g., /files/filename.jpg).
 * @returns The detected text from the image.
 */
async function runOcrOnImage(imageUrl) {
    const apiEndpoint = `http://api:3000/api${imageUrl}`;
    console.log(`Fetching image for OCR from: ${apiEndpoint}`);
    let imageBuffer;
    try {
        const response = await fetch(apiEndpoint, {
            headers: {
                Authorization: process.env.INTERNAL_API_KEY,
            },
        });
        if (!response.ok) {
            throw new Error(`Failed to fetch image: ${response.status} ${response.statusText}`);
        }
        const imageArrayBuffer = await response.arrayBuffer();
        imageBuffer = Buffer.from(imageArrayBuffer);
    }
    catch (error) {
        console.error(`Error fetching image from API: ${error}`);
        throw new Error('Could not fetch image file for processing.');
    }
    console.log('Successfully fetched image. Running Google Cloud Vision OCR...');
    const [result] = await visionClient.textDetection(imageBuffer);
    const detections = result.textAnnotations;
    if (!detections || detections.length === 0 || !detections[0].description) {
        throw new Error('No text found in image by Google Cloud Vision.');
    }
    console.log('OCR completed successfully.');
    return detections[0].description;
}
/**
 * Uses Gemini to extract structured data from OCR text.
 * @param ocrText The text extracted from the receipt.
 * @returns A structured JSON object of the receipt data.
 */
async function getExtractedDataFromGemini(ocrText) {
    console.log('Extracting structured data with Gemini...');
    const model = genAI.getGenerativeModel({
        model: 'gemini-1.5-flash-lite',
        tools: [promptManager.getExtractionTool()], // Wrap the tool in an array
        generationConfig: promptManager.getGenerationConfig(),
        safetySettings: promptManager.getSafetySettings(),
    });
    const result = await model.generateContent(promptManager.createExtractionPrompt(ocrText));
    const call = result.response.functionCalls()?.[0];
    if (!call) {
        throw new Error('Gemini did not return the expected function call. Cannot extract data.');
    }
    console.log('Gemini extraction successful.');
    // The model returns the data in the `args` property of the function call
    return call.args; // Cast to the defined interface
}
// The main processor function for the worker
export default async function (job) {
    const { receiptId, imageUrl } = job.data;
    console.log(`Processing job ${job.id} for receiptId: ${receiptId}`);
    try {
        // 1. Get OCR text from the image
        const ocrText = await runOcrOnImage(imageUrl);
        // 2. Extract structured data using Gemini
        const extractedData = await getExtractedDataFromGemini(ocrText);
        if (!extractedData || !extractedData.line_items) {
            throw new Error('Data extraction from Gemini returned incomplete data.');
        }
        // 3. Use a transaction to update the database
        await db.transaction(async (tx) => {
            // Update the main receipt record
            await tx
                .update(receipts)
                .set({
                storeName: extractedData.store_name,
                totalAmount: extractedData.total_amount ? String(extractedData.total_amount) : null,
                taxAmount: extractedData.tax_amount ? String(extractedData.tax_amount) : null,
                transactionDate: extractedData.transaction_date ? new Date(extractedData.transaction_date) : null,
                status: 'completed',
            })
                .where(eq(receipts.id, receiptId));
            // Insert all the line items
            if (extractedData.line_items && extractedData.line_items.length > 0) {
                await tx.insert(lineItems).values(extractedData.line_items.map((item) => ({
                    receiptId: receiptId,
                    description: item.description,
                    quantity: String(item.qty),
                    unitPrice: String(item.unit_price),
                })));
            }
        });
        console.log(`Successfully processed receiptId: ${receiptId}`);
    }
    catch (error) {
        console.error(`Failed to process receiptId: ${receiptId}`, error);
        // If an error occurs, update the receipt status to 'failed'
        await db
            .update(receipts)
            .set({ status: 'failed' })
            .where(eq(receipts.id, receiptId));
        // Re-throw the error to make the job fail in BullMQ
        throw error;
    }
}
