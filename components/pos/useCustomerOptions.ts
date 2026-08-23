"use client";

import { useCallback, useMemo } from "react";
import { createCustomer as createCustomerRecord } from "@/lib/customersClient";
import { usePosStore } from "@/store/usePosStore";
import type { PosCustomer } from "@/types/pos.types";
import type { EntityOption } from "@/components/shared/EntityCombobox";

interface CustomerOption extends EntityOption {
  phone: string;
  balance: number;
}

class CustomerCreateRejected extends Error {}

function toOption(customer: PosCustomer): CustomerOption {
  const phone = customer.phone ?? "";
  const balance = Number(customer.balance) || 0;
  const details = [phone, balance > 0 ? `الرصيد: ${balance.toFixed(2)} د.أ` : ""].filter(Boolean);
  return {
    id: customer.id,
    name: customer.name,
    phone,
    balance,
    description: details.join(" • "),
  };
}

export function useCustomerOptions(active: boolean) {
  const rawCustomers = usePosStore((s) => s.customers);
  const loading = usePosStore((s) => s.customersLoading);
  const upsertCustomer = usePosStore((s) => s.upsertCustomer);

  // Customers are loaded at login via applyLoginPayloadToStore → hydrateCatalog.
  // No need to re-hydrate on every checkout open — that causes full catalog
  // identity swaps and visible flickering.

  const customers = useMemo(
    () => rawCustomers.map(toOption),
    [rawCustomers],
  );

  const createCustomer = useCallback(async (data: { name: string; phone: string }): Promise<CustomerOption> => {
    try {
      const row = await createCustomerRecord({ name: data.name, phone: data.phone });
      const saved: PosCustomer = {
        id: row.id,
        name: row.name,
        phone: row.phone ?? "",
        balance: Number(row.balance) || 0,
      };
      upsertCustomer(saved);
      return toOption(saved);
    } catch (reason) {
      if (reason instanceof CustomerCreateRejected) throw reason;
      // Same offline posture as before the direct-Supabase migration: with no
      // connectivity the register keeps working on a device-local placeholder.
      if (typeof navigator !== "undefined" && !navigator.onLine) {
        const local: PosCustomer = {
          id: `local-${crypto.randomUUID()}`,
          name: data.name,
          phone: data.phone,
          balance: 0,
        };
        upsertCustomer(local);
        return toOption(local);
      }
      throw new CustomerCreateRejected(
        reason instanceof Error && reason.message ? reason.message : "تعذر إضافة الزبون",
      );
    }
  }, [upsertCustomer]);

  return { customers, loading, createCustomer };
}
