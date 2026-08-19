DROP POLICY IF EXISTS "Product images are readable" ON storage.objects;
CREATE POLICY "Product images are readable" ON storage.objects
  FOR SELECT USING (bucket_id = 'product-images');

DROP POLICY IF EXISTS "Catalog staff upload product images" ON storage.objects;
CREATE POLICY "Catalog staff upload product images" ON storage.objects
  FOR INSERT TO authenticated
  WITH CHECK (bucket_id = 'product-images' AND public.can_manage_catalog(auth.uid()));

DROP POLICY IF EXISTS "Catalog staff update product images" ON storage.objects;
CREATE POLICY "Catalog staff update product images" ON storage.objects
  FOR UPDATE TO authenticated
  USING (bucket_id = 'product-images' AND public.can_manage_catalog(auth.uid()));

DROP POLICY IF EXISTS "Catalog staff delete product images" ON storage.objects;
CREATE POLICY "Catalog staff delete product images" ON storage.objects
  FOR DELETE TO authenticated
  USING (bucket_id = 'product-images' AND public.can_manage_catalog(auth.uid()));