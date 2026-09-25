import { auditCommerceMutation } from "@/lib/commerce-audit.server";
import { resolveLines, userFromRequest } from "@/lib/store.server";
import { normalizeEmail, verifiedPurchaseStatus } from "@/lib/customer-commerce-rules";

// Server-only service-role operations. Ownership is checked in every method.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Admin = any;

export type CustomerIdentity = { id: string; email: string | null };

export async function authenticatedCustomer(request: Request): Promise<CustomerIdentity | null> {
  return userFromRequest(request);
}

function validGuestToken(token: string | null | undefined) {
  return Boolean(token && /^[a-zA-Z0-9_-]{32,128}$/.test(token));
}

export function newGuestToken() {
  return `${crypto.randomUUID().replaceAll("-", "")}${crypto.randomUUID().replaceAll("-", "")}`;
}

function assertMutableCart(cart: Admin) {
  if (cart.status !== "ACTIVE") throw new Error("CART_NOT_ACTIVE");
}

async function findCart(
  admin: Admin,
  customerId: string | null,
  guestToken: string | null,
  status: "ACTIVE" | "CHECKOUT" | "CONVERTED" | "MERGED",
) {
  let query = admin.from("carts").select("*").eq("status", status);
  query = customerId ? query.eq("user_id", customerId) : query.eq("session_token", guestToken);
  const { data, error } = await query
    .order("updated_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error) throw new Error("CART_LOOKUP_FAILED");
  return data;
}

async function cartFor(admin: Admin, customerId: string | null, guestToken: string | null) {
  if (!customerId && !validGuestToken(guestToken)) throw new Error("GUEST_CART_TOKEN_REQUIRED");

  const active = await findCart(admin, customerId, guestToken, "ACTIVE");
  if (active) return active;

  // Do not create a replacement cart while checkout owns the current one. This
  // prevents a refresh during payment from resurrecting a second active cart.
  const checkingOut = await findCart(admin, customerId, guestToken, "CHECKOUT");
  if (checkingOut) return checkingOut;

  // session_token is unique. Reuse a terminal row instead of attempting to
  // insert a second guest cart, but only after no newer checkout is in progress.
  const reusable =
    (await findCart(admin, customerId, guestToken, "CONVERTED")) ??
    (await findCart(admin, customerId, guestToken, "MERGED"));
  if (reusable) {
    const { data: reset, error: resetError } = await admin
      .from("carts")
      .update({ status: "ACTIVE", checkout_claim_id: null, coupon_code: null })
      .eq("id", reusable.id)
      .in("status", ["CONVERTED", "MERGED"])
      .select("*")
      .single();
    if (resetError || !reset) throw new Error("CART_CREATE_FAILED");
    return reset;
  }

  const { data: created, error: createError } = await admin
    .from("carts")
    .insert({ user_id: customerId, session_token: customerId ? null : guestToken })
    .select("*")
    .single();
  if (createError || !created) throw new Error("CART_CREATE_FAILED");
  return created;
}

async function cartView(admin: Admin, cart: Admin) {
  const { data, error } = await admin
    .from("cart_items")
    .select(
      "id, product_id, variant_id, quantity, products(title, slug, status, deleted_at, price), product_variants(title, sku, price, status)",
    )
    .eq("cart_id", cart.id)
    .order("created_at");
  if (error) throw new Error("CART_ITEMS_LOOKUP_FAILED");
  const publicCart = { ...cart };
  delete publicCart.checkout_claim_id;
  return { cart: publicCart, items: data ?? [] };
}

/**
 * Claims the caller's current server cart for checkout. No cart identifier is
 * accepted from the browser; ownership is derived from the bearer identity or
 * the opaque guest token and checked again by the database RPC.
 */
export async function claimCartForCheckout(
  admin: Admin,
  customerId: string | null,
  guestToken: string | null,
) {
  const cart = await cartFor(admin, customerId, guestToken);
  if (cart.status !== "ACTIVE") throw new Error("CART_CHECKOUT_IN_PROGRESS");

  const { data, error } = await admin.rpc("claim_checkout_cart", {
    _cart_id: cart.id,
    _user_id: customerId,
    _session_token: guestToken,
  });
  if (error) throw new Error("CART_CLAIM_FAILED");
  if (!data?.ok || !data.checkout_claim_id) throw new Error(data?.error ?? "CART_NOT_AVAILABLE");
  return { cartId: cart.id, checkoutClaimId: String(data.checkout_claim_id) };
}

export async function releaseCartClaim(
  admin: Admin,
  customerId: string | null,
  guestToken: string | null,
  cartId: string,
  checkoutClaimId: string,
) {
  const { data, error } = await admin.rpc("release_checkout_cart", {
    _cart_id: cartId,
    _checkout_claim_id: checkoutClaimId,
    _user_id: customerId,
    _session_token: guestToken,
  });
  if (error || data !== true) throw new Error("CART_RELEASE_FAILED");
}

/** Loads SKU/quantity pairs exclusively from the exact claimed cart. */
export async function loadAuthoritativeCartLines(
  admin: Admin,
  cartId: string,
  checkoutClaimId: string,
) {
  const { data: cart, error: cartError } = await admin
    .from("carts")
    .select("status, checkout_claim_id")
    .eq("id", cartId)
    .maybeSingle();
  if (cartError || cart?.status !== "CHECKOUT" || cart.checkout_claim_id !== checkoutClaimId)
    throw new Error("CART_CLAIM_MISMATCH");

  const { data, error } = await admin
    .from("cart_items")
    .select("product_id, variant_id, quantity, products!inner(sku, status, deleted_at, is_visible)")
    .eq("cart_id", cartId)
    .order("created_at");
  if (error) throw new Error("CART_ITEMS_LOOKUP_FAILED");

  const rows = (data ?? []) as unknown as Array<{
    product_id: string;
    variant_id: string | null;
    quantity: number;
    products: {
      sku: string;
      status: string;
      deleted_at: string | null;
      is_visible: boolean;
    } | null;
  }>;
  const variantIds = [
    ...new Set(rows.map((row) => row.variant_id).filter((id): id is string => Boolean(id))),
  ];
  const { data: variantRows, error: variantError } = variantIds.length
    ? await admin
        .from("product_variants")
        .select("id, product_id, sku, status")
        .in("id", variantIds)
    : { data: [], error: null };
  if (variantError) throw new Error("CART_VARIANTS_LOOKUP_FAILED");
  const variants = new Map(
    (
      (variantRows ?? []) as Array<{ id: string; product_id: string; sku: string; status: string }>
    ).map((variant) => [variant.id, variant]),
  );

  const quantities = new Map<string, number>();
  for (const row of rows) {
    const product = row.products;
    const variant = row.variant_id ? variants.get(row.variant_id) : null;
    if (
      !product ||
      product.status !== "ACTIVE" ||
      product.deleted_at ||
      product.is_visible === false
    ) {
      throw new Error("PRODUCT_UNAVAILABLE");
    }
    if (
      row.variant_id &&
      (!variant || variant.product_id !== row.product_id || variant.status !== "ACTIVE")
    ) {
      throw new Error("PRODUCT_UNAVAILABLE");
    }
    const sku = variant?.sku ?? product.sku;
    if (!sku || !Number.isInteger(row.quantity) || row.quantity <= 0) {
      throw new Error("INVALID_CART_ITEM");
    }
    quantities.set(sku, (quantities.get(sku) ?? 0) + row.quantity);
  }

  const items = [...quantities.entries()].map(([sku, quantity]) => ({ sku, quantity }));
  if (!items.length) throw new Error("CART_EMPTY");
  return items;
}

async function resolveCartItem(admin: Admin, sku: string, quantity: number) {
  const resolved = await resolveLines(admin, [{ sku, quantity }]);
  if (!resolved.ok) throw new Error(resolved.code);
  const line = resolved.lines[0];
  if (!line) throw new Error("PRODUCT_UNAVAILABLE");
  return line;
}

export async function getCart(admin: Admin, customerId: string | null, guestToken: string | null) {
  if (!customerId && !validGuestToken(guestToken)) throw new Error("GUEST_CART_TOKEN_REQUIRED");
  return cartView(admin, await cartFor(admin, customerId, guestToken));
}

export async function addCartItem(
  admin: Admin,
  customerId: string | null,
  guestToken: string | null,
  input: { sku: string; quantity: number },
) {
  if (!Number.isInteger(input.quantity) || input.quantity <= 0) throw new Error("INVALID_QUANTITY");
  const cart = await cartFor(admin, customerId, guestToken);
  assertMutableCart(cart);
  const line = await resolveCartItem(admin, input.sku, input.quantity);
  const { data: existing } = await admin
    .from("cart_items")
    .select("id, quantity")
    .eq("cart_id", cart.id)
    .eq("product_id", line.productId)
    .eq("variant_id", line.variantId)
    .maybeSingle();
  const quantity = Number(existing?.quantity ?? 0) + input.quantity;
  await resolveCartItem(admin, input.sku, quantity);
  const result = existing
    ? await admin.from("cart_items").update({ quantity }).eq("id", existing.id)
    : await admin.from("cart_items").insert({
        cart_id: cart.id,
        product_id: line.productId,
        variant_id: line.variantId,
        quantity,
      });
  if (result.error) throw new Error("CART_ITEM_WRITE_FAILED");
  await auditCommerceMutation(admin, {
    action: "CART_ITEM_ADDED",
    entityType: "cart",
    entityId: cart.id,
    metadata: { sku: input.sku, quantity },
  });
  return cartView(admin, cart);
}

export async function updateCartItem(
  admin: Admin,
  cartItemId: string,
  quantity: number,
  owner: { customerId: string | null; guestToken: string | null },
) {
  if (!Number.isInteger(quantity) || quantity <= 0) throw new Error("INVALID_QUANTITY");
  const cart = await cartFor(admin, owner.customerId, owner.guestToken);
  assertMutableCart(cart);
  const { data: item, error } = await admin
    .from("cart_items")
    .select("id, product_id, variant_id")
    .eq("id", cartItemId)
    .eq("cart_id", cart.id)
    .maybeSingle();
  if (error || !item) throw new Error("CART_ITEM_NOT_FOUND");
  const skuQuery = item.variant_id
    ? admin.from("product_variants").select("sku").eq("id", item.variant_id).maybeSingle()
    : admin.from("products").select("sku").eq("id", item.product_id).maybeSingle();
  const { data: product } = await skuQuery;
  if (!product?.sku) throw new Error("PRODUCT_UNAVAILABLE");
  await resolveCartItem(admin, product.sku, quantity);
  const result = await admin.from("cart_items").update({ quantity }).eq("id", item.id);
  if (result.error) throw new Error("CART_ITEM_WRITE_FAILED");
  return cartView(admin, cart);
}

export async function removeCartItem(
  admin: Admin,
  cartItemId: string,
  owner: { customerId: string | null; guestToken: string | null },
) {
  const cart = await cartFor(admin, owner.customerId, owner.guestToken);
  assertMutableCart(cart);
  const { error } = await admin
    .from("cart_items")
    .delete()
    .eq("id", cartItemId)
    .eq("cart_id", cart.id);
  if (error) throw new Error("CART_ITEM_DELETE_FAILED");
  return cartView(admin, cart);
}

export async function clearCart(
  admin: Admin,
  owner: { customerId: string | null; guestToken: string | null },
) {
  const cart = await cartFor(admin, owner.customerId, owner.guestToken);
  assertMutableCart(cart);
  const { error } = await admin.from("cart_items").delete().eq("cart_id", cart.id);
  if (error) throw new Error("CART_CLEAR_FAILED");
  return cartView(admin, cart);
}

export async function mergeGuestCart(admin: Admin, customerId: string, guestToken: string) {
  if (!validGuestToken(guestToken)) throw new Error("GUEST_CART_TOKEN_REQUIRED");
  const guest = await cartFor(admin, null, guestToken);
  const customer = await cartFor(admin, customerId, null);
  assertMutableCart(guest);
  assertMutableCart(customer);
  const { data: items, error } = await admin.from("cart_items").select("*").eq("cart_id", guest.id);
  if (error) throw new Error("CART_MERGE_LOOKUP_FAILED");
  for (const item of items ?? []) {
    const { data: existing } = await admin
      .from("cart_items")
      .select("id, quantity")
      .eq("cart_id", customer.id)
      .eq("product_id", item.product_id)
      .eq("variant_id", item.variant_id)
      .maybeSingle();
    if (existing) {
      const quantity = Number(existing.quantity) + Number(item.quantity);
      const skuRow = item.variant_id
        ? await admin.from("product_variants").select("sku").eq("id", item.variant_id).maybeSingle()
        : await admin.from("products").select("sku").eq("id", item.product_id).maybeSingle();
      if (skuRow.data?.sku) {
        try {
          await resolveCartItem(admin, skuRow.data.sku, quantity);
        } catch {
          continue;
        }
      }
      await admin.from("cart_items").update({ quantity }).eq("id", existing.id);
    } else {
      await admin.from("cart_items").insert({
        cart_id: customer.id,
        product_id: item.product_id,
        variant_id: item.variant_id,
        quantity: item.quantity,
      });
    }
  }
  const { error: guestItemsDeleteError } = await admin
    .from("cart_items")
    .delete()
    .eq("cart_id", guest.id);
  if (guestItemsDeleteError) throw new Error("CART_MERGE_DELETE_FAILED");
  const { error: guestStatusError } = await admin
    .from("carts")
    .update({ status: "MERGED", checkout_claim_id: null })
    .eq("id", guest.id);
  if (guestStatusError) throw new Error("CART_MERGE_FAILED");
  return cartView(admin, customer);
}

export async function getProfile(admin: Admin, customerId: string) {
  const { data, error } = await admin
    .from("profiles")
    .select("id, email, full_name, phone, marketing_opt_in, created_at, updated_at")
    .eq("id", customerId)
    .maybeSingle();
  if (error) throw new Error("PROFILE_LOOKUP_FAILED");
  return data;
}

export async function updateProfile(
  admin: Admin,
  customerId: string,
  input: { full_name?: string; phone?: string; marketing_opt_in?: boolean },
) {
  const patch = {
    ...(input.full_name !== undefined ? { full_name: input.full_name.trim().slice(0, 120) } : {}),
    ...(input.phone !== undefined ? { phone: input.phone.trim().slice(0, 30) } : {}),
    ...(input.marketing_opt_in !== undefined ? { marketing_opt_in: input.marketing_opt_in } : {}),
  };
  const { data, error } = await admin
    .from("profiles")
    .update(patch)
    .eq("id", customerId)
    .select("id, email, full_name, phone, marketing_opt_in, created_at, updated_at")
    .single();
  if (error) throw new Error("PROFILE_UPDATE_FAILED");
  await auditCommerceMutation(admin, {
    action: "CUSTOMER_PROFILE_UPDATED",
    entityType: "profile",
    entityId: customerId,
  });
  return data;
}

const addressFields =
  "id, user_id, address_type, label, full_name, phone, line1, line2, landmark, city, state, postal_code, country, is_default, created_at, updated_at";
export async function listAddresses(admin: Admin, customerId: string) {
  const { data, error } = await admin
    .from("addresses")
    .select(addressFields)
    .eq("user_id", customerId)
    .is("deleted_at", null)
    .order("is_default", { ascending: false })
    .order("created_at");
  if (error) throw new Error("ADDRESS_LOOKUP_FAILED");
  return data ?? [];
}
export async function createAddress(
  admin: Admin,
  customerId: string,
  input: Record<string, unknown>,
) {
  const type = input["address_type"] === "billing" ? "billing" : "shipping";
  const isDefault = input["is_default"] === true;
  if (isDefault)
    await admin
      .from("addresses")
      .update({ is_default: false })
      .eq("user_id", customerId)
      .eq("address_type", type);
  const { data, error } = await admin
    .from("addresses")
    .insert({ ...input, user_id: customerId, address_type: type, is_default: isDefault })
    .select(addressFields)
    .single();
  if (error) throw new Error("ADDRESS_CREATE_FAILED");
  await auditCommerceMutation(admin, {
    action: "ADDRESS_CREATED",
    entityType: "address",
    entityId: data.id,
  });
  return data;
}
export async function updateAddress(
  admin: Admin,
  customerId: string,
  addressId: string,
  input: Record<string, unknown>,
) {
  const { data: existing } = await admin
    .from("addresses")
    .select("id, address_type")
    .eq("id", addressId)
    .eq("user_id", customerId)
    .is("deleted_at", null)
    .maybeSingle();
  if (!existing) throw new Error("ADDRESS_NOT_FOUND");
  const allowed = [
    "address_type",
    "label",
    "full_name",
    "phone",
    "line1",
    "line2",
    "landmark",
    "city",
    "state",
    "postal_code",
    "country",
    "is_default",
  ];
  const patch = Object.fromEntries(Object.entries(input).filter(([key]) => allowed.includes(key)));
  if (
    patch["address_type"] !== undefined &&
    patch["address_type"] !== "shipping" &&
    patch["address_type"] !== "billing"
  )
    throw new Error("INVALID_ADDRESS");
  if (patch["is_default"] === true)
    await admin
      .from("addresses")
      .update({ is_default: false })
      .eq("user_id", customerId)
      .eq("address_type", patch["address_type"] ?? existing.address_type);
  const { data, error } = await admin
    .from("addresses")
    .update(patch)
    .eq("id", addressId)
    .eq("user_id", customerId)
    .select(addressFields)
    .single();
  if (error) throw new Error("ADDRESS_UPDATE_FAILED");
  await auditCommerceMutation(admin, {
    action: "ADDRESS_UPDATED",
    entityType: "address",
    entityId: addressId,
  });
  return data;
}
export async function deleteAddress(admin: Admin, customerId: string, addressId: string) {
  const { error } = await admin
    .from("addresses")
    .update({ deleted_at: new Date().toISOString(), is_default: false })
    .eq("id", addressId)
    .eq("user_id", customerId);
  if (error) throw new Error("ADDRESS_DELETE_FAILED");
  await auditCommerceMutation(admin, {
    action: "ADDRESS_DELETED",
    entityType: "address",
    entityId: addressId,
  });
  return { ok: true };
}
export async function wishlist(
  admin: Admin,
  customerId: string,
  action: "get" | "add" | "remove",
  productId?: string,
  variantId?: string | null,
) {
  const { data: list, error } = await admin
    .from("wishlists")
    .upsert({ user_id: customerId }, { onConflict: "user_id" })
    .select("id, user_id")
    .single();
  if (error || !list) throw new Error("WISHLIST_LOOKUP_FAILED");
  if (action === "add" && productId) {
    const { data: product } = await admin
      .from("products")
      .select("id, status, deleted_at")
      .eq("id", productId)
      .maybeSingle();
    if (!product || product.status !== "ACTIVE" || product.deleted_at)
      throw new Error("PRODUCT_UNAVAILABLE");
    if (variantId) {
      const { data: variant } = await admin
        .from("product_variants")
        .select("id, product_id, status, deleted_at")
        .eq("id", variantId)
        .eq("product_id", productId)
        .maybeSingle();
      if (!variant || variant.status !== "ACTIVE" || variant.deleted_at)
        throw new Error("VARIANT_UNAVAILABLE");
    }
    const result = await admin
      .from("wishlist_items")
      .upsert(
        { wishlist_id: list.id, product_id: productId, variant_id: variantId ?? null },
        { onConflict: "wishlist_id,product_id,variant_key" },
      );
    if (result.error) throw new Error("WISHLIST_WRITE_FAILED");
    await auditCommerceMutation(admin, {
      action: "WISHLIST_ITEM_ADDED",
      entityType: "wishlist",
      entityId: list.id,
      metadata: { product_id: productId, variant_id: variantId ?? null },
    });
  } else if (action === "remove" && productId) {
    const result = await admin
      .from("wishlist_items")
      .delete()
      .eq("wishlist_id", list.id)
      .eq("product_id", productId);
    if (variantId) result.eq("variant_id", variantId);
    else result.is("variant_id", null);
    if (result.error) throw new Error("WISHLIST_DELETE_FAILED");
    await auditCommerceMutation(admin, {
      action: "WISHLIST_ITEM_REMOVED",
      entityType: "wishlist",
      entityId: list.id,
      metadata: { product_id: productId, variant_id: variantId ?? null },
    });
  }
  const { data: items } = await admin
    .from("wishlist_items")
    .select("id, product_id, variant_id, created_at, products(id, title, slug, status, deleted_at)")
    .eq("wishlist_id", list.id)
    .order("created_at");
  return { wishlist: list, items: items ?? [] };
}

export async function reviews(
  admin: Admin,
  action: "list" | "summary" | "create",
  input: { productId: string; customerId?: string; rating?: number; title?: string; body?: string },
) {
  if (action === "create") {
    const rating = input.rating;
    const body = input.body;
    if (
      !input.customerId ||
      rating === undefined ||
      !Number.isInteger(rating) ||
      rating < 1 ||
      rating > 5
    )
      throw new Error("INVALID_REVIEW");
    if (body === undefined || body.trim().length < 10 || body.length > 5000)
      throw new Error("INVALID_REVIEW_CONTENT");
    const { data: purchased } = await admin
      .from("orders")
      .select("id, order_items!inner(product_id, variant_id)")
      .eq("user_id", input.customerId)
      .eq("payment_status", "PAID")
      .eq("order_items.product_id", input.productId)
      .limit(1)
      .maybeSingle();
    const { data, error } = await admin
      .from("reviews")
      .insert({
        product_id: input.productId,
        user_id: input.customerId,
        rating,
        title: input.title?.slice(0, 200) ?? null,
        body: body.trim(),
        status: "PENDING",
        verified_purchase: verifiedPurchaseStatus(Boolean(purchased)),
        verified_order_id: purchased?.id ?? null,
      })
      .select("*")
      .single();
    if (error) throw new Error("REVIEW_CREATE_FAILED");
    await auditCommerceMutation(admin, {
      action: "REVIEW_CREATED",
      entityType: "review",
      entityId: data.id,
      metadata: {
        product_id: input.productId,
        verified_purchase: verifiedPurchaseStatus(Boolean(purchased)),
      },
    });
    return data;
  }
  if (action === "summary") {
    const { data, error } = await admin
      .from("reviews")
      .select("rating")
      .eq("product_id", input.productId)
      .eq("status", "APPROVED");
    if (error) throw new Error("REVIEW_LOOKUP_FAILED");
    const ratings = (data ?? []).map((row: { rating: number }) => row.rating);
    return {
      count: ratings.length,
      average: ratings.length
        ? ratings.reduce((sum: number, rating: number) => sum + rating, 0) / ratings.length
        : 0,
    };
  }
  const { data, error } = await admin
    .from("reviews")
    .select("id, product_id, rating, title, body, verified_purchase, created_at")
    .eq("product_id", input.productId)
    .eq("status", "APPROVED")
    .order("created_at", { ascending: false });
  if (error) throw new Error("REVIEW_LOOKUP_FAILED");
  return data ?? [];
}

export async function newsletter(
  admin: Admin,
  action: "subscribe" | "unsubscribe" | "status",
  email: string,
) {
  const normalized = normalizeEmail(email);
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalized)) throw new Error("INVALID_EMAIL");
  if (action === "subscribe") {
    const { data, error } = await admin
      .from("newsletter_subscribers")
      .upsert(
        {
          email: normalized,
          status: "SUBSCRIBED",
          subscribed_at: new Date().toISOString(),
          unsubscribed_at: null,
        },
        { onConflict: "email" },
      )
      .select("email, status, subscribed_at, unsubscribed_at")
      .single();
    if (error) throw new Error("NEWSLETTER_WRITE_FAILED");
    return data;
  }
  if (action === "unsubscribe") {
    const { data, error } = await admin
      .from("newsletter_subscribers")
      .update({ status: "UNSUBSCRIBED", unsubscribed_at: new Date().toISOString() })
      .eq("email", normalized)
      .select("email, status, subscribed_at, unsubscribed_at")
      .maybeSingle();
    if (error) throw new Error("NEWSLETTER_WRITE_FAILED");
    return data ?? { email: normalized, status: "UNSUBSCRIBED" };
  }
  const { data } = await admin
    .from("newsletter_subscribers")
    .select("email, status, subscribed_at, unsubscribed_at")
    .eq("email", normalized)
    .maybeSingle();
  return data ?? { email: normalized, status: "NOT_SUBSCRIBED" };
}
