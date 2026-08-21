/**
 * Supabase PostgreSQL schema types.
 * These mirror the production DDL in /db/migrations (003_production_schema_sync.sql)
 * and are shaped like generated output from `supabase gen types typescript`.
 *
 * Column names are snake_case (matching the DB). Decimal/Integer numeric
 * columns are represented as `number`.
 */

export type Json =
  | string
  | number
  | boolean
  | null
  | { [key: string]: Json | undefined }
  | Json[];

export type Barcode = string;
export type Uuid = string;
export type Timestamp = string;

export interface CashierRow {
  id: Uuid;
  name: string;
  pin: string;
  role: string;
  role_id: Uuid | null;
}

export interface CashierInsert {
  id?: Uuid;
  name: string;
  pin: string;
  role?: string;
  role_id?: Uuid | null;
}

export interface CashierUpdate {
  id?: Uuid;
  name?: string;
  pin?: string;
  role?: string;
  role_id?: Uuid | null;
}

export interface StaffRoleRow {
  id: Uuid;
  store_id: Uuid;
  code: string;
  name: string;
  description: string;
  capabilities: string[];
  limits: Json;
  is_system: boolean;
  sort_order: number;
  created_at: Timestamp;
  updated_at: Timestamp;
}

export type StaffRoleInsert = Omit<StaffRoleRow, "id" | "created_at" | "updated_at"> & {
  id?: Uuid;
  created_at?: Timestamp;
  updated_at?: Timestamp;
};

export type StaffRoleUpdate = Partial<StaffRoleInsert>;

export interface CategoryRow {
  id: Uuid;
  name: string;
  store_id: Uuid;
  parent_id: Uuid | null;
  bg_color: string | null;
  is_quick_key: boolean;
  sort_order: number;
  show_in_pos: boolean;
}

export interface CategoryInsert {
  id?: Uuid;
  name: string;
  store_id: Uuid;
  parent_id?: Uuid | null;
  bg_color?: string | null;
  is_quick_key?: boolean;
  sort_order?: number;
  show_in_pos?: boolean;
}

export interface CategoryUpdate {
  id?: Uuid;
  name?: string;
  parent_id?: Uuid | null;
  bg_color?: string | null;
  is_quick_key?: boolean;
  sort_order?: number;
  show_in_pos?: boolean;
}

export interface ProductRow {
  id: Uuid;
  category_id: Uuid | null;
  name: string;
  base_unit: string;
  cost_price: number;
  selling_price: number;
  wholesale_price: number;
  total_stock: number;
  is_quick_key: boolean;
  brand_id: Uuid | null;
  default_supplier_id: Uuid | null;
  tax_percent: number;
  tax_included: boolean;
  is_active: boolean;
  show_in_pos: boolean;
  is_sellable: boolean;
  is_purchasable: boolean;
  allow_price_change: boolean;
  reorder_level: number;
}

export interface ProductInsert {
  id?: Uuid;
  category_id?: Uuid | null;
  name: string;
  base_unit: string;
  cost_price?: number;
  selling_price?: number;
  wholesale_price?: number;
  total_stock?: number;
  is_quick_key?: boolean;
  brand_id?: Uuid | null;
  default_supplier_id?: Uuid | null;
  tax_percent?: number;
  tax_included?: boolean;
  is_active?: boolean;
  show_in_pos?: boolean;
  is_sellable?: boolean;
  is_purchasable?: boolean;
  allow_price_change?: boolean;
  reorder_level?: number;
}

export interface ProductUpdate {
  id?: Uuid;
  category_id?: Uuid | null;
  name?: string;
  base_unit?: string;
  cost_price?: number;
  selling_price?: number;
  wholesale_price?: number;
  total_stock?: number;
  is_quick_key?: boolean;
  brand_id?: Uuid | null;
  default_supplier_id?: Uuid | null;
  tax_percent?: number;
  tax_included?: boolean;
  is_active?: boolean;
  show_in_pos?: boolean;
  is_sellable?: boolean;
  is_purchasable?: boolean;
  allow_price_change?: boolean;
  reorder_level?: number;
}

export interface ProductVariantRow {
  id: Uuid;
  product_id: Uuid;
  store_id: Uuid;
  barcode: string;
  variant_label: string;
  total_stock: number;
  is_active: boolean;
  created_at: Timestamp;
  updated_at: Timestamp;
}

export interface ProductVariantInsert {
  id?: Uuid;
  product_id: Uuid;
  store_id: Uuid;
  barcode: string;
  variant_label?: string;
  total_stock?: number;
  is_active?: boolean;
}

export interface ProductVariantUpdate {
  id?: Uuid;
  product_id?: Uuid;
  store_id?: Uuid;
  barcode?: string;
  variant_label?: string;
  total_stock?: number;
  is_active?: boolean;
}

export interface ProductBrandRow {
  id: Uuid;
  name: string;
  created_at: Timestamp;
}

export interface ProductBrandInsert {
  id?: Uuid;
  name: string;
}

export interface ProductBrandUpdate {
  name?: string;
}

/** One queued offline transaction, stored verbatim (event sourcing). */
export interface SyncEventRow {
  sync_id: Uuid;
  action_type: string;
  payload: Json;
  created_at: Timestamp;
  client_created_at: Timestamp | null;
  branch_id: Uuid | null;
  terminal_id: Uuid | null;
  cashier_name: string;
}

export interface SyncEventInsert {
  sync_id: Uuid;
  action_type: string;
  payload: Json;
  created_at?: Timestamp;
  client_created_at?: Timestamp | null;
  branch_id?: Uuid | null;
  terminal_id?: Uuid | null;
  cashier_name?: string;
}

/** A customer holding an outstanding ledger balance (ذمم). */
export interface CustomerRow {
  id: Uuid;
  name: string;
  phone: string;
  /** Outstanding debt; positive means the customer owes the store. */
  balance: number;
  created_at: Timestamp;
}

export interface CustomerInsert {
  id?: Uuid;
  name: string;
  phone?: string;
  balance?: number;
  created_at?: Timestamp;
}

export interface CustomerUpdate {
  id?: Uuid;
  name?: string;
  phone?: string;
  balance?: number;
  created_at?: Timestamp;
}

/** One debit/credit entry on a customer's ledger. */
export interface CustomerTransactionRow {
  id: Uuid;
  customer_id: Uuid;
  /** SALE_DEBT adds to balance; SETTLEMENT reduces it. */
  type: string;
  amount: number;
  balance_after: number;
  description: string | null;
  shift_id: Uuid | null;
  created_at: Timestamp;
}

export interface CustomerTransactionInsert {
  id?: Uuid;
  customer_id: Uuid;
  type: string;
  amount: number;
  balance_after: number;
  description?: string | null;
  shift_id?: Uuid | null;
  created_at?: Timestamp;
}

export interface CustomerTransactionUpdate {
  id?: Uuid;
  customer_id?: Uuid;
  type?: string;
  amount?: number;
  balance_after?: number;
  description?: string | null;
  shift_id?: Uuid | null;
  created_at?: Timestamp;
}

/** Petty-cash expense taken out of the drawer (مصروف). */
export interface ExpenseRow {
  id: Uuid;
  cashier_id: Uuid | null;
  category: string;
  amount: number;
  notes: string | null;
  shift_id: Uuid | null;
  created_at: Timestamp;
}

export interface ExpenseInsert {
  id?: Uuid;
  cashier_id?: Uuid | null;
  category: string;
  amount: number;
  notes?: string | null;
  shift_id?: Uuid | null;
  created_at?: Timestamp;
}

export interface ExpenseUpdate {
  id?: Uuid;
  cashier_id?: Uuid | null;
  category?: string;
  amount?: number;
  notes?: string | null;
  shift_id?: Uuid | null;
  created_at?: Timestamp;
}

/** A goods supplier carrying an optional account balance. */
export interface SupplierRow {
  id: Uuid;
  name: string;
  phone: string;
  email: string;
  address: string | null;
  balance: number;
  created_at: Timestamp;
}

export interface SupplierInsert {
  id?: Uuid;
  name: string;
  phone?: string;
  email?: string;
  address?: string | null;
  balance?: number;
  created_at?: Timestamp;
}

export interface SupplierUpdate {
  id?: Uuid;
  name?: string;
  phone?: string;
  email?: string;
  address?: string | null;
  balance?: number;
  created_at?: Timestamp;
}

export interface SupplierInvoiceRow {
  id: Uuid;
  store_id: Uuid;
  supplier_id: Uuid;
  purchase_order_id: Uuid | null;
  invoice_number: string;
  invoice_date: string;
  due_date: string;
  subtotal: number;
  tax_amount: number;
  total_amount: number;
  paid_amount: number;
  balance_due: number;
  status: "OPEN" | "PARTIAL" | "PAID" | "VOID";
  notes: string | null;
  created_at: Timestamp;
  updated_at: Timestamp;
}

export type SupplierInvoiceInsert = Omit<SupplierInvoiceRow, "id" | "created_at" | "updated_at"> & {
  id?: Uuid;
  created_at?: Timestamp;
  updated_at?: Timestamp;
};

export type SupplierInvoiceUpdate = Partial<Omit<SupplierInvoiceRow, "id" | "store_id">>;

export interface SupplierInvoiceItemRow {
  id: Uuid;
  invoice_id: Uuid;
  store_id: Uuid;
  line_no: number;
  product_id: Uuid | null;
  description: string;
  quantity: number;
  unit_cost: number;
  tax_percent: number;
  net_amount: number;
  tax_amount: number;
  total_amount: number;
}

export type SupplierInvoiceItemInsert = Omit<SupplierInvoiceItemRow, "id"> & { id?: Uuid };
export type SupplierInvoiceItemUpdate = Partial<Omit<SupplierInvoiceItemRow, "id" | "store_id">>;

export interface SupplierPaymentRow {
  id: Uuid;
  store_id: Uuid;
  supplier_id: Uuid;
  invoice_id: Uuid;
  amount: number;
  method: "CASH" | "BANK" | "CARD";
  reference: string | null;
  notes: string | null;
  paid_at: Timestamp;
  created_at: Timestamp;
}

export type SupplierPaymentInsert = Omit<SupplierPaymentRow, "id" | "created_at"> & {
  id?: Uuid;
  created_at?: Timestamp;
};
export type SupplierPaymentUpdate = Partial<Omit<SupplierPaymentRow, "id" | "store_id">>;

/** A purchase order header; status flips pending -> received. */
export interface PurchaseOrderRow {
  id: Uuid;
  supplier_id: Uuid;
  total_amount: number;
  status: string;
  received_at: Timestamp | null;
  created_at: Timestamp;
}

export interface PurchaseOrderInsert {
  id?: Uuid;
  supplier_id: Uuid;
  total_amount?: number;
  status?: string;
  received_at?: Timestamp | null;
  created_at?: Timestamp;
}

export interface PurchaseOrderUpdate {
  id?: Uuid;
  supplier_id?: Uuid;
  total_amount?: number;
  status?: string;
  received_at?: Timestamp | null;
  created_at?: Timestamp;
}

/** One line of a purchase order. */
export interface PurchaseOrderItemRow {
  id: Uuid;
  purchase_order_id: Uuid;
  product_id: Uuid | null;
  quantity: number;
  unit_cost: number;
  total_price: number;
}

export interface PurchaseOrderItemInsert {
  id?: Uuid;
  purchase_order_id: Uuid;
  product_id?: Uuid | null;
  quantity: number;
  unit_cost: number;
  total_price: number;
}

export interface PurchaseOrderItemUpdate {
  id?: Uuid;
  purchase_order_id?: Uuid;
  product_id?: Uuid | null;
  quantity?: number;
  unit_cost?: number;
  total_price?: number;
}

export interface ShiftReportRow {
  id: Uuid;
  store_id: Uuid;
  shift_id: Uuid;
  close_event_id: Uuid;
  branch_id: Uuid | null;
  terminal_id: Uuid | null;
  cashier_id: Uuid | null;
  cashier_name: string;
  opened_at: Timestamp;
  closed_at: Timestamp;
  starting_cash: number;
  cash_sales: number;
  visa_sales: number;
  cliq_sales: number;
  debt_sales: number;
  debt_collections: number;
  discounts: number;
  returns: number;
  expenses: number;
  total_sales: number;
  expected_cash: number;
  actual_cash: number;
  variance: number;
  approval_status: "NOT_REQUIRED" | "PENDING" | "APPROVED";
  approved_by: Uuid | null;
  approved_by_name: string | null;
  approved_at: Timestamp | null;
  approval_note: string;
  close_source: "DEVICE" | "ADMIN_RECOVERY";
  resolved_by: Uuid | null;
  resolved_by_name: string | null;
  resolution_note: string;
  created_at: Timestamp;
  updated_at: Timestamp;
}

export type ShiftReportInsert = Omit<
  ShiftReportRow,
  "id" | "created_at" | "updated_at" | "close_source" | "resolved_by" | "resolved_by_name" | "resolution_note"
> & {
  id?: Uuid;
  close_source?: "DEVICE" | "ADMIN_RECOVERY";
  resolved_by?: Uuid | null;
  resolved_by_name?: string | null;
  resolution_note?: string;
  created_at?: Timestamp;
  updated_at?: Timestamp;
};
export type ShiftReportUpdate = Pick<ShiftReportRow, "approval_status" | "approved_by" | "approved_by_name" | "approved_at" | "approval_note">;

export interface RiskEventRow {
  id: Uuid;
  store_id: Uuid;
  event_key: string;
  actor_id: Uuid | null;
  actor_name: string;
  branch_id: Uuid | null;
  terminal_id: Uuid | null;
  shift_id: Uuid | null;
  event_type: string;
  severity: "LOW" | "MEDIUM" | "HIGH" | "CRITICAL";
  score: number;
  amount: number;
  target_id: string | null;
  details: Json;
  status: "OPEN" | "REVIEWED" | "DISMISSED" | "ESCALATED";
  reviewed_by: Uuid | null;
  reviewed_by_name: string | null;
  reviewed_at: Timestamp | null;
  review_note: string;
  occurred_at: Timestamp;
  created_at: Timestamp;
}

export type RiskEventInsert = Omit<RiskEventRow, "id" | "created_at"> & {
  id?: Uuid;
  created_at?: Timestamp;
};
export type RiskEventUpdate = Pick<RiskEventRow, "status" | "reviewed_by" | "reviewed_by_name" | "reviewed_at" | "review_note">;

export interface Database {
  public: {
    Tables: {
      cashiers: {
        Row: CashierRow;
        Insert: CashierInsert;
        Update: CashierUpdate;
      };
      staff_roles: {
        Row: StaffRoleRow;
        Insert: StaffRoleInsert;
        Update: StaffRoleUpdate;
      };
      categories: {
        Row: CategoryRow;
        Insert: CategoryInsert;
        Update: CategoryUpdate;
      };
      product_brands: {
        Row: ProductBrandRow;
        Insert: ProductBrandInsert;
        Update: ProductBrandUpdate;
      };
      products: {
        Row: ProductRow;
        Insert: ProductInsert;
        Update: ProductUpdate;
      };
      product_variants: {
        Row: ProductVariantRow;
        Insert: ProductVariantInsert;
        Update: ProductVariantUpdate;
      };
      sync_events: {
        Row: SyncEventRow;
        Insert: SyncEventInsert;
        Update: Pick<SyncEventRow, "sync_id"> & Partial<Omit<SyncEventRow, "sync_id">>;
      };
      customers: {
        Row: CustomerRow;
        Insert: CustomerInsert;
        Update: CustomerUpdate;
      };
      customer_transactions: {
        Row: CustomerTransactionRow;
        Insert: CustomerTransactionInsert;
        Update: CustomerTransactionUpdate;
      };
      expenses: {
        Row: ExpenseRow;
        Insert: ExpenseInsert;
        Update: ExpenseUpdate;
      };
      suppliers: {
        Row: SupplierRow;
        Insert: SupplierInsert;
        Update: SupplierUpdate;
      };
      supplier_invoices: {
        Row: SupplierInvoiceRow;
        Insert: SupplierInvoiceInsert;
        Update: SupplierInvoiceUpdate;
      };
      supplier_invoice_items: {
        Row: SupplierInvoiceItemRow;
        Insert: SupplierInvoiceItemInsert;
        Update: SupplierInvoiceItemUpdate;
      };
      supplier_payments: {
        Row: SupplierPaymentRow;
        Insert: SupplierPaymentInsert;
        Update: SupplierPaymentUpdate;
      };
      purchase_orders: {
        Row: PurchaseOrderRow;
        Insert: PurchaseOrderInsert;
        Update: PurchaseOrderUpdate;
      };
      purchase_order_items: {
        Row: PurchaseOrderItemRow;
        Insert: PurchaseOrderItemInsert;
        Update: PurchaseOrderItemUpdate;
      };
      shift_reports: {
        Row: ShiftReportRow;
        Insert: ShiftReportInsert;
        Update: ShiftReportUpdate;
      };
      risk_events: {
        Row: RiskEventRow;
        Insert: RiskEventInsert;
        Update: RiskEventUpdate;
      };
    };
    Views: Record<string, never>;
    Functions: Record<string, never>;
  };
}
