/**
 * Server-only Amazon / Flipkart catalog importer.
 *
 * SKU is the primary identity.
 * Preview/dry-run never mutates catalog data; it validates rows with the pure rules in
 * catalog-import-rules.ts and stores them for review.
 * Commit runs atomically in the commit_catalog_import database function.
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "@/integrations/supabase/types";
import { normalizeRow, type NormalizedRow, type RawRow } from "@/lib/catalog-import-rules";
import { requirePermission } from "@/lib/staff.server";

type StaffCtx = {
  supabase: SupabaseClient<Database>;
  userId: string;
};

async function loadExistingProducts(
  db: SupabaseClient<Database>,
  rows: NormalizedRow[],
): Promise<Map<string, { id: string; slug: string }>> {
  const skus = [...new Set(rows.map((row) => row.sku).filter(Boolean))];

  const result = new Map<string, { id: string; slug: string }>();

  if (!skus.length) return result;

  for (let offset = 0; offset < skus.length; offset += 500) {
    const batch = skus.slice(offset, offset + 500);

    const { data, error } = await db
      .from("products")
      .select("id, sku, slug")
      .in("sku", batch)
      .is("deleted_at", null);

    if (error) throw new Error(error.message);

    for (const product of data ?? []) {
      result.set(String(product.sku), {
        id: String(product.id),
        slug: String(product.slug),
      });
    }
  }

  return result;
}

export async function previewCatalogImport(
  ctx: StaffCtx,
  input: {
    filename: string;
    rows: RawRow[];
  },
) {
  await requirePermission(ctx, "products.create");

  const normalized = input.rows
    .filter((row) => {
      const values = Object.values(row).map((value) => String(value ?? "").trim());

      return !values.some(
        (value) =>
          value === "Your Identifier for a product" ||
          value === "Title of your product as on Flipkart.com",
      );
    })
    .map((row, index) => normalizeRow(row, index + 2));

  const seen = new Set<string>();

  for (const row of normalized) {
    if (!row.sku) continue;

    if (seen.has(row.sku)) {
      row.errors.push(`Duplicate SKU in file: ${row.sku}`);
    }

    seen.add(row.sku);
  }

  const existing = await loadExistingProducts(ctx.supabase, normalized);

  const invalid = normalized.filter((row) => row.errors.length > 0);
  const valid = normalized.filter((row) => row.errors.length === 0);

  const newRows = valid.filter((row) => !existing.has(row.sku));
  const updateRows = valid.filter((row) => existing.has(row.sku));

  const batch = {
    filename: input.filename,
    status: "PREVIEW",
    total_rows: normalized.length,
    new_count: newRows.length,
    update_count: updateRows.length,
    duplicate_count: normalized.filter((row) =>
      row.errors.some((error) => error.startsWith("Duplicate SKU")),
    ).length,
    invalid_count: invalid.length,
    rows: normalized,
    created_by: ctx.userId,
  };

  const { data, error } = await ctx.supabase
    .from("import_batches")
    .insert(batch)
    .select("id")
    .single();

  if (error) throw new Error(error.message);

  return {
    importBatchId: data.id,
    filename: input.filename,
    total: normalized.length,
    newCount: newRows.length,
    updateCount: updateRows.length,
    duplicateCount: batch.duplicate_count,
    invalidCount: invalid.length,
    rows: normalized,
  };
}

type CatalogImportResult = {
  success: boolean;
  filename: string;
  total: number;
  created: number;
  updated: number;
  drafted?: number;
};

export async function commitCatalogImport(ctx: StaffCtx, input: { importBatchId: string }) {
  await requirePermission(ctx, "products.create");
  await requirePermission(ctx, "inventory.edit");

  // commit_catalog_import postdates the generated Database types, so call it through a
  // narrow signature instead of widening the whole client to `any`.
  const rpc = ctx.supabase.rpc as unknown as (
    fn: "commit_catalog_import",
    args: { _batch_id: string },
  ) => Promise<{ data: CatalogImportResult | null; error: { message: string } | null }>;
  const { data, error } = await rpc.call(ctx.supabase, "commit_catalog_import", {
    _batch_id: input.importBatchId,
  });

  if (error) {
    throw new Error(error.message || "Catalog import transaction failed.");
  }
  if (!data || data.success !== true) {
    throw new Error("Catalog import did not return a successful result.");
  }

  return data;
}
