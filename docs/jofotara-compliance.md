# JoFotara / ISTD Compliance — Phase 0 Reference

Status: **PHASE 0 — provisional.** This document records the compliance contract for the ISTD e-invoicing integration against `C:\Projects\pos`. Nothing in Phase 1 may be built until the `PENDING_V1_5` items are resolved against the current official ISTD technical documentation and the user approves moving them.

## 1. Source-of-truth and provenance tags

Every rule is tagged with its evidence source. A third-party source never overrides an official rule.

| Tag | Meaning |
| --- | --- |
| `CURRENT_OFFICIAL_PROCEDURE` | Stated in the current official ISTD/JoFotara technical documentation. The current production document is JoFotara API **v1.5** (third-party citations indicate approval on **2026-05-14**). **v1.5 is NOT yet obtained.** This tag is used only where the current official material already in hand confirms the point. |
| `OFFICIAL_V1_4` | Stated in the older official revision "e-Invoicing Documentation 1.4 - English.pdf". Informational where v1.5 may differ. |
| `SDK` | Observed from the official SDK reference source `jafar-albadarneh/jofotara` (source files read directly). |
| `THIRD_PARTY` | Third-party documentation/citation. Never supersedes an official rule. |
| `PENDING_V1_5` | Unresolved; must be resolved against v1.5 before Phase 1. |

## 2. Sources consulted

1. **ISTD e-Invoicing Documentation v1.5** — the production source of truth (approval cited 2026-05-14). **Not yet acquired**; `istd.gov.jo` / `portal.jofotara.gov.jo` are JS/region-blocked. → `PENDING_V1_5`.
2. **Official PDF v1.4 (English)** — obtained; full text extracted and retained in analysis memory:
   - p86: transport (direct submission)
   - p69: tax categories Z / O / S
   - p82–85: special tax (OTH) subtotal; general-tax base includes the special amount
   - p83: tax rates brackets 0, 1, 2, 3, 4, 5, 7, 8, 10, 16
   - p64: income source present in `SellerSupplierParty/Party/PartyIdentification/cbc:ID`
   - p74: fiscal serial dedup via `cbc:ID` + `cbc:UUID` pair
   - p36 / p62: buyer identifier schemes NIN / PN / TN; payee-name rule at 10,000 JOD
   - Reporting scheme reference `reporting:1.0` (ProfileID example)
3. **Official SDK reference source** `jafar-albadarneh/jofotara` (source files read directly): `JoFotaraService.php`, `BasicInvoiceInformation`, `InvoiceLineItem`, `CustomerInformation`, `SellerInformation`, `SupplierIncomeSource`, `InvoiceTotals`, `JoFotaraResponse`.

## 3. Provisionally confirmed contract — `CURRENT_OFFICIAL_PROCEDURE`

A *provisional* contract, not a locked one. Confirmed by the current official material only:

1. Submission mode: **direct submission**. [`CURRENT_OFFICIAL_PROCEDURE`]
2. Document type: **UBL 2.1 invoice**. [`CURRENT_OFFICIAL_PROCEDURE`]
3. Payload body: `{"invoice": "<base64(UBL)>"}`. [`CURRENT_OFFICIAL_PROCEDURE`]
4. Endpoint: **`/core/invoices/`**. [`CURRENT_OFFICIAL_PROCEDURE`]
5. Headers: **`Client-Id`** + **`Secret-Key`** (no cookie/session auth). [`SDK`]
6. **No status-query endpoint exists in the material in hand and none may be invented.** The absence is recorded as absence-of-evidence. [`CURRENT_OFFICIAL_PROCEDURE (absence of evidence)`]

## 4. Blocker register B1–B10 (Phase 0 scope)

| ID | Blocker | Decision / state |
| --- | --- | --- |
| B1 | **Source of truth.** v1.5 is the production document (cited approval 2026-05-14); v1.4 is the older official revision. v1.5 not yet obtained. | `PENDING_V1_5` — acquire before Phase 1. |
| B2 | **Fiscal regime default.** Must NOT default to `GENERAL_SALES`. Use `UNCONFIGURED`/NULL until the owner explicitly sets `INCOME` / `GENERAL_SALES` / `SPECIAL_SALES`. Block JoFotara activation while unconfigured. Migrate existing tenants only after explicit verification. | Approved decision; storage default `PENDING_V1_5`. |
| B3 | **Income-source cardinality.** Income source ↔ store is NOT a universal 1:1. `fiscal_profile` (taxpayer / income source / credentials / branch / terminal) is only the *preferred architectural direction*; no table until v1.5 confirms cardinality. | `PENDING_V1_5` |
| B4 | **Offline multi-terminal serial collision.** HARD BLOCKER, unresolved. No terminal prefixes, no reserved ranges, no server-side allocation before the official `cbc:ID` / ICV format rules are verified. A unique constraint at reconnect is **insufficient** — the invoice was already issued locally. | `PENDING_V1_5` — no strategy chosen. |
| B5 | **Monetary precision.** No JS binary floating point, ever. Internal high-precision deterministic arithmetic is approved. Rounding mode / rounding stage / persisted scale (fils 3dp, SDK round(…,9)) is `PENDING_V1_5`; **`HALF_UP` must NOT be hardcoded**. | Precision approach approved; rounding parameters `PENDING_V1_5`. |
| B6 | **ProfileID.** Not low-risk. Value / position / required-ness must be resolved against v1.5 **before Phase 1** (v1.4 references `reporting:1.0`; SDK omits it). | `PENDING_V1_5` |
| B7 | **Discount allocation.** pro-rata + remainder-to-last-line is a **candidate only**. The official rule (if different) is binding. | `PENDING_V1_5` |
| B8 | **No backdating.** Backdated invoices are not the default test strategy. "Documented official test procedure" is separated from "SDK / community practice" (credit-note reversal is SDK/community practice only). | `PENDING_V1_5` |
| B9 | **Identifier layers.** Three separate identifiers: internal `sync_id` / issuer `cbc:UUID` / authority response UUID. `sync_id` is a **candidate only** as source for `cbc:UUID`. The issuer `cbc:UUID` is frozen for the invoice fingerprint and is never replaced by an authority response UUID. | `PENDING_V1_5` for exact mapping. |
| B10 | **Special tax.** Do NOT add a blanket `special_tax_amount`. The OTH model must be designed from v1.5 semantics (fixed / percentage, product / line scope, inclusion in the general-tax base) behind a regime gate = `SPECIAL_SALES`. | `PENDING_V1_5` |

## 5. `PENDING_V1_5` — open items (12) resolvable only against the v1.5 document

1. Acquisition of the v1.5 document (B1).
2. Rounding mode / rounding stage / persisted scale — no HALF_UP hardcode (B5).
3. ProfileID required-ness / value / position (B6).
4. Official discount-allocation rule (B7).
5. Special-tax (OTH) modeling (B10).
6. Response-status contract (SUBMITTED / ALREADY_SUBMITTED / NOT_SUBMITTED) and retry semantics (B9-adjacent).
7. Income-source / credentials / seller / terminal cardinality (B3).
8. Payment-method ↔ InvoiceTypeCode mapping confirmation (011/021 income, 012/022 general, 013/023 special — v1.4/SDK only so far).
9. Official test procedure (B8).
10. Offline multi-terminal fiscal-serial strategy (B4).
11. Buyer-details rule final wording (name required when receivable **or** payable > 10,000 JOD; anonymous block).
12. `cbc:UUID` source and internal `sync_id` mapping guidance (B9).

## 6. `OFFICIAL_V1_4` / `SDK_ONLY` rules — provisional, informational

These are grounded in the older official revision and/or the SDK. They provisionally guide design but do not override v1.5.

- Tax categories **Z / O / S**; rate brackets **0, 1, 2, 3, 4, 5, 7, 8, 10, 16**. [`OFFICIAL_V1_4`]
- InvoiceTypeCode: **011 / 021 income, 012 / 022 general, 013 / 023 special** (business / consumer variants). [`SDK`]
- Special tax exposed as an **OTH subtotal**; general-tax base includes the special amount: `(net + special) × rate` — worked example **495 + 10 → 50.50** at 10%. [`OFFICIAL_V1_4`]
- Income source appears in `SellerSupplierParty/Party/PartyIdentification/cbc:ID`. [`OFFICIAL_V1_4`]
- Fiscal serial dedup pair: `cbc:ID` + `cbc:UUID`. [`OFFICIAL_V1_4`]
- Buyer identifier schemes: **NIN** (national) / **PN** (passport) / **TN** (TIN). Anonymous buyer = NIN block with empty value (`schemeID="NIN"`). Payee name required when receivable or payable > 10,000 JOD. [`OFFICIAL_V1_4` + `SDK` cross-check]
- Exemption mapping: `taxExempted` → code **Z**; `zeroTax` → code **O**. [`SDK`]
- Default line tax category **S** at 16%. [`SDK`]
- Invoice totals rounded with `round(…, 9)`. [`SDK`]
- `SupplierIncomeSource` pattern `^\d+$`, mandatory. [`SDK`]
- Seller block: **TIN + name + country code JO** mandatory; governorate + postal recommended. [`SDK` + PDF]
- Response success shape: HTTP 200 + `PASS` + `SUBMITTED` or `ALREADY_SUBMITTED`; retry with same `cbc:ID`+`cbc:UUID` returning `ALREADY_SUBMITTED` is a success. **403 = credential/auth failure.** [`SDK`] — full status semantics still `PENDING_V1_5`.
- Reporting scheme reference `reporting:1.0`. [`OFFICIAL_V1_4`]
- Currency must be preserved exactly as officially specified: `DocumentCurrencyCode = JOD`; money elements `currencyID = "JO"` — not "normalized" to generic UBL/ISO rules. [contract constant]
- JOD = 1000 fils (storage dividing by 100 is a misnomer). [currency fact]

## 7. `DB_SCHEMA_CHANGE_ITEMS` — Phase 1 pending, **do NOT execute now** (8)

Basis: schema audit of migrations 021/022/050/051/079/100.

1. `tenant_tax_settings` — add **`fiscal_regime`** `varchar(16) NOT NULL DEFAULT 'UNCONFIGURED'` + CHECK `IN ('UNCONFIGURED','INCOME','GENERAL_SALES','SPECIAL_SALES')`. **Never** default to `GENERAL_SALES`. (B2)
2. `tenant_tax_settings` — activation gating: JoFotara activation blocked while `fiscal_regime = 'UNCONFIGURED'` (guard column / logic). (B2)
3. `tenant_tax_settings` — add income-source number (`istd_income_source`, digits-only `^\d+$`); cardinality per seller/invoice pending B3. (B3)
4. `sales_invoices` — frozen fiscal-serial identity columns (`fiscal_serial` / `fiscal_icv`); design stalled on B4, formula rules unverified. (B4)
5. `sales_invoice_items` — explicit tax-code handling (Z / O / S / OTH combinations) replacing the current single `tax_percent` / `tax_included` / `tax_amount` assumption (021/022 audit: one tax per line today). (B10)
6. `sales_invoice_items` — money precision: move from `DECIMAL(12,2)` to fils-accurate storage with 9-dp rounding persistence; exact scale `PENDING_V1_5`. (B5)
7. `istd_submissions` (exists, keyed by `sync_id` — good basis) — extend with authority-response fields (response UUID, status, raw JSONB, submitted_at, retried flag) for dedup / retry semantics. (B9)
8. `sales_invoices` / `istd_submissions` — per-tenant currency lock: `JOD` / `JO` preserved exactly, no generic-UBL normalization. [contract constant]

## 8. Explicitly out of scope / cancelled

- No blanket `special_tax_amount` column. (B10)
- No terminal-prefix / reserved-range serialization. (B4)
- No default `GENERAL_SALES`. (B2)
- No backdating as the default test approach. (B8)
- No `sync_id == cbc:UUID` conflation. (B9)
- No generic currency normalization; no invented status-query endpoint.
- No hardcoded `HALF_UP`. (B5)

## 9. Phase 0 → Phase 1 gate

Phase 1 (UBL serializer, JoFotara client, fiscal mapper, migrations, RLS, device sessions, serial generation) does **not** start until:

- v1.5 is acquired and the 12 `PENDING_V1_5` items are resolved with evidence tags; and
- the user approves moving the resolved items.

`BYPASS_ISTD = true` in `supabase/functions/jofotara/index.ts` remains **unchanged**.