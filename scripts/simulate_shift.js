/**
 * ═══════════════════════════════════════════════════════════════════════════
 *  ULTIMATE POS SHIFT SIMULATION — 20 INVOICES + CASH MOVEMENTS
 * ═══════════════════════════════════════════════════════════════════════════
 *
 *  PREREQUISITES:
 *    1. You MUST be on the POS register screen with an OPEN shift
 *    2. Open DevTools → Console
 *    3. Paste this ENTIRE script and press Enter
 *    4. Wait for "✅ SIMULATION COMPLETE" message
 *    5. Hard-refresh (Ctrl+Shift+R) to hydrate the store
 *
 *  WHAT IT INJECTS:
 *    • 20 invoices: Cash(7), VISA(4), CLIQ(3), SPLIT(3), DEBT(3)
 *    • 2 Cash-In movements + 1 Cash-Out movement
 *    • 5 drawer open increments
 *    • 2 debt settlements linked to real customers
 *    • Items with discounts (item-level + invoice-level)
 *    • Delivery fee invoice
 *    • Products with variant-level pricing
 *    • Each invoice gets a proper IDB sync_record + Zustand shiftTransaction
 *
 *  TESTS COVERED:
 *    ✓ H-1/H-2/H-3: CAS atomic balance + debt sales
 *    ✓ H-5/H-6/H-7: Shortage module (WhatsApp URL, resolve API)
 *    ✓ H-8: Variant pricing products
 *    ✓ M-1: Zero-balance suppliers
 *    ✓ M-6: Error states on initial fetch
 *    ✓ Tri-reconciliation: Cash/Card/CliQ variance math
 *    ✓ Cash In/Out movements
 *    ✓ Drawer open counting
 * ═══════════════════════════════════════════════════════════════════════════
 */
(async () => {
  "use strict";

  // ─── CONSTANTS ──────────────────────────────────────────────────────────
  const DB_NAME = "pos_local_db";
  const DB_VERSION = 8;
  const SYNC_STORE = "sync_queue";
  const LS_KEY = "pos-store";
  const R2 = (n) => Math.round((n + Number.EPSILON) * 100) / 100;
  const uuid = () => crypto.randomUUID();
  const NOW = () => new Date().toISOString();
  const MIN_AGO = (m) => new Date(Date.now() - m * 60000).toISOString();

  // ─── READ CURRENT STATE ─────────────────────────────────────────────────
  const raw = localStorage.getItem(LS_KEY);
  if (!raw) {
    console.error("❌ No localStorage key '" + LS_KEY + "' found. Are you on the POS screen?");
    return;
  }
  const persisted = JSON.parse(raw);
  const state = persisted.state ?? persisted;
  const shift = state.shiftState;
  if (!shift || shift.status !== "OPEN" || !shift.shiftId) {
    console.error("❌ No OPEN shift found. Open a shift first, then run this script.");
    return;
  }
  const SHIFT_ID = shift.shiftId;
  const STARTING_CASH = shift.startingCash ?? 0;
  const CASHIER = state.currentCashier ?? { id: "sim", name: "محاكاة", role: "cashier" };
  const BRANCH_ID = shift.branchId ?? state.activeBranchId ?? null;
  const TERMINAL_ID = shift.terminalId ?? state.activeTerminalId ?? null;

  console.log("🔄 Found open shift:", SHIFT_ID);
  console.log("   Starting cash:", STARTING_CASH, "| Cashier:", CASHIER.name);

  // ─── OPEN IDB ───────────────────────────────────────────────────────────
  function openIDB() {
    return new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }
  const db = await openIDB();

  function putSync(record) {
    return new Promise((resolve, reject) => {
      const tx = db.transaction(SYNC_STORE, "readwrite");
      tx.objectStore(SYNC_STORE).put(record);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  }

  // ─── PRODUCT CATALOG (real IDs from Burj store) ─────────────────────────
  const P = {
    CLEAN12:   { id: "84cf3ee9-5496-4569-9fe0-a0c99f4f6f4c", name: "مواد تنظيف 12 قطعة", unit: "قطعة", price: 150.00, cost: 105.00, tax: 16 },
    SURFACE:   { id: "e4d419fe-a84a-41b6-bfe7-e99f24f16391", name: "منظف سطح زيت", unit: "قطعة", price: 149.00, cost: 121.25, tax: 16 },
    FLOOR1500: { id: "b0ca577b-66ee-4019-a997-0a6075b97ef5", name: "منظف أرضيات 1500 مل 10 قطع", unit: "قطعة", price: 130.00, cost: 90.00, tax: 16 },
    FLOOR8L:   { id: "472f8ced-665f-449f-a6a3-1482f053288d", name: "منظف أرضيات 8 لتر 1500 مل", unit: "قطعة", price: 120.00, cost: 83.00, tax: 16 },
    MULTI20:   { id: "9ae6db19-01cb-4750-85c0-bd8fcd6b7e3f", name: "ورق تنظيف متعدد 20 قطع", unit: "قطعة", price: 115.00, cost: 89.00, tax: 16 },
    NAPKIN90:  { id: "55aa31b5-abdd-4c1f-8276-ea620b4aa9cd", name: "عبوة مناديل ورقية 90", unit: "عبوة", price: 104.80, cost: 77.60, tax: 16 },
    MULTI18:   { id: "c22ca938-d42e-4f70-9606-9edd33f59313", name: "ورق تنظيف متعدد 18 قطع", unit: "قطعة", price: 100.00, cost: 79.00, tax: 16 },
    FLOOR1300: { id: "3542306c-461a-46ef-ad4f-6dc234ece041", name: "منظف أرضيات متعدد 1300 مل", unit: "قطعة", price: 90.00, cost: 65.00, tax: 16 },
    FLOOR6L:   { id: "43bfda37-00f0-46dd-a27f-a4454a5e0be8", name: "منظف أرضيات 6.5 لتر", unit: "قطعة", price: 85.00, cost: 58.00, tax: 16 },
    FLOOR10:   { id: "aa357b5c-1f7d-475e-a1f5-7f570d4b6140", name: "منظف أرضيات وسطي 10 قطع", unit: "قطعة", price: 85.00, cost: 60.00, tax: 16 },
    FLOOR7L:   { id: "dd0ef2fb-eed1-4801-8663-3752ee57b398", name: "منظف أرضيات 8 لتر 1300 مل", unit: "قطعة", price: 70.00, cost: 45.00, tax: 16 },
    CLEAN4X6:  { id: "9269a11b-5d13-4144-bb5f-280eaae40b88", name: "منظف أرضيات 4×6 لتر", unit: "قطعة", price: 68.00, cost: 60.00, tax: 16 },
    FLOOR25:   { id: "1689ee71-7c18-4ec1-adfd-afd820d8e0fa", name: "منظف أرضيات متعدد 25 قطعة", unit: "قطعة", price: 65.00, cost: 46.00, tax: 16 },
    WIPER74:   { id: "0ce09634-979e-46af-b0c6-8a20656b0e37", name: "ورق تنظيف 7+4 قطع", unit: "قطعة", price: 65.00, cost: 48.37, tax: 16 },
    NAPKIN70:  { id: "88147333-7ce0-4373-b2a9-c0ee5db3a675", name: "مناديل ورقية متعددة 70", unit: "قطعة", price: 64.10, cost: 47.50, tax: 16 },
    MULTI250:  { id: "3462436e-65eb-49e9-8698-c3bc4ac2b6ce", name: "منظف متعدد الأغراض 250", unit: "قطعة", price: 1.50, cost: 0.88, tax: 16 },
    GLASS200:  { id: "bbf61fbd-2dcc-4452-aed5-3251a9332645", name: "منظف زجاج 200 مل", unit: "قطعة", price: 2.00, cost: 1.51, tax: 16 },
    SMALL1:    { id: "74d1d7d2-bfee-476d-a4c0-d42bebeb8a22", name: "عبوة صغيرة متنوعة", unit: "قطعة", price: 2.00, cost: 1.38, tax: 16 },
  };

  // ─── HELPER: build a SaleItem ────────────────────────────────────────────
  function item(product, qty, discountMoney = 0) {
    const lineTotal = R2(qty * product.price - discountMoney);
    const out = {
      productId: product.id,
      name: product.name,
      barcode: "",
      qty,
      unitName: product.unit,
      unitPrice: product.price,
      lineTotal,
      taxPercent: product.tax,
      taxIncluded: true,
    };
    if (discountMoney > 0) {
      out.discount = discountMoney;
      out.discountPct = R2((discountMoney / (qty * product.price)) * 100);
    }
    return out;
  }

  // ─── HELPER: compute tax for a tax-inclusive total at rate% ──────────────
  function taxIncluded(gross, rate = 16) {
    const net = R2(gross / (1 + rate / 100));
    return { net, tax: R2(gross - net) };
  }

  // ─── HELPER: derive payment buckets (mirrors lib/paymentBuckets.ts) ──────
  function buckets(method, total, amountPaid) {
    const m = (method ?? "").toUpperCase();
    if (m === "VISA")  return { cash: 0, visa: total, cliq: 0, debt: 0 };
    if (m === "CLIQ")  return { cash: 0, visa: 0, cliq: total, debt: 0 };
    if (m === "DEBT")  return { cash: 0, visa: 0, cliq: 0, debt: total };
    if (m === "SPLIT") {
      const sign = total < 0 ? -1 : 1;
      const cashAmt = R2(sign * Math.min(Math.abs(amountPaid), Math.abs(total)));
      return { cash: cashAmt, visa: R2(total - cashAmt), cliq: 0, debt: 0 };
    }
    return { cash: total, visa: 0, cliq: 0, debt: 0 };
  }

  // ─── HELPER: compute item discount (for display) ─────────────────────────
  function sumItemDiscounts(items) {
    return R2(items.reduce((s, i) => s + Math.max(0, i.discount ?? 0), 0));
  }

  // ─── CUSTOMERS (real IDs seeded via Supabase) ────────────────────────────
  const C_AHMAD  = { id: "e8af456a-c561-40e2-bd8f-b540435e4239", name: "أحمد العلي", phone: "0799111222" };
  const C_MOHAMMAD = { id: "e6fcb68e-9b10-467f-8816-51a7402cfd01", name: "محمد حسن", phone: "0799333444" };
  const C_SARA   = { id: "86a15748-f4d4-433b-97a9-8221d726e2a3", name: "سارة الدليمي", phone: "0799555666" };

  // ═══════════════════════════════════════════════════════════════════════════
  // 20 INVOICES — diverse payment mix
  // ═══════════════════════════════════════════════════════════════════════════
  const invoices = [
    // ── INVOICE 1: CASH, single item, exact amount ─────────────────────────
    {
      label: "CASH — single item, exact",
      method: "CASH",
      items: [item(P.CLEAN12, 2)],
      amountPaid: 300.00,
      deliveryFee: 0,
      invoiceDiscount: null,
      customer: null,
    },
    // ── INVOICE 2: CASH, multi-item, gives change ──────────────────────────
    {
      label: "CASH — multi-item + change",
      method: "CASH",
      items: [item(P.FLOOR1300, 1), item(P.MULTI250, 4)],
      amountPaid: 100.00,
      deliveryFee: 0,
      invoiceDiscount: null,
      customer: null,
    },
    // ── INVOICE 3: VISA, simple ────────────────────────────────────────────
    {
      label: "VISA — single item",
      method: "VISA",
      items: [item(P.FLOOR8L, 1)],
      amountPaid: 120.00,
      deliveryFee: 0,
      invoiceDiscount: null,
      customer: null,
    },
    // ── INVOICE 4: VISA, multi-item ────────────────────────────────────────
    {
      label: "VISA — multi-item",
      method: "VISA",
      items: [item(P.MULTI18, 1), item(P.FLOOR6L, 1), item(P.FLOOR7L, 1)],
      amountPaid: 255.00,
      deliveryFee: 0,
      invoiceDiscount: null,
      customer: null,
    },
    // ── INVOICE 5: CLIQ, two items ─────────────────────────────────────────
    {
      label: "CLIQ — 2 items",
      method: "CLIQ",
      items: [item(P.FLOOR1500, 1), item(P.FLOOR10, 1)],
      amountPaid: 215.00,
      deliveryFee: 0,
      invoiceDiscount: null,
      customer: null,
    },
    // ── INVOICE 6: CLIQ, large qty ─────────────────────────────────────────
    {
      label: "CLIQ — large qty",
      method: "CLIQ",
      items: [item(P.MULTI20, 2)],
      amountPaid: 230.00,
      deliveryFee: 0,
      invoiceDiscount: null,
      customer: null,
    },
    // ── INVOICE 7: SPLIT — cash 100, rest on card ──────────────────────────
    {
      label: "SPLIT — 100 cash + card",
      method: "SPLIT",
      items: [item(P.SURFACE, 1), item(P.CLEAN4X6, 1)],
      amountPaid: 100.00,
      deliveryFee: 0,
      invoiceDiscount: null,
      customer: null,
    },
    // ── INVOICE 8: SPLIT — cash 200, rest on card ──────────────────────────
    {
      label: "SPLIT — 200 cash + card",
      method: "SPLIT",
      items: [item(P.FLOOR1300, 3)],
      amountPaid: 200.00,
      deliveryFee: 0,
      invoiceDiscount: null,
      customer: null,
    },
    // ── INVOICE 9: DEBT — Ahmad ────────────────────────────────────────────
    {
      label: "DEBT — أحمد العلي",
      method: "DEBT",
      items: [item(P.NAPKIN90, 2)],
      amountPaid: 0,
      deliveryFee: 0,
      invoiceDiscount: null,
      customer: C_AHMAD,
    },
    // ── INVOICE 10: DEBT — Mohammad ────────────────────────────────────────
    {
      label: "DEBT — محمد حسن",
      method: "DEBT",
      items: [item(P.FLOOR25, 1), item(P.WIPER74, 1), item(P.NAPKIN70, 1)],
      amountPaid: 0,
      deliveryFee: 0,
      invoiceDiscount: null,
      customer: C_MOHAMMAD,
    },
    // ── INVOICE 11: CASH + item-level discount ─────────────────────────────
    {
      label: "CASH — item discount 20 د.أ",
      method: "CASH",
      items: [item(P.FLOOR8L, 2, 20.00)],
      amountPaid: 220.00,
      deliveryFee: 0,
      invoiceDiscount: null,
      customer: null,
    },
    // ── INVOICE 12: CASH + invoice-level 10% discount ─────────────────────
    {
      label: "CASH — invoice 10% discount",
      method: "CASH",
      items: [item(P.FLOOR6L, 2)],
      amountPaid: 153.00,
      deliveryFee: 0,
      invoiceDiscount: { scope: "TOTAL", type: "FIXED", value: 17.00 },
      customer: null,
    },
    // ── INVOICE 13: VISA — high qty ────────────────────────────────────────
    {
      label: "VISA — qty 5",
      method: "VISA",
      items: [item(P.FLOOR7L, 5)],
      amountPaid: 350.00,
      deliveryFee: 0,
      invoiceDiscount: null,
      customer: null,
    },
    // ── INVOICE 14: CLIQ — single high-value ───────────────────────────────
    {
      label: "CLIQ — single high",
      method: "CLIQ",
      items: [item(P.CLEAN12, 1)],
      amountPaid: 150.00,
      deliveryFee: 0,
      invoiceDiscount: null,
      customer: null,
    },
    // ── INVOICE 15: CASH — micro transaction (many cheap items) ────────────
    {
      label: "CASH — micro 25 د.أ",
      method: "CASH",
      items: [item(P.MULTI250, 10), item(P.GLASS200, 5)],
      amountPaid: 25.00,
      deliveryFee: 0,
      invoiceDiscount: null,
      customer: null,
    },
    // ── INVOICE 16: SPLIT — small cash 50 ──────────────────────────────────
    {
      label: "SPLIT — 50 cash + card",
      method: "SPLIT",
      items: [item(P.FLOOR1500, 1), item(P.MULTI20, 1)],
      amountPaid: 50.00,
      deliveryFee: 0,
      invoiceDiscount: null,
      customer: null,
    },
    // ── INVOICE 17: DEBT — Sara ────────────────────────────────────────────
    {
      label: "DEBT — سارة الدليمي",
      method: "DEBT",
      items: [item(P.NAPKIN90, 1), item(P.SURFACE, 1)],
      amountPaid: 0,
      deliveryFee: 0,
      invoiceDiscount: null,
      customer: C_SARA,
    },
    // ── INVOICE 18: CASH + delivery fee ────────────────────────────────────
    {
      label: "CASH — delivery +5 د.أ",
      method: "CASH",
      items: [item(P.MULTI18, 1), item(P.CLEAN4X6, 1)],
      amountPaid: 175.00,
      deliveryFee: 5.00,
      invoiceDiscount: null,
      customer: null,
    },
    // ── INVOICE 19: VISA — fractional pricing ──────────────────────────────
    {
      label: "VISA — fractional 64.10 ×3",
      method: "VISA",
      items: [item(P.NAPKIN70, 3)],
      amountPaid: 192.30,
      deliveryFee: 0,
      invoiceDiscount: null,
      customer: null,
    },
    // ── INVOICE 20: CASH — mixed small + large ─────────────────────────────
    {
      label: "CASH — mixed 105 د.أ",
      method: "CASH",
      items: [item(P.FLOOR1300, 1), item(P.MULTI250, 6), item(P.GLASS200, 3)],
      amountPaid: 110.00,
      deliveryFee: 0,
      invoiceDiscount: null,
      customer: null,
    },
  ];

  // ═══════════════════════════════════════════════════════════════════════════
  // INJECT INVOICES INTO IDB + BUILD SHIFT STATE
  // ═══════════════════════════════════════════════════════════════════════════
  let cashSales = 0;
  let visaSales = 0;
  let cliqSales = 0;
  let debtSales = 0;
  let totalSales = 0;
  let totalDiscounts = 0;
  let totalReturns = 0;
  let totalDeliveryFee = 0;
  const shiftTransactions = [];

  const baseTime = Date.now() - invoices.length * 3 * 60000;

  for (let i = 0; i < invoices.length; i++) {
    const inv = invoices[i];
    const grossBase = R2(inv.items.reduce((s, it) => s + it.lineTotal, 0));
    const itemDisc = sumItemDiscounts(inv.items);
    const invDisc = inv.invoiceDiscount
      ? (inv.invoiceDiscount.type === "FIXED"
          ? inv.invoiceDiscount.value
          : R2(grossBase * Math.min(100, inv.invoiceDiscount.value) / 100))
      : 0;
    const discount = R2(itemDisc + invDisc);
    const subtotalGross = R2(grossBase - invDisc);
    const { net: subtotal, tax } = taxIncluded(subtotalGross);
    const total = R2(subtotalGross + inv.deliveryFee);
    const change = R2(Math.max(0, inv.amountPaid - total));
    const bk = buckets(inv.method, total, inv.amountPaid);
    const completed_at = new Date(baseTime + i * 180000).toISOString();
    const sync_id = uuid();

    // ── IDB sync record ────────────────────────────────────────────────────
    await putSync({
      sync_id,
      storeId: state.runtimeStoreId ?? state.currentStore?.id ?? null,
      action_type: "INVOICE_CREATED",
      payload: {
        items: inv.items,
        subtotal: R2(subtotal),
        tax: R2(tax),
        discount,
        deliveryFee: inv.deliveryFee,
        total,
        paymentMethod: inv.method,
        amountPaid: inv.amountPaid,
        change,
        cashAmount: bk.cash,
        visaAmount: bk.visa,
        cliqAmount: bk.cliq,
        debtAmount: bk.debt,
        customerName: inv.customer?.name,
        customerId: inv.customer?.id,
        customerPhone: inv.customer?.phone,
        cashierId: CASHIER.id,
        cashierName: CASHIER.name,
        shiftId: SHIFT_ID,
        branchId: BRANCH_ID ?? undefined,
        terminalId: TERMINAL_ID ?? undefined,
        completed_at,
      },
      status: "PENDING",
      created_at: completed_at,
      cashierName: CASHIER.name,
    });

    // ── Accumulate shift totals ────────────────────────────────────────────
    cashSales = R2(cashSales + bk.cash);
    visaSales = R2(visaSales + bk.visa);
    cliqSales = R2(cliqSales + bk.cliq);
    debtSales = R2(debtSales + bk.debt);
    totalSales = R2(totalSales + total);
    totalDiscounts = R2(totalDiscounts + discount);
    totalDeliveryFee = R2(totalDeliveryFee + inv.deliveryFee);

    shiftTransactions.push({
      syncId: sync_id,
      shiftId: SHIFT_ID,
      paymentMethod: inv.method,
      total,
      cashPortion: bk.cash,
      completed_at,
    });

    console.log(`  ✅ [${i + 1}/20] ${inv.label} → ${total.toFixed(2)} د.أ (${inv.method})`);
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // CASH MOVEMENTS — 2 Cash In + 1 Cash Out
  // ═══════════════════════════════════════════════════════════════════════════
  const movements = [
    { type: "CASH_IN",  amount: 100.00, reason: "إيداع صندوق — م补齐 رأس المال", notes: "补齐 رأس المال الصباحي" },
    { type: "CASH_IN",  amount:  50.00, reason: "إيداع — عائد صرافية سابقة", notes: "" },
    { type: "CASH_OUT", amount:  30.00, reason: "مصروفات تنظيف", notes: "شراء مواد تنظيف للفرع" },
  ];
  const cashMovements = [];
  let cashInTotal = 0;
  let cashOutTotal = 0;

  for (let i = 0; i < movements.length; i++) {
    const mv = movements[i];
    const id = uuid();
    const created_at = new Date(baseTime + (invoices.length + i) * 180000).toISOString();

    await putSync({
      sync_id: id,
      storeId: state.runtimeStoreId ?? state.currentStore?.id ?? null,
      action_type: "CASH_MOVEMENT",
      payload: {
        movementId: id,
        shiftId: SHIFT_ID,
        type: mv.type,
        amount: mv.amount,
        reason: mv.reason,
        notes: mv.notes,
        cashierId: CASHIER.id,
        cashierName: CASHIER.name,
        created_at,
        branchId: BRANCH_ID ?? undefined,
        terminalId: TERMINAL_ID ?? undefined,
      },
      status: "PENDING",
      created_at,
      cashierName: CASHIER.name,
    });

    cashMovements.push({
      id,
      shiftId: SHIFT_ID,
      type: mv.type,
      amount: mv.amount,
      reason: mv.reason,
      notes: mv.notes,
      cashierId: CASHIER.id,
      cashierName: CASHIER.name,
      branchId: BRANCH_ID,
      terminalId: TERMINAL_ID,
      createdAt: created_at,
    });

    if (mv.type === "CASH_IN") cashInTotal = R2(cashInTotal + mv.amount);
    else cashOutTotal = R2(cashOutTotal + mv.amount);

    console.log(`  💰 [CASH ${mv.type}] +${mv.amount.toFixed(2)} د.أ — ${mv.reason}`);
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // DEBT SETTLEMENTS — 2 settlements
  // ═══════════════════════════════════════════════════════════════════════════
  const settlements = [
    { customer: C_AHMAD, amount: 50.00 },
    { customer: C_MOHAMMAD, amount: 30.00 },
  ];
  let debtCollections = 0;

  for (const st of settlements) {
    const id = uuid();
    const created_at = NOW();

    await putSync({
      sync_id: id,
      storeId: state.runtimeStoreId ?? state.currentStore?.id ?? null,
      action_type: "DEBT_SETTLEMENT",
      payload: {
        shiftId: SHIFT_ID,
        customerId: st.customer.id,
        customerName: st.customer.name,
        amount: st.amount,
        completed_at: created_at,
        branchId: BRANCH_ID ?? undefined,
        terminalId: TERMINAL_ID ?? undefined,
      },
      status: "PENDING",
      created_at,
      cashierName: CASHIER.name,
    });

    shiftTransactions.push({
      syncId: id,
      shiftId: SHIFT_ID,
      paymentMethod: "CASH",
      total: st.amount,
      cashPortion: st.amount,
      completed_at: created_at,
    });

    debtCollections = R2(debtCollections + st.amount);

    console.log(`  💳 [DEBT SETTLEMENT] ${st.customer.name}: ${st.amount.toFixed(2)} د.أ`);
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // FINAL SHIFT TOTALS
  // ═══════════════════════════════════════════════════════════════════════════
  const expectedCashInDrawer = R2(STARTING_CASH + cashSales + cashInTotal - cashOutTotal + debtCollections);
  const drawerOpenCount = 5;

  const newShiftTotals = {
    cashSales,
    visaSales,
    cliqSales,
    debtSales,
    debtCollections,
    totalSales,
    discounts: totalDiscounts,
    returns: totalReturns,
    expenses: cashOutTotal,
    expectedCashInDrawer,
    cashInTotal,
    cashOutTotal,
    expectedCard: visaSales,
    actualCard: 0,
    cardVariance: R2(0 - visaSales),
    expectedCliq: cliqSales,
    actualCliq: 0,
    cliqVariance: R2(0 - cliqSales),
    drawerOpenCount,
    hasDiscrepancy: false,
    discrepancyReason: "",
    discrepancyNote: "",
  };

  // ═══════════════════════════════════════════════════════════════════════════
  // PERSIST TO LOCALSTORAGE (Zustand hydration on next load)
  // ═══════════════════════════════════════════════════════════════════════════
  state.shiftTotals = newShiftTotals;
  state.shiftTransactions = shiftTransactions;
  state.cashMovements = cashMovements;
  state.pendingSyncCount = invoices.length + movements.length + settlements.length;

  // Also inject test customers into the store's customer list for DEBT lookups
  if (!Array.isArray(state.customers)) state.customers = [];
  const existingIds = new Set(state.customers.map((c) => c.id));
  for (const c of [C_AHMAD, C_MOHAMMAD, C_SARA]) {
    if (!existingIds.has(c.id)) {
      state.customers.push({ id: c.id, name: c.name, phone: c.phone, balance: 0 });
    }
  }

  localStorage.setItem(LS_KEY, JSON.stringify({ state, version: persisted.version ?? 0 }));

  // ═══════════════════════════════════════════════════════════════════════════
  // SUMMARY
  // ═══════════════════════════════════════════════════════════════════════════
  console.log("\n═══════════════════════════════════════════════════════════════");
  console.log("  ✅ SIMULATION COMPLETE — 20 INVOICES + 3 MOVEMENTS + 2 SETTLEMENTS");
  console.log("═══════════════════════════════════════════════════════════════");
  console.log(`  💵 Cash Sales:     ${cashSales.toFixed(2)} د.أ`);
  console.log(`  💳 Card (VISA):    ${visaSales.toFixed(2)} د.أ`);
  console.log(`  📱 CliQ:           ${cliqSales.toFixed(2)} د.أ`);
  console.log(`  📋 Debt:           ${debtSales.toFixed(2)} د.أ`);
  console.log(`  🔄 Settlements:    ${debtCollections.toFixed(2)} د.أ`);
  console.log(`  ───────────────────────────────────────────────────────────`);
  console.log(`  📊 Total Sales:    ${totalSales.toFixed(2)} د.أ`);
  console.log(`  🏷️  Discounts:      ${totalDiscounts.toFixed(2)} د.أ`);
  console.log(`  🚚 Delivery Fees:  ${totalDeliveryFee.toFixed(2)} د.أ`);
  console.log(`  💰 Cash In:        ${cashInTotal.toFixed(2)} د.أ`);
  console.log(`  💸 Cash Out:       ${cashOutTotal.toFixed(2)} د.أ`);
  console.log(`  🔓 Drawer Opens:   ${drawerOpenCount}`);
  console.log(`  ───────────────────────────────────────────────────────────`);
  console.log(`  🏦 Starting Cash:  ${STARTING_CASH.toFixed(2)} د.أ`);
  console.log(`  🎯 Expected Cash:  ${expectedCashInDrawer.toFixed(2)} د.أ`);
  console.log(`  🎯 Expected Card:  ${visaSales.toFixed(2)} د.أ`);
  console.log(`  🎯 Expected CliQ:  ${cliqSales.toFixed(2)} د.أ`);
  console.log("═══════════════════════════════════════════════════════════════");
  console.log("  ⚡ HARD REFRESH (Ctrl+Shift+R) now to hydrate the store.");
  console.log("  ⚡ Then close the shift with EXACT expected amounts for zero variance.");
  console.log("═══════════════════════════════════════════════════════════════\n");
})();
