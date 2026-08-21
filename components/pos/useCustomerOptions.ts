"use client";

import { useCallback, useEffect, useMemo } from "react";
import { posFetch } from "@/lib/tenantClient";
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
  const currentStoreId = usePosStore((s) => s.currentStore?.id ?? null);
  const hydrateCatalog = usePosStore((s) => s.hydrateCatalog);
  const upsertCustomer = usePosStore((s) => s.upsertCustomer);

  useEffect(() => {
    if (!active || !currentStoreId) return;
    void hydrateCatalog();
  }, [active, currentStoreId, hydrateCatalog]);

  const customers = useMemo(
    () => rawCustomers.map(toOption),
    [rawCustomers],
  );

  const createCustomer = useCallback(async (data: { name: string; phone: string }): Promise<CustomerOption> => {
    try {
      const response = await posFetch("/api/customers", {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-pos-role": "cashier" },
        body: JSON.stringify(data),
      });
      const body = (await response.json().catch(() => null)) as {
        customer?: PosCustomer;
        error?: string;
      } | null;
      if (!response.ok || !body?.customer) {
        throw new CustomerCreateRejected(body?.error ?? "تعذر إضافة الزبون");
      }
      upsertCustomer({
        id: body.customer.id,
        name: body.customer.name,
        phone: body.customer.phone ?? "",
        balance: Number(body.customer.balance) || 0,
      });
      return toOption(body.customer);
    } catch (reason) {
      if (reason instanceof CustomerCreateRejected) throw reason;
      const local: PosCustomer = {
        id: `local-${crypto.randomUUID()}`,
        name: data.name,
        phone: data.phone,
        balance: 0,
      };
      upsertCustomer(local);
      return toOption(local);
    }
  }, [upsertCustomer]);

  return { customers, loading, createCustomer };
}
