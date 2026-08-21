import type { LocalBarcode, LocalCategory, LocalProduct, QuickKeyItem } from "@/types/pos.types";

export const mockCategories: LocalCategory[] = [
  { id: "cat-kitchen", name: "مستلزمات المطبخ", parentId: null, bgColor: "#0f766e", isQuickKey: true, sortOrder: 1 },
  { id: "cat-cleaning", name: "مواد التنظيف", parentId: null, bgColor: "#1d4ed8", isQuickKey: true, sortOrder: 2 },
  { id: "cat-dairy", name: "ألبان وأجبان", parentId: null, bgColor: "#b45309", isQuickKey: true, sortOrder: 3 },
  { id: "cat-produce", name: "خضار وفواكه", parentId: null, bgColor: "#15803d", isQuickKey: true, sortOrder: 4 },
  { id: "cat-drinks", name: "مياه ومشروبات", parentId: null, bgColor: "#0369a1", isQuickKey: true, sortOrder: 5 },
  { id: "cat-staples", name: "سكر ورز", parentId: null, bgColor: "#7c3aed", isQuickKey: true, sortOrder: 6 },
  { id: "cat-snacks", name: "شيبس ووجبات", parentId: null, bgColor: "#c2410c", isQuickKey: true, sortOrder: 7 },
  { id: "cat-oils", name: "زيوت ومواد أساسية", parentId: null, bgColor: "#a16207", isQuickKey: true, sortOrder: 8 },
];

export const mockProducts: LocalProduct[] = [
  { id: "p-cups", categoryId: "cat-kitchen", name: "كاسات بلاستيك 7 أونص", baseUnit: "حبة", isWeighed: false, price: 0.15, costPrice: 0.09 },
  { id: "p-roll", categoryId: "cat-kitchen", name: "رول سفرة نايلون", baseUnit: "لفة", isWeighed: false, price: 1.5, costPrice: 1.1 },
  { id: "p-towels", categoryId: "cat-kitchen", name: "بشاكير قطن", baseUnit: "حبة", isWeighed: false, price: 2.75, costPrice: 2.1 },
  { id: "p-glass", categoryId: "cat-cleaning", name: "منظف زجاج", baseUnit: "عبوة", isWeighed: false, price: 1.25, costPrice: 0.85 },
  { id: "p-bleach", categoryId: "cat-cleaning", name: "مبيض ملابس", baseUnit: "عبوة", isWeighed: false, price: 1.1, costPrice: 0.7 },
  { id: "p-milk", categoryId: "cat-dairy", name: "حليب طويل الأمد", baseUnit: "عبوة", isWeighed: false, price: 0.95, costPrice: 0.8 },
  { id: "p-lemon", categoryId: "cat-produce", name: "ليمون بلدي", baseUnit: "كغ", isWeighed: true, price: 1.2, costPrice: 0.8 },
  { id: "p-tomato", categoryId: "cat-produce", name: "بندورة بلدية", baseUnit: "كغ", isWeighed: true, price: 0.8, costPrice: 0.5 },
  { id: "p-water", categoryId: "cat-drinks", name: "ماء معدني 500 مل", baseUnit: "عبوة", isWeighed: false, price: 0.25, costPrice: 0.18 },
  { id: "p-sugar", categoryId: "cat-staples", name: "سكر رز 500 غم", baseUnit: "كيس", isWeighed: false, price: 0.55, costPrice: 0.45 },
  { id: "p-rice", categoryId: "cat-staples", name: "رز بسمتي 1 كغ", baseUnit: "كيس", isWeighed: false, price: 2.4, costPrice: 1.9 },
  { id: "p-chips", categoryId: "cat-snacks", name: "شيبس عائلي", baseUnit: "كيس", isWeighed: false, price: 0.35, costPrice: 0.25 },
  { id: "p-oil", categoryId: "cat-oils", name: "زيت دوار الشمس 1 لتر", baseUnit: "قارورة", isWeighed: false, price: 2.9, costPrice: 2.5 },
];

export const mockBarcodes: LocalBarcode[] = [
  { barcode: "12345", productId: "p-cups", variantId: "v-cups-1", variantLabel: "", unitName: "حبة", qtyMultiplier: 1, price: 0.15, costPrice: 0.09 },
  { barcode: "6250001234567", productId: "p-cups", variantId: "v-cups-2", variantLabel: "كرتونة", unitName: "كرتونة", qtyMultiplier: 100, price: 12.0, costPrice: 9.0 },
  { barcode: "6250001234574", productId: "p-roll", variantId: "v-roll-1", variantLabel: "", unitName: "لفة", qtyMultiplier: 1, price: 1.5, costPrice: 1.1 },
  { barcode: "6250001234581", productId: "p-towels", variantId: "v-towels-1", variantLabel: "", unitName: "حبة", qtyMultiplier: 1, price: 2.75, costPrice: 2.1 },
  { barcode: "6250001234598", productId: "p-towels", variantId: "v-towels-2", variantLabel: "كرتونة", unitName: "كرتونة", qtyMultiplier: 12, price: 29.99, costPrice: 24.0 },
  { barcode: "6291040123456", productId: "p-glass", variantId: "v-glass-1", variantLabel: "", unitName: "عبوة", qtyMultiplier: 1, price: 1.25, costPrice: 0.85 },
  { barcode: "6291040123463", productId: "p-bleach", variantId: "v-bleach-1", variantLabel: "", unitName: "عبوة", qtyMultiplier: 1, price: 1.1, costPrice: 0.7 },
  { barcode: "6291010253456", productId: "p-milk", variantId: "v-milk-1", variantLabel: "", unitName: "عبوة", qtyMultiplier: 1, price: 0.95, costPrice: 0.8 },
  { barcode: "6291010253470", productId: "p-milk", variantId: "v-milk-2", variantLabel: "كرتونة", unitName: "كرتونة", qtyMultiplier: 24, price: 21.6, costPrice: 18.0 },
  { barcode: "2000012345678", productId: "p-lemon", variantId: "v-lemon-1", variantLabel: "", unitName: "كغ", qtyMultiplier: 1, price: 1.2, costPrice: 0.8 },
  { barcode: "2000012345685", productId: "p-tomato", variantId: "v-tomato-1", variantLabel: "", unitName: "كغ", qtyMultiplier: 1, price: 0.8, costPrice: 0.5 },
  { barcode: "6250000987654", productId: "p-water", variantId: "v-water-1", variantLabel: "", unitName: "عبوة", qtyMultiplier: 1, price: 0.25, costPrice: 0.18 },
  { barcode: "6250000987661", productId: "p-water", variantId: "v-water-2", variantLabel: "كرتونة", unitName: "كرتونة", qtyMultiplier: 24, price: 5.4, costPrice: 4.2 },
  { barcode: "6250000987678", productId: "p-sugar", variantId: "v-sugar-1", variantLabel: "", unitName: "كيس", qtyMultiplier: 1, price: 0.55, costPrice: 0.45 },
  { barcode: "6250000987685", productId: "p-rice", variantId: "v-rice-1", variantLabel: "", unitName: "كيس", qtyMultiplier: 1, price: 2.4, costPrice: 1.9 },
  { barcode: "6250000987692", productId: "p-chips", variantId: "v-chips-1", variantLabel: "", unitName: "كيس", qtyMultiplier: 1, price: 0.35, costPrice: 0.25 },
  { barcode: "6250000987708", productId: "p-oil", variantId: "v-oil-1", variantLabel: "", unitName: "قارورة", qtyMultiplier: 1, price: 2.9, costPrice: 2.5 },
  { barcode: "6250000987715", productId: "p-oil", variantId: "v-oil-2", variantLabel: "كرتونة", unitName: "كرتونة", qtyMultiplier: 12, price: 33.0, costPrice: 28.0 },
];

export const mockQuickKeys: QuickKeyItem[] = [
  { id: "qk-cups", categoryId: "cat-kitchen", label: "كاسات بلاستيك", bgColor: "#0f766e", sortOrder: 1, productId: "p-cups", unitName: "حبة", price: 0.15 },
  { id: "qk-towels", categoryId: "cat-kitchen", label: "بشاكير قطن", bgColor: "#0f766e", sortOrder: 2, productId: "p-towels", unitName: "حبة", price: 2.75 },
  { id: "qk-roll", categoryId: "cat-kitchen", label: "رول سفرة", bgColor: "#0f766e", sortOrder: 3, productId: "p-roll", unitName: "لفة", price: 1.5 },
  { id: "qk-glass", categoryId: "cat-cleaning", label: "منظف زجاج", bgColor: "#1d4ed8", sortOrder: 4, productId: "p-glass", unitName: "عبوة", price: 1.25 },
  { id: "qk-bleach", categoryId: "cat-cleaning", label: "مبيض", bgColor: "#1d4ed8", sortOrder: 5, productId: "p-bleach", unitName: "عبوة", price: 1.1 },
  { id: "qk-milk", categoryId: "cat-dairy", label: "حليب", bgColor: "#b45309", sortOrder: 6, productId: "p-milk", unitName: "عبوة", price: 0.95 },
  { id: "qk-lemon", categoryId: "cat-produce", label: "ليمون (كغ)", bgColor: "#15803d", sortOrder: 7, productId: "p-lemon", unitName: "كغ", price: 1.2 },
  { id: "qk-tomato", categoryId: "cat-produce", label: "بندورة (كغ)", bgColor: "#15803d", sortOrder: 8, productId: "p-tomato", unitName: "كغ", price: 0.8 },
  { id: "qk-water", categoryId: "cat-drinks", label: "ماء", bgColor: "#0369a1", sortOrder: 9, productId: "p-water", unitName: "عبوة", price: 0.25 },
  { id: "qk-sugar", categoryId: "cat-staples", label: "سكر", bgColor: "#7c3aed", sortOrder: 10, productId: "p-sugar", unitName: "كيس", price: 0.55 },
  { id: "qk-rice", categoryId: "cat-staples", label: "رز بسمتي", bgColor: "#7c3aed", sortOrder: 11, productId: "p-rice", unitName: "كيس", price: 2.4 },
  { id: "qk-chips", categoryId: "cat-snacks", label: "شيبس", bgColor: "#c2410c", sortOrder: 12, productId: "p-chips", unitName: "كيس", price: 0.35 },
  { id: "qk-oil", categoryId: "cat-oils", label: "زيت", bgColor: "#a16207", sortOrder: 13, productId: "p-oil", unitName: "قارورة", price: 2.9 },
];
