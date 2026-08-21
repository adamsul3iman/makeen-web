/**
 * Smart Goods-In receiving store (Phase 3).
 *
 * Drives the mobile receiving module with an offline-first posture: every
 * commit is validated, serialized into a SUPPLIER_INVOICE_CREATED sync event,
 * and pushed through the IndexedDB queue — the same durable path the POS uses
 * for sales and expenses. The server mirror creates the products (Quick Add),
 * the supplier invoice + items + payment, applies PURCHASE_RECEIPT stock,
 * updates cost/retail prices, and records the linked cash-drawer deduction.
 *
 * The Negotiation Shield is computed from the offline price-history cache when
 * the device is unreachable and refreshed from the server when online.
 */

import { create } from "zustand";
import { persist } from "zustand/middleware";
import { usePosStore } from "./usePosStore";
import { enqueueSync, getSyncsByStatus, saveReceivingCache, loadReceivingCache, loadCatalogCache, loadCatalogBootCacheSync } from "../lib/idb";
import { posFetch, getTenantStoreId } from "../lib/tenantClient";
import { newUuid } from "../lib/uuid";
import { hasAnyReceivingCapability } from "../lib/permissions";
import {
  applyCashDrawerDeduction,
  buildNegotiationShield,
  buildReceivingSyncRecord,
  buildSupplierCreateSyncRecord,
  computeDueDate,
  computePaymentTotals,
  convertLineUnit,
  generateAutoInvoiceNumber,
  generateInternalSku,
  lineBaseUnitCost,
  maintainMarginRetailPrice,
  round2,
  validateReceivingDraft,
  RECEIVING_CATEGORY_LABEL,
} from "../lib/receiving";
import type {
  BarcodeLookup,
  LocalBarcode,
  LocalProduct,
  PosSnapshot,
} from "../types/pos.types";
import type {
  NegotiationShield,
  PurchaseRecord,
  QuickAddDefinition,
  ReceivingDraft,
  ReceivingDraftLine,
  ReceivingLineUnit,
  ReceivingPayment,
} from "../types/receiving.types";

function isoDate(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

function today(): string {
  return isoDate(new Date());
}

function dueAfterDays(days: number): string {
  const d = new Date();
  d.setDate(d.getDate() + days);
  return isoDate(d);
}

function emptyDraft(taxPercent = 16): ReceivingDraft {
  return {
    supplierId: null,
    supplierName: "",
    invoiceNumber: generateAutoInvoiceNumber(),
    invoiceDate: today(),
    dueDate: dueAfterDays(7),
    notes: "",
    lines: [],
    cashPaid: 0,
    payments: [],
    taxPercent,
  };
}

function defaultTaxPercent(): number {
  const store = usePosStore.getState().currentStore;
  const tax = typeof store?.taxPercent === "number" ? store.taxPercent : 16;
  return Number.isFinite(tax) && tax > 0 && tax <= 100 ? tax : 16;
}

/** Offline history for a barcode from the receiving cache ([] when absent). */
async function cachedHistoryFor(barcode: string): Promise<PurchaseRecord[]> {
  try {
    const storeId = usePosStore.getState().currentStore?.id ?? null;
    const cache = await loadReceivingCache(storeId);
    const row = cache?.histories?.[barcode];
    return Array.isArray(row?.history) ? (row.history as PurchaseRecord[]) : [];
  } catch {
    return [];
  }
}

/**
 * Resolve a scanned barcode to its catalog product. On a fresh page load the
 * in-memory `barcodeIndex` can still be empty — `usePosStoreHydrated()` only
 * reflects zustand's persist hydration, not the async `hydrateCatalog()` — so
 * the IndexedDB catalog mirror is read directly and loaded into the store.
 * Hydrating on first scan makes every later scan O(1) and, crucially, means a
 * known code NEVER falls through to the Quick-Add flow (the Phase 3.5 client
 * bug where POS checkout knew the code but receiving said "unknown").
 *
 * Returns `{ empty: true }` when the device has no catalog mirror at all
 * (fresh install, or storage eviction / private mode) — the caller must NOT
 * open Quick-Add in that state, because "not found" just means the catalog
 * has not finished loading. The mirror is re-fetched and a retry resolves it.
 */
async function findProductByBarcode(
  barcode: string,
): Promise<{ lookup: BarcodeLookup; barcodeMeta?: LocalBarcode; product: LocalProduct } | { empty: true } | null> {
  const pos = usePosStore.getState();
  const inMemoryLookup = pos.barcodeIndex[barcode];
  const inMemoryProduct = inMemoryLookup ? pos.products[inMemoryLookup.product_id] : undefined;
  if (inMemoryLookup && inMemoryProduct) {
    return { lookup: inMemoryLookup, barcodeMeta: pos.barcodes[barcode], product: inMemoryProduct };
  }

  const storeId = pos.currentStore?.id ?? getTenantStoreId() ?? null;
  if (!storeId) return null;
  try {
    // IndexedDB mirror first; when it is unavailable (evicted, private mode)
    // fall back to the synchronous localStorage boot mirror of the same
    // snapshot so a known code is still resolvable.
    const cache =
      (await loadCatalogCache(storeId).catch(() => null)) ??
      loadCatalogBootCacheSync(storeId);
    const inMemoryEmpty = Object.keys(pos.barcodeIndex).length === 0;
    if (!cache && inMemoryEmpty) {
      // No catalog data anywhere on this device yet (fresh install, storage
      // eviction, private mode) — "not found" means the catalog has not
      // finished loading, so the caller must NOT open Quick-Add. Kick the
      // hydration and let a retry resolve the code.
      void usePosStore.getState().hydrateCatalog().catch(() => undefined);
      return { empty: true };
    }
    if (!cache) return null;
    const hasCatalog = Object.keys(cache.products).length > 0;
    if (!hasCatalog && inMemoryEmpty) {
      void usePosStore.getState().hydrateCatalog().catch(() => undefined);
      return { empty: true };
    }
    if (!hasCatalog) return null;
    const lookup = cache.barcodeIndex[barcode];
    const product = lookup ? cache.products[lookup.product_id] : undefined;
    if (!lookup || !product) return null;
    usePosStore.getState().loadSnapshot({
      schemaVersion: 1,
      updatedAt: cache.updatedAt,
      categories: cache.categories,
      products: cache.products,
      barcodes: cache.barcodes,
      barcodeIndex: cache.barcodeIndex,
      quickKeys: cache.quickKeys,
      cashiers: cache.cashiers,
      pinSalt: cache.pinSalt,
    } satisfies PosSnapshot);
    return { lookup, barcodeMeta: cache.barcodes[barcode], product };
  } catch {
    return null;
  }
}

/** Resolve the current tenant id the way every offline cache key does. */
function receivingStoreId(): string | null {
  return usePosStore.getState().currentStore?.id ?? getTenantStoreId() ?? null;
}

export interface ReceivingNotice {
  tone: "error" | "success" | "info";
  message: string;
}

interface ReceivingStoreState {
  draft: ReceivingDraft;
  suppliers: Record<string, { id: string; name: string; phone?: string; balance?: number; paymentTermsDays?: number }>;
  suppliersLoaded: boolean;
  /** barcode -> latest shield (holds the last-3 purchase history). */
  shieldByBarcode: Record<string, NegotiationShield>;
  /** barcode awaiting a Quick-Add definition (unknown barcode scan). */
  quickAddTarget: string | null;
  notice: ReceivingNotice | null;
  isCommitting: boolean;
}

interface ReceivingStoreActions {
  startNewDraft: () => void;
  setSupplier: (supplierId: string, supplierName: string, paymentTermsDays?: number) => void;
  setInvoiceMeta: (patch: Partial<Pick<ReceivingDraft, "invoiceNumber" | "invoiceDate" | "dueDate" | "notes" | "taxPercent">>) => void;
  loadSuppliers: () => Promise<void>;
  addSupplier: (input: { name: string; phone?: string }) => Promise<{ ok: boolean; error?: string; supplierId?: string }>;
  scanBarcode: (raw: string) => Promise<void>;
  loadPriceHistory: (barcode: string) => Promise<void>;
  updateLineCost: (key: string, unitCost: number) => void;
  updateLineQuantity: (key: string, quantity: number) => void;
  updateLineUnit: (key: string, unit: ReceivingLineUnit) => void;
  overrideMarginWarning: (key: string) => void;
  acceptSuggestedRetail: (key: string) => void;
  declineRetailPrompt: (key: string) => void;
  removeLine: (key: string) => void;
  setCashPaid: (amount: number) => void;
  setPayments: (payments: ReceivingPayment[]) => void;
  openQuickAdd: (barcode: string) => void;
  cancelQuickAdd: () => void;
  quickAdd: (definition: QuickAddDefinition) => void;
  commitDraft: () => Promise<{ ok: boolean; error?: string }>;
  clearNotice: () => void;
  setNotice: (message: string, tone?: ReceivingNotice["tone"]) => void;
}

export type ReceivingStore = ReceivingStoreState & ReceivingStoreActions;

function buildShieldForLine(
  line: ReceivingDraftLine,
  history: PurchaseRecord[],
  catalogCost: number,
  catalogRetail: number,
): NegotiationShield {
  return buildNegotiationShield({
    barcode: line.barcode,
    description: line.description,
    currentCost: catalogCost,
    currentRetail: catalogRetail,
    lastPurchases: history,
    enteredCost: lineBaseUnitCost(line),
  });
}

/** Base + pack units offered by a scanned barcode for the per-line toggle. */
function buildLineUnits(baseUnit: string, qtyMultiplier?: number): ReceivingLineUnit[] {
  const units: ReceivingLineUnit[] = [{ multiplier: 1, name: baseUnit }];
  const pack = Number.isFinite(qtyMultiplier) && (qtyMultiplier ?? 0) > 1 ? qtyMultiplier ?? 1 : null;
  if (pack) units.push({ multiplier: pack, name: `كرتونة ×${pack}` });
  return units;
}

export const useReceivingStore = create<ReceivingStore>()(
  persist(
    (set, get) => ({
      draft: emptyDraft(),
      suppliers: {},
      suppliersLoaded: false,
      shieldByBarcode: {},
      quickAddTarget: null,
      notice: null,
      isCommitting: false,

      setNotice: (message, tone = "info") => set({ notice: { tone, message } }),
      clearNotice: () => set({ notice: null }),

      startNewDraft: () =>
        set({
          draft: emptyDraft(defaultTaxPercent()),
          quickAddTarget: null,
          notice: null,
        }),

      setSupplier: (supplierId, supplierName, paymentTermsDays = 0) =>
        set((state) => {
          const days = Number.isFinite(paymentTermsDays) && paymentTermsDays > 0 ? Math.floor(paymentTermsDays) : 0;
          const dueDate =
            days > 0 && /^\d{4}-\d{2}-\d{2}$/.test(state.draft.invoiceDate)
              ? computeDueDate(state.draft.invoiceDate, days)
              : state.draft.dueDate;
          return { draft: { ...state.draft, supplierId, supplierName, dueDate } };
        }),

      setInvoiceMeta: (patch) =>
        set((state) => ({ draft: { ...state.draft, ...patch } })),

      loadSuppliers: async () => {
        const storeId = usePosStore.getState().currentStore?.id ?? null;
        try {
          const cached = await loadReceivingCache(storeId);
          if (cached?.suppliers && Object.keys(cached.suppliers).length > 0) {
            set({ suppliers: cached.suppliers, suppliersLoaded: true });
          }
        } catch {
          // IndexedDB unavailable — fall through to the network.
        }
        try {
          const res = await posFetch("/api/receiving/suppliers");
          if (!res.ok) return;
          const body = (await res.json()) as {
            suppliers?: Array<{ id: string; name: string; balance?: number; paymentTermsDays?: number }>;
          };
          const suppliers = Object.fromEntries(
            (body.suppliers ?? []).map((s) => [
              s.id,
              { id: s.id, name: s.name, balance: s.balance ?? 0, paymentTermsDays: s.paymentTermsDays ?? 0 },
            ]) as [string, { id: string; name: string; balance?: number; paymentTermsDays?: number }][],
          );
          if (Object.keys(suppliers).length > 0) {
            set({ suppliers, suppliersLoaded: true });
            await saveReceivingCache({ histories: {}, suppliers, updatedAt: new Date().toISOString() }, storeId).catch(() => undefined);
          }
        } catch {
          // Offline — the cached list (if any) already filled the picker.
        }
      },

      addSupplier: async ({ name, phone }) => {
        const trimmedName = (name ?? "").trim();
        if (!trimmedName) {
          set({ notice: { tone: "error", message: "أدخل اسم المورد" } });
          return { ok: false, error: "supplier_name_required" };
        }
        const pos = usePosStore.getState();
        const cashier = pos.currentCashier;
        const id = newUuid();
        const entry = {
          id,
          name: trimmedName,
          phone: (phone ?? "").trim(),
          balance: 0,
          paymentTermsDays: 0,
        };
        const storeId = receivingStoreId();

        // Offline-first: the picker must work instantly even without the server.
        set((state) => ({ suppliers: { ...state.suppliers, [id]: entry } }));

        // Persist the picker list so a restart keeps the new vendor.
        try {
          const existingCache = await loadReceivingCache(storeId);
          await saveReceivingCache(
            { histories: existingCache?.histories ?? {}, suppliers: get().suppliers, updatedAt: new Date().toISOString() },
            storeId,
          );
        } catch {
          // IndexedDB unavailable — the in-memory picker still works.
        }

        // Queue the server-side create (idempotent by client id) so an offline
        // add mirrors before the invoice that references it drains.
        const ctx = {
          syncId: newUuid(),
          branchId: pos.activeBranchId ?? pos.shiftState.branchId ?? null,
          terminalId: pos.activeTerminalId ?? pos.shiftState.terminalId ?? null,
          cashierId: cashier?.id ?? null,
          cashierName: cashier?.name,
        };
        try {
          await enqueueSync(buildSupplierCreateSyncRecord({ id, name: trimmedName, phone: entry.phone }, ctx));
        } catch {
          // The picker entry is already usable; a later sync pass will create it.
        }

        // Try an immediate online create so a live device sees the real row
        // now (and the SUPPLIER_CREATE mirror in the queue is a no-op).
        try {
          const res = await posFetch("/api/receiving/suppliers", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ id, name: trimmedName, phone: entry.phone }),
          });
          if (res.ok) {
            const body = (await res.json()) as {
              supplier?: { id?: string; name?: string; phone?: string; balance?: number; paymentTermsDays?: number };
            };
            const row = body.supplier;
            if (row?.id) {
              set((state) => ({
                suppliers: {
                  ...state.suppliers,
                  [row.id!]: {
                    id: row.id!,
                    name: row.name ?? trimmedName,
                    phone: row.phone ?? entry.phone,
                    balance: row.balance ?? 0,
                    paymentTermsDays: row.paymentTermsDays ?? 0,
                  },
                },
              }));
            }
          }
        } catch {
          // Offline — the queued SUPPLIER_CREATE mirror will create the row.
        }

        // Auto-select the new vendor without touching the current draft lines.
        get().setSupplier(id, trimmedName, 0);
        set({ notice: { tone: "success", message: `تمت إضافة المورد "${trimmedName}"` } });
        return { ok: true, supplierId: id };
      },

      scanBarcode: async (raw) => {
        const barcode = (raw ?? "").trim();
        if (!barcode) return;
        const resolved = await findProductByBarcode(barcode);
        if (!resolved) {
          set({ quickAddTarget: barcode, notice: { tone: "info", message: "باركود غير معروف — أضف الصنف أو امسح رمزاً آخر" } });
          return;
        }
        if ("empty" in resolved) {
          // The device has no catalog mirror loaded yet (fresh install,
          // storage eviction or private mode). This is NOT an unknown code:
          // Quick-Add must never open for it — the catalog is mid-hydration.
          set({ notice: { tone: "info", message: "الكتالوج قيد التحميل — أعد المحاولة بعد لحظات" } });
          return;
        }

        const { barcodeMeta, product } = resolved;
        const catalogCost = barcodeMeta?.costPrice ?? product.costPrice ?? 0;
        const catalogRetail = barcodeMeta?.price ?? product.price ?? 0;
        const taxPercent = product.taxPercent ?? get().draft.taxPercent;
        const baseUnit = barcodeMeta?.unitName ?? product.baseUnit;
        const description = product.name;

        const existing = get().draft.lines.find((l) => l.key === barcode);
        let draft: ReceivingDraft;
        if (existing) {
          draft = {
            ...get().draft,
            lines: get().draft.lines.map((l) =>
              l.key === barcode ? { ...l, quantity: round2(l.quantity + 1) } : l,
            ),
          };
        } else {
          draft = {
            ...get().draft,
            lines: [
              ...get().draft.lines,
              {
                key: barcode,
                productId: product.id,
                barcode,
                description,
                quantity: 1,
                unitCost: catalogCost,
                taxPercent,
                baseUnit,
                multiplier: barcodeMeta?.qtyMultiplier ?? 1,
                unitName: baseUnit,
                units: buildLineUnits(baseUnit, barcodeMeta?.qtyMultiplier),
                currentRetail: catalogRetail,
                currentCost: catalogCost,
                applyCost: true,
                newRetailPrice: null,
                isNewProduct: false,
              },
            ],
          };
        }
        set({ draft, quickAddTarget: null });

        const line = draft.lines.find((l) => l.key === barcode);
        if (line) {
          const history = await cachedHistoryFor(barcode);
          const shield = buildShieldForLine(line, history, catalogCost, catalogRetail);
          set((state) => ({ shieldByBarcode: { ...state.shieldByBarcode, [barcode]: shield } }));
        }

        void get().loadPriceHistory(barcode);
      },

      loadPriceHistory: async (barcode) => {
        try {
          const res = await posFetch(`/api/receiving/price-history?barcode=${encodeURIComponent(barcode)}`);
          if (!res.ok) return;
          const body = (await res.json()) as {
            currentCost?: number;
            currentRetail?: number;
            description?: string;
            history?: PurchaseRecord[];
          };
          const history = Array.isArray(body.history) ? body.history : [];
          const storeId = usePosStore.getState().currentStore?.id ?? null;
          const existingCache = await loadReceivingCache(storeId).catch(() => null);
          await saveReceivingCache(
            {
              histories: {
                ...(existingCache?.histories ?? {}),
                [barcode]: {
                  barcode,
                  description: body.description ?? barcode,
                  currentCost: body.currentCost ?? 0,
                  currentRetail: body.currentRetail ?? 0,
                  history,
                },
              },
              suppliers: existingCache?.suppliers ?? get().suppliers,
              updatedAt: new Date().toISOString(),
            },
            storeId,
          ).catch(() => undefined);

          const line = get().draft.lines.find((l) => l.key === barcode);
          if (line) {
            const shield = buildShieldForLine(line, history, body.currentCost ?? 0, body.currentRetail ?? 0);
            set((state) => ({ shieldByBarcode: { ...state.shieldByBarcode, [barcode]: shield } }));
          }
        } catch {
          // Offline — the cached shield/history already rendered the card.
        }
      },

      updateLineCost: (key, unitCost) => {
        const value = round2(Number.isFinite(unitCost) ? Math.max(0, unitCost) : 0);
        const line = get().draft.lines.find((l) => l.key === key);
        if (!line) return;
        const updated = { ...line, unitCost: value, retailPromptDismissed: false };
        const draft = { ...get().draft, lines: get().draft.lines.map((l) => (l.key === key ? updated : l)) };
        const shield = get().shieldByBarcode[key];
        if (shield) {
          const nextShield = buildShieldForLine(updated, shield.lastPurchases, shield.currentCost, shield.currentRetail);
          set({ draft, shieldByBarcode: { ...get().shieldByBarcode, [key]: nextShield } });
        } else {
          set({ draft });
        }
      },

      updateLineUnit: (key, unit) => {
        const line = get().draft.lines.find((l) => l.key === key);
        if (!line) return;
        const converted = convertLineUnit(line, unit.multiplier);
        const updated = {
          ...line,
          quantity: converted.quantity,
          unitCost: converted.unitCost,
          multiplier: converted.multiplier,
          unitName: unit.name,
          retailPromptDismissed: false,
        };
        const draft = { ...get().draft, lines: get().draft.lines.map((l) => (l.key === key ? updated : l)) };
        const shield = get().shieldByBarcode[key];
        set({
          draft,
          shieldByBarcode: shield
            ? { ...get().shieldByBarcode, [key]: buildShieldForLine(updated, shield.lastPurchases, shield.currentCost, shield.currentRetail) }
            : get().shieldByBarcode,
        });
      },

      overrideMarginWarning: (key) =>
        set((state) => ({
          draft: {
            ...state.draft,
            lines: state.draft.lines.map((l) => (l.key === key ? { ...l, marginOverride: true } : l)),
          },
          notice: { tone: "info", message: "تم تأكيد تجاوز الحد الأدنى لهامش الربح لهذا الصنف" },
        })),

      updateLineQuantity: (key, quantity) => {
        const value = Number.isFinite(quantity) ? Math.max(0, quantity) : 0;
        set((state) => ({
          draft: {
            ...state.draft,
            lines: state.draft.lines.map((l) => (l.key === key ? { ...l, quantity: round2(value) } : l)),
          },
        }));
      },

      acceptSuggestedRetail: (key) => {
        const shield = get().shieldByBarcode[key];
        const line = get().draft.lines.find((l) => l.key === key);
        if (!line || !shield) return;
        const price = shield.suggestedRetail > 0 ? shield.suggestedRetail : maintainMarginRetailPrice(line.unitCost, 0, 0);
        set((state) => ({
          draft: {
            ...state.draft,
            lines: state.draft.lines.map((l) =>
              l.key === key ? { ...l, newRetailPrice: price, retailPromptDismissed: true } : l,
            ),
          },
          notice: { tone: "success", message: `تم تحديث سعر البيع إلى ${price.toFixed(2)}` },
        }));
      },

      declineRetailPrompt: (key) => {
        set((state) => ({
          draft: {
            ...state.draft,
            lines: state.draft.lines.map((l) =>
              l.key === key ? { ...l, retailPromptDismissed: true } : l,
            ),
          },
        }));
      },

      removeLine: (key) => {
        const draft = { ...get().draft, lines: get().draft.lines.filter((l) => l.key !== key) };
        const shieldByBarcode = { ...get().shieldByBarcode };
        delete shieldByBarcode[key];
        set({ draft, shieldByBarcode });
      },

      setCashPaid: (amount) => {
        const value = round2(Number.isFinite(amount) ? Math.max(0, amount) : 0);
        set((state) => ({ draft: { ...state.draft, cashPaid: value } }));
      },

      setPayments: (payments) =>
        set((state) => {
          const normalized = Array.isArray(payments) ? payments : [];
          const cashPortion = computePaymentTotals(0, normalized).cashPortion;
          return { draft: { ...state.draft, payments: normalized, cashPaid: cashPortion } };
        }),

      openQuickAdd: (barcode) => set({ quickAddTarget: barcode }),
      cancelQuickAdd: () => set({ quickAddTarget: null }),

      quickAdd: (definition) => {
        const target = get().quickAddTarget;
        const barcode = target && target.length > 0 ? target : generateInternalSku(definition.name);
        const line: ReceivingDraftLine = {
          key: barcode,
          productId: null,
          barcode,
          description: definition.name.trim(),
          quantity: 1,
          unitCost: round2(Math.max(0, definition.cost)),
          taxPercent: definition.taxPercent,
          baseUnit: definition.baseUnit || "حبة",
          multiplier: 1,
          unitName: definition.baseUnit || "حبة",
          units: [{ multiplier: 1, name: definition.baseUnit || "حبة" }],
          currentRetail: round2(Math.max(0, definition.retailPrice)),
          currentCost: round2(Math.max(0, definition.cost)),
          applyCost: true,
          newRetailPrice: round2(Math.max(0, definition.retailPrice)),
          isNewProduct: true,
          categoryId: definition.categoryId ?? undefined,
          categoryName: definition.categoryName?.trim() || undefined,
          brandId: definition.brandId ?? undefined,
          brandName: definition.brandName?.trim() || undefined,
          parentName: definition.name.trim(),
          variantLabel: definition.variantLabel?.trim() || undefined,
        };
        const existing = get().draft.lines.find((l) => l.key === barcode);
        const draft = existing
          ? { ...get().draft, lines: get().draft.lines.map((l) => (l.key === barcode ? { ...l, quantity: round2(l.quantity + 1) } : l)) }
          : { ...get().draft, lines: [...get().draft.lines, line] };
        set({ draft, quickAddTarget: null, notice: { tone: "success", message: `تمت إضافة "${definition.name.trim()}"` } });

        const now = new Date().toISOString();
        void saveReceivingCache(
          {
            histories: {
              [barcode]: {
                barcode,
                description: definition.name.trim(),
                currentCost: line.unitCost,
                currentRetail: line.newRetailPrice ?? 0,
                history: [{
                  cost: line.unitCost,
                  supplierId: draft.supplierId ?? "",
                  supplierName: draft.supplierName || "إضافة سريعة",
                  invoiceNumber: "",
                  purchasedAt: now,
                  quantity: 1,
                }],
              },
            },
            suppliers: get().suppliers,
            updatedAt: now,
          },
          usePosStore.getState().currentStore?.id ?? null,
        ).catch(() => undefined);
      },

      commitDraft: async () => {
        const state = get();
        if (state.isCommitting) return { ok: false, error: "already_committing" };
        const pos = usePosStore.getState();
        const cashier = pos.currentCashier;
        if (!hasAnyReceivingCapability(cashier)) {
          set({ notice: { tone: "error", message: "هذا الدور لا يملك صلاحية استلام البضاعة" } });
          return { ok: false, error: "no_capability" };
        }
        if (!pos.currentStore) {
          set({ notice: { tone: "error", message: "جلسة المتجر غير متاحة" } });
          return { ok: false, error: "no_store" };
        }

        const draft = state.draft;
        const shift = pos.shiftState.status === "OPEN" && pos.shiftState.shiftId
          ? { shiftId: pos.shiftState.shiftId, status: pos.shiftState.status }
          : null;
        const ctx = {
          syncId: newUuid(),
          cashierId: cashier?.id ?? null,
          cashierName: cashier?.name,
          branchId: pos.activeBranchId ?? pos.shiftState.branchId ?? null,
          terminalId: pos.activeTerminalId ?? pos.shiftState.terminalId ?? null,
          shift,
          drawerExpenseId: newUuid(),
        };

        const validationError = validateReceivingDraft(draft, ctx);
        if (validationError) {
          set({ notice: { tone: "error", message: validationError } });
          return { ok: false, error: validationError };
        }

        set({ isCommitting: true });
        try {
          const record = buildReceivingSyncRecord(draft, ctx);
          await enqueueSync(record);

          if (draft.cashPaid > 0) {
            const prev = pos.shiftTotals;
            usePosStore.setState({ shiftTotals: applyCashDrawerDeduction(prev, draft.cashPaid) });
          }
          const pendingSyncCount = (await getSyncsByStatus("PENDING")).length;
          usePosStore.setState({ pendingSyncCount });

          set({
            draft: emptyDraft(defaultTaxPercent()),
            shieldByBarcode: {},
            quickAddTarget: null,
            isCommitting: false,
            notice: {
              tone: "success",
              message: draft.cashPaid > 0
                ? `تم حفظ الفاتورة — خصم ${draft.cashPaid.toFixed(2)} من الصندوق (${RECEIVING_CATEGORY_LABEL})`
                : "تم حفظ الفاتورة وستتم مزامنتها تلقائياً",
            },
          });
          return { ok: true };
        } catch (error) {
          console.error("Failed to persist supplier invoice locally:", error);
          set({ isCommitting: false, notice: { tone: "error", message: "فشل حفظ الفاتورة محلياً" } });
          return { ok: false, error: "local_persist_failed" };
        }
      },
    }),
    {
      name: "pos-receiving",
      partialize: (state) => ({
        draft: state.draft,
        suppliers: state.suppliers,
        shieldByBarcode: state.shieldByBarcode,
      }),
    },
  ),
);
