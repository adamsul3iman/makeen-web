/**
 * Product Import Script for Makeen POS System
 * Reads Global_Products_Cleaned.xlsx and Local_Products_Cleaned.xlsx
 * Maps data to unified structure and outputs Makeen_Import_Ready.json
 * 
 * Run: npx tsx scripts/import_products.ts
 * OR: ts-node scripts/import_products.ts
 * 
 * Dependencies: npm install xlsx
 * 
 * Output: Makeen_Import_Ready.json in the project root
 */

import * as fs from 'fs';
import * as path from 'path';
import xlsx from 'xlsx';

// Use process.cwd() to get the project root directory
const PROJECT_ROOT = process.cwd();

// File paths using project root
const GLOBAL_FILE = path.join(PROJECT_ROOT, 'Global_Products_Cleaned.xlsx');
const LOCAL_FILE = path.join(PROJECT_ROOT, 'Local_Products_Cleaned.xlsx');
const OUTPUT_FILE = path.join(PROJECT_ROOT, 'Makeen_Import_Ready.json');

// Types for the raw Excel data
interface RawProductData {
  'ERP Variant ID': string;
  'Parent ID': string;
  'Source Row': number;
  Category: string;
  'Category Confidence': string;
  'Brand / Company': string;
  'Brand Confidence': string;
  'Parent Product': string;
  'Variant Label': string;
  'Variant Type': string;
  Barcode: string;
  'Barcode Raw': string;
  'Barcode Type': string;
  'Barcode Valid GTIN': number;
  'Barcode Recovery Status': string;
  'GS1 Prefix': string;
  'Sale Price': number;
  'Cost Price': number;
  'Purchase Price': number;
  'Whole Price': number;
  'Tax Percentage': number;
  'Legacy Arabic Name': string;
  'Legacy Main Category': string;
  'Variant Source': string;
  'Variant Confidence': string;
  NeedsReview: number;
  'Review Reason'?: string;
}

// Types for the mapped product data
interface MappedProduct {
  name: string;
  barcode: string;
  sale_price: number;
  cost_price: number;
  category: string;
  stock: number;
}

// Normalize barcode: remove .0 decimals and ensure clean string
function normalizeBarcode(barcode: string): string {
  if (!barcode) return '';
  // Remove .0 suffix if present
  const cleaned = barcode.replace(/\.0$/, '').trim();
  return cleaned;
}

// Get product name: use Legacy Arabic Name, or combine Parent Product + Variant Label
function getProductName(data: RawProductData): string {
  const arabicName = data['Legacy Arabic Name']?.trim();
  if (arabicName && arabicName.length > 0) {
    return arabicName;
  }
  
  // Combine Parent Product and Variant Label, stripping 'قياسي' if present
  const parentProduct = data['Parent Product']?.trim() || '';
  const variantLabel = data['Variant Label']?.trim() || '';
  
  // Strip 'قياسي' from variant label if present
  const cleanedVariant = variantLabel.replace(/قياسي/, '').trim();
  
  // Combine
  const combined = [parentProduct, cleanedVariant].filter(p => p.length > 0).join(' ');
  return combined || '';
}

// Get category from the Category column
function getCategory(data: RawProductData): string {
  return data.Category?.trim() || '';
}

// Parse price as float
function parsePrice(price: number): number {
  return Number(price);
}

/**
 * Main import function
 */
function importProducts() {
  console.log('🔍 Starting product import process...');
  
  // Check if files exist
  if (!fs.existsSync(GLOBAL_FILE)) {
    console.error('❌ Error: Global_Products_Cleaned.xlsx not found at:', GLOBAL_FILE);
    process.exit(1);
  }
  
  if (!fs.existsSync(LOCAL_FILE)) {
    console.error('❌ Error: Local_Products_Cleaned.xlsx not found at:', LOCAL_FILE);
    process.exit(1);
  }
  
  // Read Excel files
  console.log('📖 Reading Global_Products_Cleaned.xlsx...');
  const globalWorkbook = xlsx.readFile(GLOBAL_FILE);
  const globalSheetName = globalWorkbook.SheetNames[0]; // 'Global Products'
  const globalData = xlsx.utils.sheet_to_json(globalWorkbook.Sheets[globalSheetName]) as RawProductData[];
  
  console.log('📖 Reading Local_Products_Cleaned.xlsx...');
  const localWorkbook = xlsx.readFile(LOCAL_FILE);
  const localSheetName = localWorkbook.SheetNames[0]; // 'Local Products'
  const localData = xlsx.utils.sheet_to_json(localWorkbook.Sheets[localSheetName]) as RawProductData[];
  
  console.log(`📊 Found ${globalData.length} rows in Global file and ${localData.length} rows in Local file`);
  
  // Combine all data
  const allData = [...globalData, ...localData];
  console.log(`📊 Total rows: ${allData.length}`);
  
  // Map and clean data
  const mappedProducts: MappedProduct[] = [];
  
  for (const row of allData) {
    // Filter: skip rows without valid barcode or name
    const barcode = normalizeBarcode(row.Barcode);
    const name = getProductName(row);
    
    if (!barcode || barcode.length === 0) {
      console.log(`⚠️  Skipping row ${row['ERP Variant ID']}: missing barcode`);
      continue;
    }
    
    if (!name || name.length === 0) {
      console.log(`⚠️  Skipping row ${row['ERP Variant ID']}: missing name`);
      continue;
    }
    
    // Map the product
    const product: MappedProduct = {
      name: name,
      barcode: barcode,
      sale_price: parsePrice(row['Sale Price']),
      cost_price: parsePrice(row['Cost Price']),
      category: getCategory(row),
      stock: 50, // Default initial stock
    };
    
    mappedProducts.push(product);
  }
  
  console.log(`✅ Successfully mapped ${mappedProducts.length} products out of ${allData.length} total rows`);
  
  // Filter out any remaining products with empty data
  const finalProducts = mappedProducts.filter(p => p.barcode && p.name);
  
  console.log(`📦 Final product count after filtering: ${finalProducts.length}`);
  
  // Write Makeen_Import_Ready.json file
  fs.writeFileSync(OUTPUT_FILE, JSON.stringify(finalProducts, null, 2));
  console.log(`📄 Output written to: ${OUTPUT_FILE}`);
  
  console.log('🎉 Import process completed successfully!');
  console.log(`   - Total rows processed: ${allData.length}`);
  console.log(`   - Products mapped: ${mappedProducts.length}`);
  console.log(`   - Products final count: ${finalProducts.length}`);
}

// Run the import
importProducts();

export { importProducts };
export type { MappedProduct, RawProductData };
