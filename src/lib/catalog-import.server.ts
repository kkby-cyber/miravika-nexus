/**
 * Server-only Amazon / Flipkart catalog importer.
 *
 * SKU is the primary identity.
 * Preview/dry-run never mutates catalog data.
 * Commit is idempotent for products, variants, images and inventory.
 */

import { requirePermission, recordActivity } from "@/lib/staff.server";

type StaffCtx = {
  supabase: any;
  userId: string;
};

type RawRow = Record<string, unknown>;

type ImportRow = {
  sku: string;
  title: string;
  description: string | null;
  short_description: string | null;
  brand: string;
  product_type: string | null;
  material: string | null;
  size: string | null;
  color: string | null;
  mrp: number | null;
  price: number;
  compare_at_price: number | null;
  tax_rate: number | null;
  tax_inclusive: boolean;
  hsn_code: string | null;
  weight_grams: number | null;
  length_cm: number | null;
  width_cm: number | null;
  height_cm: number | null;
  stock: number | null;
  image_urls: string[];
  collections: string[];
  seo_title: string | null;
  seo_description: string | null;
  seo_keywords: string | null;
  is_featured: boolean;
  is_bestseller: boolean;
  is_trending: boolean;
  is_visible: boolean;
};

type NormalizedRow = ImportRow & {
  rowNumber: number;
  errors: string[];
  warnings: string[];
};

function text(value: unknown): string {
  return String(value ?? "").trim();
}

function nullable(value: unknown): string | null {
  const valueText = text(value);
  return valueText ? valueText : null;
}

function numberOrNull(value: unknown): number | null {
  if (value === null || value === undefined || value === "") return null;

  const parsed = Number(String(value).replace(/,/g, "").trim());
  return Number.isFinite(parsed) ? parsed : null;
}

function booleanOrDefault(value: unknown, fallback: boolean): boolean {
  if (value === null || value === undefined || value === "") return fallback;

  if (typeof value === "boolean") return value;

  const normalized = text(value).toLowerCase();

  if (["true", "1", "yes", "y", "on"].includes(normalized)) return true;
  if (["false", "0", "no", "n", "off"].includes(normalized)) return false;

  return fallback;
}

function parseList(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value.map(text).filter(Boolean);
  }

  const valueText = text(value);
  if (!valueText) return [];

  return valueText
    .split(/[|,;]+/)
    .map((item) => item.trim())
    .filter(Boolean);
}

function slugify(value: string): string {
  const slug = value
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .replace(/-{2,}/g, "-");

  return slug || "product";
}

function normalizeHeaderKey(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "");
}

function firstValue(raw: RawRow, keys: string[]): unknown {
  for (const key of keys) {
    const value = raw[key];
    if (value !== undefined && value !== null && String(value).trim() !== "") {
      return value;
    }
  }

  const normalizedRaw = new Map<string, unknown>();

  for (const [rawKey, value] of Object.entries(raw)) {
    const normalizedKey = normalizeHeaderKey(rawKey);

    if (
      normalizedKey &&
      value !== undefined &&
      value !== null &&
      String(value).trim() !== ""
    ) {
      normalizedRaw.set(normalizedKey, value);
    }
  }

  for (const key of keys) {
    const value = normalizedRaw.get(normalizeHeaderKey(key));

    if (value !== undefined && value !== null && String(value).trim() !== "") {
      return value;
    }
  }

  return undefined;
}

function normalizeRow(raw: RawRow, rowNumber: number): NormalizedRow {
  const sku = text(
    firstValue(raw, ["sku", "SKU", "Seller SKU", "SellerSKU", "Style Code", "StyleCode"]),
  );

  const title = text(
    firstValue(raw, ["title", "Title", "Product Name", "ProductName", "name", "Name"]),
  );

  const price = numberOrNull(
    firstValue(raw, [
      "price",
      "Price",
      "Selling Price",
      "SellingPrice",
      "Meesho Price",
      "Flipkart Selling Price",
    ]),
  );

  const row: ImportRow = {
    sku,
    title,
    description: nullable(
      firstValue(raw, ["description", "Description", "Product Description"]),
    ),
    short_description: nullable(
      firstValue(raw, ["short_description", "Short Description"]),
    ),
    brand:
      nullable(firstValue(raw, ["brand", "Brand"])) ??
      "MIRAVIKA",
    product_type: nullable(
      firstValue(raw, ["product_type", "Product Type", "Type", "Category"]),
    ),
    material: nullable(firstValue(raw, ["material", "Material"])),
    size: nullable(firstValue(raw, ["size", "Size"])),
    color: nullable(firstValue(raw, ["color", "Color"])),
    mrp: numberOrNull(firstValue(raw, ["mrp", "MRP", "MRP Price"])),
    price: price ?? 0,
    compare_at_price: numberOrNull(
      firstValue(raw, ["compare_at_price", "Compare At Price", "Compare Price"]),
    ),
    tax_rate: numberOrNull(
      firstValue(raw, ["tax_rate", "Tax Rate", "GST", "gst", "GST Rate"]),
    ),
    tax_inclusive: booleanOrDefault(
      firstValue(raw, ["tax_inclusive", "Tax Inclusive"]),
      true,
    ),
    hsn_code: nullable(firstValue(raw, ["hsn_code", "HSN", "HSN Code"])),
    weight_grams: numberOrNull(
      firstValue(raw, ["weight_grams", "Weight", "Net Weight"]),
    ),
    length_cm: numberOrNull(firstValue(raw, ["length_cm", "Length"])),
    width_cm: numberOrNull(firstValue(raw, ["width_cm", "Width"])),
    height_cm: numberOrNull(firstValue(raw, ["height_cm", "Height"])),
    stock: numberOrNull(
      firstValue(raw, [
        "stock",
        "Stock",
        "Inventory",
        "Available Quantity",
        "Quantity",
      ]),
    ),
    image_urls: parseList(
      firstValue(raw, [
        "image_urls",
        "Images",
        "Image URLs",
        "Image URL",
        "Images URLs",
      ]),
    ),
    collections: parseList(
      firstValue(raw, ["collections", "Collections", "Category"]),
    ),
    seo_title: nullable(firstValue(raw, ["seo_title", "SEO Title"])),
    seo_description: nullable(
      firstValue(raw, ["seo_description", "SEO Description"]),
    ),
    seo_keywords: nullable(
      firstValue(raw, ["seo_keywords", "SEO Keywords"]),
    ),
    is_featured: booleanOrDefault(
      firstValue(raw, ["is_featured", "Featured"]),
      false,
    ),
    is_bestseller: booleanOrDefault(
      firstValue(raw, ["is_bestseller", "Bestseller", "Best Seller"]),
      false,
    ),
    is_trending: booleanOrDefault(
      firstValue(raw, ["is_trending", "Trending"]),
      false,
    ),
    is_visible: booleanOrDefault(
      firstValue(raw, ["is_visible", "Visible"]),
      true,
    ),
  };

  const errors: string[] = [];
  const warnings: string[] = [];

  if (!row.sku) errors.push("SKU is required");
  if (!row.title) errors.push("Product title is required");
  if (row.price <= 0) errors.push("Selling price must be greater than 0");

  if (row.mrp !== null && row.mrp < 0) {
    errors.push("MRP cannot be negative");
  }

  if (row.mrp !== null && row.price > row.mrp) {
    errors.push("Selling price cannot be greater than MRP");
  }

  if (row.tax_rate !== null && (row.tax_rate < 0 || row.tax_rate > 100)) {
    errors.push("GST/tax rate must be between 0 and 100");
  }

  if (
    row.stock !== null &&
    (!Number.isInteger(row.stock) || row.stock < 0)
  ) {
    errors.push("Stock must be a non-negative integer");
  }

  if (row.weight_grams !== null && row.weight_grams < 0) {
    errors.push("Weight cannot be negative");
  }

  if (!row.image_urls.length) {
    warnings.push("No product images supplied");
  }

  return {
    ...row,
    rowNumber,
    errors,
    warnings,
  };
}

async function loadExistingProducts(
  db: any,
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

async function findCollectionId(
  db: any,
  name: string,
): Promise<string | null> {
  const slug = slugify(name);

  const { data: existing, error } = await db
    .from("collections")
    .select("id")
    .or(`slug.eq.${slug},title.ilike.${name}`)
    .is("deleted_at", null)
    .limit(1)
    .maybeSingle();

  if (error) throw new Error(error.message);

  return existing?.id ? String(existing.id) : null;
}

function productPayload(row: ImportRow, slug: string) {
  return {
    sku: row.sku,
    title: row.title,
    slug,
    description: row.description,
    short_description: row.short_description,
    brand: row.brand,
    product_type: row.product_type,
    material: row.material,
    size: row.size,
    color: row.color,
    mrp: row.mrp,
    price: row.price,
    compare_at_price: row.compare_at_price,
    tax_rate: row.tax_rate ?? 0,
    tax_inclusive: row.tax_inclusive,
    hsn_code: row.hsn_code,
    weight_grams: row.weight_grams,
    length_cm: row.length_cm,
    width_cm: row.width_cm,
    height_cm: row.height_cm,
    status: "ACTIVE" as const,
    seo_title: row.seo_title,
    seo_description: row.seo_description,
    seo_keywords: row.seo_keywords,
    is_featured: row.is_featured,
    is_bestseller: row.is_bestseller,
    is_trending: row.is_trending,
    is_visible: row.is_visible,
  };
}

export async function previewCatalogImport(
  ctx: StaffCtx,
  input: {
    filename: string;
    rows: RawRow[];
  },
) {
  await requirePermission(ctx, "products.create");

  const normalized = input.rows.map((row, index) =>
    normalizeRow(row, index + 2),
  );

  const seen = new Set<string>();

  for (const row of normalized) {
    if (!row.sku) continue;

    if (seen.has(row.sku)) {
      row.errors.push(`Duplicate SKU in file: ${row.sku}`);
    }

    seen.add(row.sku);
  }

  const existing = await loadExistingProducts(
    ctx.supabase,
    normalized,
  );

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

async function ensureSlug(
  db: any,
  title: string,
  sku: string,
  existingId?: string,
): Promise<string> {
  const base = slugify(title);
  const candidate = `${base}-${slugify(sku)}`;

  const { data } = await db
    .from("products")
    .select("id")
    .eq("slug", candidate)
    .maybeSingle();

  if (!data || String(data.id) === existingId) {
    return candidate;
  }

  return `${candidate}-${Date.now().toString(36)}`;
}

async function upsertProduct(
  db: any,
  row: ImportRow,
): Promise<{ id: string; created: boolean }> {
  const { data: existing, error: lookupError } = await db
    .from("products")
    .select("id, slug")
    .eq("sku", row.sku)
    .is("deleted_at", null)
    .maybeSingle();

  if (lookupError) throw new Error(lookupError.message);

  const slug = await ensureSlug(
    db,
    row.title,
    row.sku,
    existing?.id ? String(existing.id) : undefined,
  );

  const payload = productPayload(row, slug);

  if (existing?.id) {
    const { error } = await db
      .from("products")
      .update(payload)
      .eq("id", existing.id);

    if (error) throw new Error(error.message);

    return {
      id: String(existing.id),
      created: false,
    };
  }

  const { data, error } = await db
    .from("products")
    .insert(payload)
    .select("id")
    .single();

  if (error) throw new Error(error.message);

  return {
    id: String(data.id),
    created: true,
  };
}

async function upsertVariant(
  db: any,
  row: ImportRow,
  productId: string,
) {
  const { data: existing, error: lookupError } = await db
    .from("product_variants")
    .select("id")
    .eq("sku", row.sku)
    .maybeSingle();

  if (lookupError) throw new Error(lookupError.message);

  const payload = {
    product_id: productId,
    sku: row.sku,
    title: row.title,
    price: row.price,
    mrp: row.mrp,
    attributes: {
      size: row.size,
      color: row.color,
      material: row.material,
    },
    position: 0,
    status: "ACTIVE" as const,
  };

  if (existing?.id) {
    const { error } = await db
      .from("product_variants")
      .update(payload)
      .eq("id", existing.id);

    if (error) throw new Error(error.message);

    return String(existing.id);
  }

  const { data, error } = await db
    .from("product_variants")
    .insert(payload)
    .select("id")
    .single();

  if (error) throw new Error(error.message);

  return String(data.id);
}

async function upsertImages(
  db: any,
  row: ImportRow,
  productId: string,
) {
  for (let position = 0; position < row.image_urls.length; position += 1) {
    const url = row.image_urls[position];

    const { data: existing, error: lookupError } = await db
      .from("product_images")
      .select("id")
      .eq("product_id", productId)
      .eq("url", url)
      .maybeSingle();

    if (lookupError) throw new Error(lookupError.message);

    if (existing?.id) {
      const { error } = await db
        .from("product_images")
        .update({
          alt_text: row.title,
          position,
          is_main: position === 0,
        })
        .eq("id", existing.id);

      if (error) throw new Error(error.message);
    } else {
      const { error } = await db
        .from("product_images")
        .insert({
          product_id: productId,
          url,
          alt_text: row.title,
          position,
          is_main: position === 0,
        });

      if (error) throw new Error(error.message);
    }
  }
}

async function syncCollections(
  db: any,
  row: ImportRow,
  productId: string,
) {
  if (!row.collections.length) return;

  for (let position = 0; position < row.collections.length; position += 1) {
    const collectionName = row.collections[position];
    if (!collectionName) continue;

    const matchedCollectionId = await findCollectionId(
      db,
      collectionName,
    );

    if (!matchedCollectionId) continue;

    const { error } = await db
      .from("product_collections")
      .upsert(
        {
          product_id: productId,
          collection_id: matchedCollectionId,
          position,
        },
        {
          onConflict: "product_id,collection_id",
        },
      );

    if (error) throw new Error(error.message);
  }
}

async function syncInventory(
  db: any,
  row: ImportRow,
  productId: string,
  variantId: string,
  userId: string,
) {
  if (row.stock === null) return;

  const { data: existing, error: lookupError } = await db
    .from("inventory")
    .select("id, available_quantity, reserved_quantity, sold_quantity")
    .eq("sku", row.sku)
    .maybeSingle();

  if (lookupError) throw new Error(lookupError.message);

  const previousAvailable = Number(existing?.available_quantity ?? 0);
  const reserved = Number(existing?.reserved_quantity ?? 0);
  const sold = Number(existing?.sold_quantity ?? 0);

  const payload = {
    product_id: productId,
    variant_id: variantId,
    sku: row.sku,
    available_quantity: row.stock,
    reserved_quantity: reserved,
    sold_quantity: sold,
    low_stock_threshold: 5,
  };

  let inventoryId: string;

  if (existing?.id) {
    const { error } = await db
      .from("inventory")
      .update(payload)
      .eq("id", existing.id);

    if (error) throw new Error(error.message);

    inventoryId = String(existing.id);
  } else {
    const { data, error } = await db
      .from("inventory")
      .insert(payload)
      .select("id")
      .single();

    if (error) throw new Error(error.message);

    inventoryId = String(data.id);
  }

  const delta = row.stock - previousAvailable;

  if (delta !== 0) {
    const { error } = await db
      .from("inventory_movements")
      .insert({
        inventory_id: inventoryId,
        type: "import",
        quantity: delta,
        reference_type: "catalog_import",
        note: `Catalog import for SKU ${row.sku}`,
        created_by: userId,
      });

    if (error) throw new Error(error.message);
  }
}

export async function commitCatalogImport(
  ctx: StaffCtx,
  input: {
    filename: string;
    rows: RawRow[];
    importBatchId?: string;
  },
) {
  await requirePermission(ctx, "products.create");
  await requirePermission(ctx, "inventory.edit");

  const normalized = input.rows.map((row, index) =>
    normalizeRow(row, index + 2),
  );

  const seen = new Set<string>();

  for (const row of normalized) {
    if (!row.sku) continue;

    if (seen.has(row.sku)) {
      row.errors.push(`Duplicate SKU in file: ${row.sku}`);
    }

    seen.add(row.sku);
  }

  const invalidRows = normalized.filter((row) => row.errors.length > 0);

  if (invalidRows.length > 0) {
    throw new Error(
      `Import blocked: ${invalidRows.length} invalid row(s). Run preview first.`,
    );
  }

  let created = 0;
  let updated = 0;

  for (const row of normalized) {
    const product = await upsertProduct(ctx.supabase, row);

    if (product.created) created += 1;
    else updated += 1;

    const variantId = await upsertVariant(
      ctx.supabase,
      row,
      product.id,
    );

    await upsertImages(
      ctx.supabase,
      row,
      product.id,
    );

    await syncCollections(
      ctx.supabase,
      row,
      product.id,
    );

    await syncInventory(
      ctx.supabase,
      row,
      product.id,
      variantId,
      ctx.userId,
    );
  }

  if (input.importBatchId) {
    const { error } = await ctx.supabase
      .from("import_batches")
      .update({
        status: "COMMITTED",
        total_rows: normalized.length,
        new_count: created,
        update_count: updated,
        duplicate_count: 0,
        invalid_count: 0,
        rows: normalized,
      })
      .eq("id", input.importBatchId);

    if (error) throw new Error(error.message);
  }

  await recordActivity(ctx, {
    action: "CATALOG_IMPORT_COMMITTED",
    entityType: "import_batch",
    ...(input.importBatchId
      ? { entityId: input.importBatchId }
      : {}),
    entityName: input.filename,
    metadata: {
      total: normalized.length,
      created,
      updated,
    },
  });

  return {
    success: true,
    filename: input.filename,
    total: normalized.length,
    created,
    updated,
  };
}
