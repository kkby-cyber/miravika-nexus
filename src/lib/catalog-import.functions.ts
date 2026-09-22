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
  .inputValidator(
    (data: {
      filename: string;
      rows: Record<string, unknown>[];
      importBatchId?: string;
    }) => data,
  )
  .handler(async ({ data, context }) => {
    return commit(context, data);
  });
