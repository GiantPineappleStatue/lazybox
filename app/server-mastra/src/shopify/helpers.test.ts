import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { isValidShopDomain, shopifyApiBase, buildReplacementDraftBody } from "./helpers.js";

const OLD_ENV = process.env;

beforeEach(() => {
  process.env = { ...OLD_ENV };
});

afterEach(() => {
  process.env = OLD_ENV;
});

describe("isValidShopDomain", () => {
  it("accepts valid myshopify domains", () => {
    expect(isValidShopDomain("r901.myshopify.com")).toBe(true);
    expect(isValidShopDomain("abc-123.myshopify.com")).toBe(true);
  });
  it("rejects invalid domains", () => {
    expect(isValidShopDomain("shopify.com")).toBe(false);
    expect(isValidShopDomain("-bad.myshopify.com")).toBe(false);
    expect(isValidShopDomain("bad-.myshopify.com")).toBe(false);
    expect(isValidShopDomain("not a domain")).toBe(false);
  });
});

describe("shopifyApiBase", () => {
  it("uses env SHOPIFY_API_VERSION when set", () => {
    process.env.SHOPIFY_API_VERSION = "2024-07";
    expect(shopifyApiBase("r901.myshopify.com")).toBe("https://r901.myshopify.com/admin/api/2024-07");
  });
  it("falls back to provided default when env not set", () => {
    delete process.env.SHOPIFY_API_VERSION;
    expect(shopifyApiBase("r901.myshopify.com", "2024-01")).toBe("https://r901.myshopify.com/admin/api/2024-01");
  });
});

describe("buildReplacementDraftBody", () => {
  it("builds variant and custom line items with 100% discount", () => {
    const order = {
      line_items: [
        { variant_id: 111, title: "Variant", quantity: 2 },
        { title: "Custom", price: "9.99" },
      ],
      shipping_address: { address1: "123 A" },
      billing_address: { address1: "123 B" },
      customer: { id: 42 },
    };
    const body = buildReplacementDraftBody(order as any, "Test note");
    expect(body.draft_order.line_items.length).toBe(2);
    const [v, c] = body.draft_order.line_items as any[];
    expect(v.variant_id).toBe(111);
    expect(v.quantity).toBe(2);
    expect(v.applied_discount.value).toBe("100.0");
    expect(c.title).toBe("Custom");
    expect(c.quantity).toBe(1);
    expect(c.price).toBe("9.99");
    expect(c.applied_discount.value).toBe("100.0");
    expect(body.draft_order.note).toBe("Test note");
  });
});
