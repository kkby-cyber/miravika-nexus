# Catalogue import — dry-run reconciliation (2026-10-10)

Read-only analysis of the stored Flipkart listing preview
(`S_listing--ui--group_46ddda62895c4140_2209-163831_default.csv`, batch status `PREVIEW`,
uploaded 2026-09-22) against import rules v2. **No catalogue data was written.**

## Current production state (Supabase project `fvvixbkierlggfpxmrau`)

| Table                                 | Rows                                                                                                                         |
| ------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| products / product_images / inventory | **0** — the catalogue has never been committed                                                                               |
| collections                           | 7 (`new-arrivals`, `trending-now`, `womens-fashion`, `jewelry-accessories`, `beauty-personal-care`, `gifts`, `best-sellers`) |
| shipping_methods                      | 1 — Standard Delivery, ₹79 flat, free ≥ ₹999, 4–7 days                                                                       |
| import_batches                        | 7 previews, none committed (6 × `all_inventory…NON_FBF.csv`, 177/177 invalid; 1 × listing file)                              |
| storage buckets                       | **none** — product photos are not hosted in Supabase                                                                         |

## Listing file outcome under rules v2

| Outcome                                                        | Rows    |
| -------------------------------------------------------------- | ------- |
| Total rows                                                     | 152     |
| Flipkart template/instructions row (dropped before validation) | 1       |
| **Accepted (MIRAVIKA)**                                        | **129** |
| — with photos available in `miravika-lumina-core/.mira-img`    | 102     |
| — without any photos                                           | 27      |
| **Rejected — title names another brand**                       | **22**  |
| Duplicate SKUs                                                 | 0       |

Every accepted row maps to a storefront collection:
`earring`, `necklace_chain` → Earrings & Jewelry · `hair_accessory` → Hair Accessories ·
`rakhi_set` → Rakhi & Gifts · `puff_sponge` → Beauty & Personal Care.

The file contains **no image URLs and no stock quantities**. Committed as-is, every product
would be created as a **DRAFT** (not visible) with no inventory (not purchasable). That is
the intended safe behaviour, not a failure.

## Rejected rows — owner decision required

These titles name another brand. All 22 have MIRAVIKA-styled photos, and some were sold on
the previous Shopify store under MIRAVIKA titles, so they may be your own stock with
marketplace-copied titles. To approve a row, add a `Brand` column set to `MIRAVIKA` (and
ideally correct the title) and upload again. To keep it off the website, do nothing.

`BLACK-BOY-EARRING-MIR-001` (Shree Ju) · `BLACK-EARRINGS-BOYS-002` (Shree Ju) ·
`BLANK-BOY-011` (vien creation) · `BOY-EARRINGS-001` (vien creation) ·
`BOYS-EARRING-001` (house of common) · `DAIMOND-EARRING-001` (Sharvi) ·
`FACIAL-CLEANER` (NIGRIFIX) · `FACIAL-CLEANNING-01` (flamgam) · `LUCKY-SPONGE-001` (Dazzle) ·
`MAHAKAL-BOYS-EARRING` (Maatrachaaya) · `MIR-EAR-SLV-HOOP-01` (**"Miravica" — likely a typo
of MIRAVIKA**) · `MIR-EARRINGS-BOYS-DAIMOND-002` (Pundriksh) · `MIRAV-EAR-DAIMOND-011`
(JAWEXA) · `MIRAV-MAHAKAL-1111` (MAATRCHAAYA) · `MIRAVIKA-EARRING-BOY` (MA FASHION) ·
`MIRAVIKA-EARRING-BOY-STRIKE-1111` (Pundriksh) · `MULTICOLORSPONGE-0011` (GURIYA) ·
`SILVER-EARRING-002` (vien creation) · `SINGLE-EAR-DAIMOND-011` (OM GRAVZ) ·
`SPONGE-002` (Dazzle) · `SPONGE-003` (Asl World) · `SPONGE-OF-BEUTY-111` (Earthcon)

## Accepted SKUs with no photos (27)

`DAIMOND-MAN-01` `DRK-3PC-B2G1-001` `DRK-5PC-B4G1-002` `MIR-BBS-5PCS-001`
`MIR-CHAIN-KA-001` `MIR-CHAINAK1-001` `MIR-DES-RK26-4638` `MIR-EAR-COMBO-01`
`MIR-EAR-GOLD-KA-001` `MIR-EAR-JISUS-CROS-01` `MIR-FLORAL-RAKHI-004`
`MIR-FLOWER-BLUE-COMBO3` `MIR-FLR-PNK-8264` `MIR-PAISLEY-RK26-9136`
`MIR-PEACOCK-RK26-7351` `MIR-RK26-BLU-8472` `MIR-RK26-FLR-5839` `MIR-ROSE-RK26-6842`
`MIRA-DRK-002` `MIRAVIKA-BOW-BLACKPINK-2PC-01` `MV-MAG-STUD-SLV-6MM` `MVK-VFHC-01`
`MVRMHKSLV01` `MVSE001` `RAKHI-BUY4GET1-DESIGNER-5PC-001` `RIMJIM-RAKHI-5PC-01`
`SILVER-EAR-MIR-001`

`.mira-img` also contains `test1.jpg`, which matches no SKU (reported, not removed).

## What is needed for a live catalogue

1. **Host the photos.** Create a public Supabase Storage bucket (e.g. `product-images`) or
   use the existing CDN, upload `.mira-img/<SKU>-<n>.jpg` unchanged, and supply the URLs in
   an `Image URLs` column (pipe-separated). Uploading is a production write, so it waits for
   your approval.
2. **Supply stock.** Add a `Your Stock Count` (or `Stock`) column to the listing file so
   products are purchasable. The six `all_inventory…NON_FBF.csv` previews failed all 177
   rows: SKUs were read, but no title, price **or stock** value was recognised, so that
   export's stock column uses a header the importer does not know yet. Share the file's
   header row and the importer can be taught to read it (only the header names are needed).
3. **Decide the 22 third-party rows** (above).
4. Re-upload in Admin → Import (old previews are refused by the v2 rules), review the
   preview counts against this report, then commit.
