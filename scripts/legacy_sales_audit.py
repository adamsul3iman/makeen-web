#!/usr/bin/env python3
"""Audit legacy POS Excel exports before importing them into Alburj POS.

This is intentionally read-only: it does not write to the production database.
It normalizes the two legacy exports enough to reconcile closed invoices vs.
product sales, spot inventory-quality risks, and produce a JSON artifact that
can drive the next staging/import migration.
"""

from __future__ import annotations

import argparse
import json
import math
from pathlib import Path
from typing import Any

import pandas as pd


DEFAULT_SALES = "مبيعات 8 اشهر.xlsx"
DEFAULT_PRODUCTS = "مبيعات المنتجات 8 اشهر.xlsx"


def money(value: Any) -> float:
    if value is None:
        return 0.0
    try:
        n = float(value)
    except (TypeError, ValueError):
        return 0.0
    if math.isnan(n) or math.isinf(n):
        return 0.0
    return round(n, 3)


def find_default_file(name: str) -> Path:
    path = Path.home() / "Downloads" / name
    if not path.exists():
        raise FileNotFoundError(f"Missing {path}")
    return path


def top_records(df: pd.DataFrame, sort_by: str, columns: list[str], limit: int = 15) -> list[dict[str, Any]]:
    existing = [c for c in columns if c in df.columns]
    out = df.sort_values(sort_by, ascending=False)[existing].head(limit).copy()
    return json.loads(out.fillna("").to_json(orient="records", force_ascii=False))


def main() -> None:
    parser = argparse.ArgumentParser(description="Audit legacy Nard POS Excel exports.")
    parser.add_argument("--sales", type=Path, default=find_default_file(DEFAULT_SALES))
    parser.add_argument("--products", type=Path, default=find_default_file(DEFAULT_PRODUCTS))
    parser.add_argument("--output", type=Path, default=Path(".artifacts/legacy-sales-audit.json"))
    args = parser.parse_args()

    sales = pd.read_excel(args.sales)
    products = pd.read_excel(args.products)

    sales["sale_dt"] = pd.to_datetime(
        sales["sale_date"].astype(str).str.replace(r"\s+(AM|PM)$", "", regex=True),
        errors="coerce",
    )
    sales["month"] = sales["sale_dt"].dt.to_period("M").astype(str)
    closed = sales[sales["sale_status"].astype(str).str.lower().eq("closed")].copy()
    opened = sales[sales["sale_status"].astype(str).str.lower().eq("opened")].copy()

    monthly = (
        closed.groupby("month")
        .agg(
            invoices=("invoice_number", "count"),
            sales=("total_sales", "sum"),
            tax=("total_tax", "sum"),
            discount=("total_discount", "sum"),
            profit=("profit", "sum"),
            cash=("cash_amount", "sum"),
            card=("card_amount", "sum"),
        )
        .round(3)
        .reset_index()
    )

    by_user = (
        closed.groupby("username", dropna=False)
        .agg(invoices=("invoice_number", "count"), sales=("total_sales", "sum"), profit=("profit", "sum"))
        .sort_values("sales", ascending=False)
        .round(3)
        .reset_index()
    )

    product_total = money(products["total"].fillna(0).sum())
    closed_total = money(closed["total_sales"].fillna(0).sum())
    product_profit = money(products["profit"].fillna(0).sum())
    closed_profit = money(closed["profit"].fillna(0).sum())
    negative_stock = products[products["available_quantity"].fillna(0) < 0].copy()
    missing_barcode = products[products["barcode"].isna()].copy()

    result = {
        "sourceFiles": {
            "sales": str(args.sales),
            "products": str(args.products),
        },
        "sales": {
            "rows": int(len(sales)),
            "closedRows": int(len(closed)),
            "openedRows": int(len(opened)),
            "dateMin": None if pd.isna(sales["sale_dt"].min()) else sales["sale_dt"].min().isoformat(),
            "dateMax": None if pd.isna(sales["sale_dt"].max()) else sales["sale_dt"].max().isoformat(),
            "closedTotals": {
                "subtotal": money(closed["sub_total"].fillna(0).sum()),
                "discount": money(closed["total_discount"].fillna(0).sum()),
                "sales": closed_total,
                "tax": money(closed["total_tax"].fillna(0).sum()),
                "profit": closed_profit,
                "cash": money(closed["cash_amount"].fillna(0).sum()),
                "card": money(closed["card_amount"].fillna(0).sum()),
            },
            "paymentMethods": sales["payment_method"].fillna("(blank)").value_counts().to_dict(),
            "saleTypes": sales["sale_type"].fillna("(blank)").value_counts().to_dict(),
            "saleStatuses": sales["sale_status"].fillna("(blank)").value_counts().to_dict(),
            "monthlyClosed": json.loads(monthly.to_json(orient="records", force_ascii=False)),
            "byUser": json.loads(by_user.head(20).to_json(orient="records", force_ascii=False)),
        },
        "products": {
            "rows": int(len(products)),
            "totals": {
                "quantity": money(products["item_quantity"].fillna(0).sum()),
                "sales": product_total,
                "tax": money(products["total_tax"].fillna(0).sum()),
                "cost": money(products["total_cost"].fillna(0).sum()),
                "profit": product_profit,
                "availableQuantity": money(products["available_quantity"].fillna(0).sum()),
            },
            "negativeStockCount": int(len(negative_stock)),
            "negativeStockQuantity": money(negative_stock["available_quantity"].fillna(0).sum()),
            "missingBarcodeCount": int(len(missing_barcode)),
            "topBySales": top_records(
                products,
                "total",
                ["name_ar", "barcode", "item_quantity", "total", "total_cost", "profit", "available_quantity"],
            ),
            "topNegativeStock": top_records(
                negative_stock.assign(abs_stock=negative_stock["available_quantity"].abs()),
                "abs_stock",
                ["name_ar", "barcode", "item_quantity", "available_quantity", "total", "profit"],
            ),
        },
        "reconciliation": {
            "closedInvoiceSalesMinusProductSales": money(closed_total - product_total),
            "closedInvoiceProfitMinusProductProfit": money(closed_profit - product_profit),
            "closedCashPlusCardMinusClosedSales": money(
                closed["cash_amount"].fillna(0).sum() + closed["card_amount"].fillna(0).sum() - closed["total_sales"].fillna(0).sum()
            ),
            "impliedTaxRateOnClosedSubtotal": money(
                closed["total_tax"].fillna(0).sum() / closed["sub_total"].replace(0, pd.NA).dropna().sum()
            ),
        },
        "recommendations": [
            "Import legacy data into separate staging tables first; do not mix it with live sales until reconciliation is accepted.",
            "Treat opened rows as orders, not closed sales.",
            "Resolve negative stock and zero-cost products before trusting historical gross profit.",
            "Use closed invoices as the accounting source of truth and product export as the product-performance source.",
        ],
    }

    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(result, ensure_ascii=False, indent=2), encoding="utf-8")
    print(json.dumps({"ok": True, "output": str(args.output), "closedSales": closed_total}, ensure_ascii=False))


if __name__ == "__main__":
    main()
