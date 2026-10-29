import { Schema } from "effect";
import { defineOperation, waitCode } from "../../runtime/index.js";

const MlbId = Schema.String.pipe(Schema.pattern(/^MLB\d{4,15}$/u));
const Money = Schema.Number.pipe(Schema.nonNegative());
const Text = Schema.NonEmptyTrimmedString;

const Input = Schema.Struct({
  url: Schema.String.pipe(
    Schema.pattern(/^https:\/\/[^\s/]+\/\S*MLB\S*$/u),
    Schema.maxLength(2000),
  ).annotations({
    description:
      "One Mercado Livre Brazil product page URL, one per call: a listing link (produto.mercadolivre.com.br/MLB-…), a catalog link (www.mercadolivre.com.br/…/p/MLB…) or a product link (…/up/MLBU…). Opened unchanged.",
    examples: ["https://www.mercadolivre.com.br/fritadeira-airfryer-xl-philips-walita-hd9206/p/MLB35612949"],
  }),
});

const Output = Schema.Struct({
  item_id: MlbId.annotations({ description: "The listing (item) id of the offer the page shows, such as MLB1234567890" }),
  catalog_product_id: Schema.NullOr(MlbId).annotations({
    description: "The catalog product id (the /p/MLB… page) the offer belongs to, or null when the listing is not part of a catalog product",
  }),
  user_product_id: Schema.NullOr(Schema.String.pipe(Schema.pattern(/^MLBU\d{4,15}$/u))).annotations({
    description: "The site's user-product id (MLBU…) for the offer, or null when the page has none",
  }),
  title: Text.annotations({ description: "The product title as the page's heading shows it" }),
  currency: Schema.Literal("BRL").annotations({ description: "ISO 4217 currency of every amount, as the page states it" }),
  price: Money.annotations({
    description:
      "Current price in BRL as a number. When the page shows a Pix price as its main price and a separate regular price (\"ou R$ X em …\"), this is that regular price; otherwise it is the main price shown",
  }),
  previous_price: Schema.NullOr(Money).annotations({
    description: "The crossed-out previous price in BRL, or null when the page shows none",
  }),
  discount_percent: Schema.NullOr(Schema.Int.pipe(Schema.between(1, 100))).annotations({
    description: "The discount percent the page shows beside the price (\"35% OFF\" is 35), or null when it shows none",
  }),
  pix_price: Schema.NullOr(Money).annotations({
    description: "The price in BRL for paying with Pix when the page labels its main price \"no Pix\", or null when the page shows no Pix price",
  }),
  installments_text: Schema.NullOr(Text).annotations({
    description: "The installments line under the price as the page shows it, such as \"6x R$ 54,98 sem juros\", or null when the page shows none",
  }),
  condition: Schema.Literal("new", "used", "refurbished", "not_specified").annotations({
    description: "The item's condition from the page's data: new, used, refurbished or not_specified",
  }),
  condition_label: Schema.NullOr(Text).annotations({
    description: "The condition as the page's subtitle words it, such as \"Novo\" or \"Usado\", or null when the subtitle shows none",
  }),
  sold_text: Schema.NullOr(Text).annotations({
    description: "The sales count text from the page's subtitle, such as \"+5 mil vendidos\", or null when it shows none",
  }),
  seller_name: Text.annotations({ description: "The seller's name (the official store's name for an official store)" }),
  official_store: Schema.Boolean.annotations({ description: "Whether the seller is an official store (Loja oficial)" }),
  free_shipping: Schema.Boolean.annotations({
    description: "Whether the listing itself ships free, from the page's data; a one-off first-purchase free delivery promotion does not count",
  }),
  stock_text: Text.annotations({
    description: "The stock or availability text the page shows, such as \"Estoque disponível\" or \"Último disponível!\"",
  }),
  available_quantity_text: Schema.NullOr(Text).annotations({
    description: "The available quantity note beside the quantity picker, such as \"(+50 disponíveis)\", or null when the page shows none",
  }),
  rating: Schema.NullOr(Schema.Number.pipe(Schema.between(0, 5))).annotations({
    description: "Average rating out of 5 shown in the header, or null when the product has no reviews",
  }),
  review_count: Schema.NullOr(Schema.Int.pipe(Schema.nonNegative())).annotations({
    description: "Number of reviews (opinions) shown beside the rating, not a sales count, or null when the product has no reviews",
  }),
  image_url: Text.annotations({ description: "URL of the main product image, as the gallery's first image shows it" }),
  canonical_url: Text.annotations({ description: "The page's canonical URL as it declares it" }),
  page_url: Text.annotations({ description: "The URL the product page finally landed on after the site's redirects" }),
});

const Read = Schema.Union(
  Schema.Struct({ refused: Schema.String }),
  Schema.Struct({ failure: Schema.String }),
  Schema.Struct({ product: Output }),
);

// The record the caller's URL names, as the site's own links name it.
const expectedIdentity = (url) => {
  const path = decodeURIComponent(url.pathname);
  const catalog = /\/p\/(MLB\d+)/u.exec(path)?.[1] ?? null;
  const userProduct = /\/up\/(MLBU\d+)/u.exec(path)?.[1] ?? null;
  let item = null;
  if (catalog === null && userProduct === null) {
    const m = /MLB-?(\d+)/u.exec(path);
    if (m) item = `MLB${m[1]}`;
  }
  const filter = /item_id:(MLB\d+)/u.exec(url.searchParams.get("pdp_filters") ?? "")?.[1] ?? null;
  if (filter) item = filter;
  return { catalog, userProduct, item };
};

export default defineOperation(
  {
    name: "read_mercadolivre_product",
    input: Input,
    output: Output,
  },
  async ({ kernel, sessionId, siteOrigin, siteDomain, input, errors }) => {
    if (siteOrigin === undefined)
      throw new errors.OperationFailure("No site origin for a live run", { dispatch: "not_sent" });
    const requested = URL.parse(input.url.trim());
    const onSite = (url) =>
      siteDomain === undefined || siteDomain === null
        ? url.origin === siteOrigin
        : url.protocol === "https:" && (url.hostname === siteDomain || url.hostname.endsWith(`.${siteDomain}`));
    if (requested === null || !onSite(requested))
      throw new errors.InvalidInput("Caller input error: url must be an https Mercado Livre Brazil page", { field: "url" });
    const expected = expectedIdentity(requested);
    if (!expected.catalog && !expected.userProduct && !expected.item)
      throw new errors.InvalidInput("Caller input error: url names no Mercado Livre product (no MLB id in its path)", { field: "url" });

    const answer = await kernel.browsers.playwright.execute(sessionId, {
      timeout_sec: 90,
      code: `
        ${waitCode}
        const siteDomain = ${JSON.stringify(siteDomain ?? null)};
        const onSite = (url) => siteDomain === null ? url.origin === ${JSON.stringify(siteOrigin)}
          : url.protocol === "https:" && (url.hostname === siteDomain || url.hostname.endsWith("." + siteDomain));
        await page.goto(${JSON.stringify(requested.href)}, { waitUntil: "domcontentloaded", timeout: waitLimits.navigation });
        if (!onSite(new URL(page.url()))) return { failure: "off-site page: " + new URL(page.url()).origin };
        const shown = await waitForOutcome({
          missing: page.getByText(/(Parece que )?(esta|essa) página não existe|página que você procura não existe|anúncio não existe/i),
          product: page.locator("h1.ui-pdp-title"),
        }, siteDomain === null ? {} : { siteDomain });
        if (!onSite(new URL(page.url()))) return { failure: "off-site page: " + new URL(page.url()).origin };
        if (shown === "missing") return { refused: "The site shows no product page for this URL" };
        return await page.evaluate(() => {
          const script = [...document.querySelectorAll("script")].map((s) => s.textContent || "").find((s) => s.startsWith("_n.ctx.r="));
          if (!script) return { failure: "the product page holds no embedded page state" };
          let body = script.slice("_n.ctx.r=".length).trim();
          const cut = body.indexOf(";_n.ctx.r.");
          if (cut > 0) body = body.slice(0, cut);
          if (body.endsWith(";")) body = body.slice(0, -1);
          let state;
          try { state = JSON.parse(body).appProps.pageProps.initialState; } catch (e) { return { failure: "embedded page state unreadable: " + String(e) }; }
          const c = state?.components;
          const track = c?.track?.melidata_event?.event_data;
          if (!c || !track) return { failure: "embedded page state lacks its components or track data" };
          const visible = (el) => !!el && !!(el.offsetWidth || el.offsetHeight || el.getClientRects().length);
          const clean = (s) => (typeof s === "string" ? s.replace(/\\s+/g, " ").trim() : "");
          const orNull = (s) => (clean(s) === "" ? null : clean(s));
          // Rendered text with each money amount written as the site formats it (R$ 54,98).
          const moneyText = (el) => {
            const copy = el.cloneNode(true);
            for (const m of copy.querySelectorAll(".andes-money-amount")) {
              const frac = m.querySelector(".andes-money-amount__fraction")?.textContent?.trim() ?? "";
              const cents = m.querySelector(".andes-money-amount__cents")?.textContent?.trim() ?? "";
              const sym = m.querySelector(".andes-money-amount__currency-symbol")?.textContent?.trim() ?? "R$";
              m.replaceWith(document.createTextNode(" " + sym + " " + frac + (cents ? "," + cents : "") + " "));
            }
            return clean(copy.textContent);
          };
          const mlb = (v) => (typeof v === "string" && /^MLB\\d+$/.test(v) ? v : null);
          const mlbu = (v) => (typeof v === "string" && /^MLBU\\d+$/.test(v) ? v : null);

          const h1 = document.querySelector("h1.ui-pdp-title");
          const title = clean(h1?.innerText);
          if (!title) return { failure: "product title heading is empty" };

          const priceComp = c.price;
          const p = priceComp?.price;
          if (!p || typeof p.value !== "number") return { failure: "price component missing from page state" };
          if (p.currency_id !== "BRL") return { failure: "unexpected currency " + String(p.currency_id) };
          const mainMeta = document.querySelector(".ui-pdp-price__second-line meta[itemprop=price]");
          if (!mainMeta || Math.abs(Number(mainMeta.content) - p.value) > 0.005)
            return { failure: "rendered main price " + String(mainMeta?.content) + " differs from page data " + p.value };
          const priceBlock = document.querySelector(".ui-pdp-price");
          const pixLabel = priceComp.price_breakdown?.discount?.label?.text;
          const isPix = typeof pixLabel === "string" && /pix/i.test(pixLabel) && /no Pix/i.test(priceBlock?.innerText ?? "");
          const subtitle = (priceComp.subtitles ?? []).find((s) => s.id === "pricing_price_subtitle") ?? (priceComp.subtitles ?? [])[0];
          const regular = subtitle?.values?.total_price?.value;
          const price = isPix && typeof regular === "number" ? regular : p.value;
          const pixPrice = isPix ? p.value : null;
          const previous = typeof p.original_value === "number" ? p.original_value : null;
          const discount = typeof priceComp.discount_label?.value === "number" ? Math.round(priceComp.discount_label.value) : null;
          const instEl = document.querySelector("#pricing_price_subtitle");
          const installments = instEl && visible(instEl) ? orNull(moneyText(instEl)) : null;

          const header = c.header ?? {};
          const subtitleText = clean(header.subtitle_label?.text ?? header.subtitle ?? "");
          const subParts = subtitleText ? subtitleText.split("|").map((s) => s.trim()).filter(Boolean) : [];
          const condLabel = subParts.find((s) => /^(novo|usado|recondicionado)/i.test(s)) ?? null;
          const soldText = subParts.find((s) => /vendid/i.test(s)) ?? null;
          const condMap = { new: "new", used: "used", refurbished: "refurbished", reconditioned: "refurbished" };
          const condition = condMap[track.item_condition] ?? (condLabel && /^usado/i.test(condLabel) ? "used" : condLabel && /^novo/i.test(condLabel) ? "new" : condLabel && /^recond/i.test(condLabel) ? "refurbished" : "not_specified");

          const sellerName = clean(track.seller_name ?? c.seller_data?.viewport_track?.melidata_event?.event_data?.shop_name ?? "");
          if (!sellerName) return { failure: "seller name missing from page data" };
          const official = track.official_store_id !== undefined && track.official_store_id !== null
            ? true
            : c.seller_data?.viewport_track?.melidata_event?.event_data?.seller_type === "official_store";
          if (typeof track.free_shipping !== "boolean") return { failure: "free shipping flag missing from page data" };

          const stockEl = document.querySelector(".ui-pdp-stock-information");
          const statusEls = [...document.querySelectorAll(".ui-pdp-container--column-right .ui-pdp-message, .ui-pdp-container--column-right .andes-message__text, .ui-pdp-stock-information__title")];
          let stockText = stockEl && visible(stockEl) ? clean(stockEl.innerText) : "";
          if (!stockText) stockText = clean(c.stock_information?.state === "VISIBLE" ? c.stock_information?.title?.text : "");
          if (!stockText) stockText = clean(c.item_status_short_description_message?.state === "VISIBLE" ? (c.item_status_short_description_message?.text ?? c.item_status_short_description_message?.title?.text) : "");
          if (!stockText) stockText = clean(c.no_stock_status?.state === "VISIBLE" ? (c.no_stock_status?.title?.text ?? c.no_stock_status?.text) : "");
          if (!stockText) stockText = clean(statusEls.find(visible)?.innerText ?? "");
          if (!stockText) return { failure: "no stock or availability text found on the page" };
          const aq = c.available_quantity?.state === "VISIBLE" ? orNull(c.available_quantity?.picker?.description) : null;

          const reviews = header.reviews;
          const rating = typeof reviews?.rating === "number" && reviews.rating > 0 ? reviews.rating : null;
          const reviewCount = rating !== null && Number.isInteger(reviews?.amount) ? reviews.amount : null;

          const img = document.querySelector(".ui-pdp-gallery__figure img.ui-pdp-image") ?? document.querySelector(".ui-pdp-gallery img.ui-pdp-image");
          const imageUrl = img?.getAttribute("src") && !img.getAttribute("src").startsWith("data:") ? new URL(img.getAttribute("src"), location.href).href : (img?.getAttribute("data-zoom") ?? "");
          if (!imageUrl) return { failure: "main product image missing" };
          const canonical = document.querySelector("link[rel=canonical]")?.href ?? "";
          if (!canonical) return { failure: "canonical link missing" };

          const itemId = mlb(track.item_id);
          if (!itemId) return { failure: "item id missing from page data" };
          return {
            product: {
              item_id: itemId,
              catalog_product_id: mlb(track.catalog_product_id),
              user_product_id: mlbu(track.user_product_id),
              title,
              currency: "BRL",
              price,
              previous_price: previous,
              discount_percent: discount,
              pix_price: pixPrice,
              installments_text: installments,
              condition,
              condition_label: condLabel,
              sold_text: soldText,
              seller_name: sellerName,
              official_store: official,
              free_shipping: track.free_shipping,
              stock_text: stockText,
              available_quantity_text: aq,
              rating,
              review_count: reviewCount,
              image_url: imageUrl,
              canonical_url: canonical,
              page_url: location.href,
            },
          };
        });
      `,
    });
    if (!answer.success) throw new errors.OperationFailure(String(answer.error), { stderr: answer.stderr });
    const result = Schema.decodeUnknownSync(Read)(answer.result);
    if ("refused" in result) throw new errors.InvalidInput(`Caller input error: ${result.refused}`, { field: "url" });
    if ("failure" in result) throw new errors.OperationFailure(result.failure);
    const product = result.product;
    // The page must show the record the caller's URL names.
    if (expected.catalog && product.catalog_product_id !== expected.catalog)
      throw new errors.OperationFailure(`identity mismatch: page shows catalog product ${product.catalog_product_id}, URL names ${expected.catalog}`);
    if (expected.userProduct && product.user_product_id !== expected.userProduct)
      throw new errors.OperationFailure(`identity mismatch: page shows user product ${product.user_product_id}, URL names ${expected.userProduct}`);
    if (expected.item && product.item_id !== expected.item)
      throw new errors.OperationFailure(`identity mismatch: page shows item ${product.item_id}, URL names ${expected.item}`);
    return product;
  },
);