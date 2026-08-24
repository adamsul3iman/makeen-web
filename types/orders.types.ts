/**
 * Parked-order domain (Phase 2).
 *
 * A LocalOrder is a cart parked mid-sale, persisted offline-first and
 * mirrored to `pos_orders` (migration 082) so it shows on every device of
 * the store. Closing an order converts it into a normal invoice via the
 * existing checkout path — orders never touch stock or ledgers themselves.
 */
import type { DiscountInput, Money, SaleItem } from "./pos.types";

export type OrderStatus = "OPEN" | "CLOSED" | "CANCELLED";

/**
 * A parked cart. Mirrors the `pos_orders` row shape with camelCase fields;
 * `items` is stored verbatim (JSONB server-side) so restore is lossless.
 */
export interface LocalOrder {
  id: string;
  storeId: string;
  branchId?: string | null;
  terminalId?: string | null;
  /** Human-readable reference minted locally (e.g. O-LZ4K2A-1). */
  orderNumber: string;
  status: OrderStatus;
  items: SaleItem[];
  /** Invoice-level discount active when the order was parked. */
  invoiceDiscount: DiscountInput | null;
  deliveryFee: Money;
  customerId?: string;
  customerName?: string;
  customerPhone?: string;
  cashierId?: string;
  cashierName?: string;
  deviceName?: string;
  /** Server sync id of the invoice that closed this order. */
  invoiceSyncId?: string;
  createdAt: string;
  updatedAt: string;
  closedAt?: string;
  cancelReason?: string;
  /**
   * True when the latest local mutation has not been acknowledged by the
   * server yet (offline create/update). The boot sweep retries these.
   */
  pendingSync: boolean;
}

/** Build an order number that is unique per device without network access. */
export function mintOrderNumber(deviceName?: string): string {
  const stamp = Date.now().toString(36).toUpperCase();
  const device = (deviceName ?? "").trim().replace(/\s+/g, "").slice(0, 8);
  return `O-${stamp}${device ? `-${device}` : ""}`;
}

/** Convert a legacy HeldInvoice-shaped record into a LocalOrder. */
export function heldInvoiceToOrder(
  held: {
    id: string;
    created_at: string;
    items: SaleItem[];
    total: Money;
    invoiceDiscount?: DiscountInput | null;
    deliveryFee?: Money;
  },
  storeId: string,
): LocalOrder {
  return {
    id: held.id,
    storeId,
    orderNumber: mintOrderNumber(),
    status: "OPEN",
    items: held.items ?? [],
    invoiceDiscount: held.invoiceDiscount ?? null,
    deliveryFee: held.deliveryFee ?? 0,
    createdAt: held.created_at,
    updatedAt: new Date().toISOString(),
    // Legacy held carts were device-local by construction.
    pendingSync: true,
  };
}
