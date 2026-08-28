"use client";

import { useEffect, useState } from "react";
import PosLayout from "@/components/pos/PosLayout";
import { clearSyncQueue } from "@/lib/idb";
import { setTenantStoreId } from "@/lib/tenantClient";
import { usePosStore } from "@/store/usePosStore";
import type { SaleItem } from "@/types/pos.types";

const STORE_ID = "10000000-0000-4000-8000-000000000001";
const BRANCH_ID = "10000000-0000-4000-8000-000000000002";
const TERMINAL_ID = "10000000-0000-4000-8000-000000000003";
const SHIFT_ID = "10000000-0000-4000-8000-000000000004";

const item: SaleItem = {
  productId: "10000000-0000-4000-8000-000000000005",
  name: "E2E Print Item",
  barcode: "E2E-PRINT-001",
  qty: 1,
  unitName: "حبة",
  unitMultiplier: 1,
  unitPrice: 1.5,
  lineTotal: 1.5,
  discount: 0,
  taxPercent: 0,
  taxIncluded: true,
};

export default function PrintFallbackHarness() {
  const [ready, setReady] = useState(false);

  useEffect(() => {
    let cancelled = false;
    const seed = async () => {
      await clearSyncQueue();
      if (cancelled) return;
      setTenantStoreId(STORE_ID);
      const current = usePosStore.getState();
      usePosStore.setState({
        ready: true,
        runtimeStoreId: STORE_ID,
        currentStore: {
          id: STORE_ID,
          code: "E2E",
          name: "E2E Store",
          ownerName: "E2E Owner",
          email: "e2e@example.test",
          phone: "",
          subscriptionStatus: "active",
          taxPercent: 0,
        },
        currentCashier: {
          id: "10000000-0000-4000-8000-000000000006",
          name: "E2E Cashier",
          role: "cashier",
          roleCode: "cashier",
          roleName: "كاشير",
          sessionReady: true,
        },
        branches: [{ id: BRANCH_ID, storeId: STORE_ID, name: "E2E Branch", createdAt: "2026-01-01T00:00:00.000Z" }],
        terminals: [{ id: TERMINAL_ID, branchId: BRANCH_ID, name: "T1", createdAt: "2026-01-01T00:00:00.000Z" }],
        activeBranchId: BRANCH_ID,
        activeTerminalId: TERMINAL_ID,
        shiftState: {
          status: "OPEN",
          shiftId: SHIFT_ID,
          startTime: "2026-01-01T00:00:00.000Z",
          startingCash: 0,
          branchId: BRANCH_ID,
          terminalId: TERMINAL_ID,
        },
        shiftTotals: {
          ...current.shiftTotals,
          cashSales: 0,
          visaSales: 0,
          cliqSales: 0,
          debtSales: 0,
          totalSales: 0,
          expectedCashInDrawer: 0,
        },
        shiftTransactions: [],
        items: [item],
        totals: { subtotal: 1.5, tax: 0, discount: 0, deliveryFee: 0, total: 1.5, itemCount: 1 },
        cartSlots: [{ id: "1", items: [item], invoiceDiscount: null, deliveryFee: 0 }],
        activeCartIndex: 0,
        invoiceDiscount: null,
        deliveryFee: 0,
        lastCompletedInvoice: null,
        isCheckoutModalOpen: false,
        isCompleting: false,
        isOnline: false,
        registerLeaseHeld: false,
        notice: null,
      });
      setReady(true);
    };
    void seed();
    return () => {
      cancelled = true;
    };
  }, []);

  if (!ready) return <p>Preparing print fallback fixture...</p>;
  return (
    <>
      <span data-testid="print-fallback-ready" className="sr-only">ready</span>
      <PosLayout />
    </>
  );
}
