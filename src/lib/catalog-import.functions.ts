import { createServerFn } from "@tanstack/react-start";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import {
  previewCatalogImport as preview,
  commitCatalogImport as commit,
} from "@/lib/catalog-import.server";

export const previewCatalogImport = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator(
    (data: {
      filename: string;
      rows: Record<string, unknown>[];
    }) => data,
  )
  .handler(async ({ data, context }) => {
    return preview(context, data);
  });

export const commitCatalogImport = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((data: { importBatchId: string }) => {
    if (
      typeof data?.importBatchId !== "string" ||
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(data.importBatchId)
    ) {
      throw new Error("A valid import batch ID is required.");
    }
    return data;
  })
  .handler(async ({ data, context }) => {
    return commit(context, data);
  });
