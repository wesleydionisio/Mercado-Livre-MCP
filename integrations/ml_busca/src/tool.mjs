import { ParseResult, Schema } from "effect";
import {
  defineOperation,
  listInputFields,
  listOutputFields,
  readList,
  sameText,
  startList,
  waitCode,
} from "../../runtime/index.js";

const Product = Schema.Struct({
  item_id: Schema.String.pipe(Schema.pattern(/^[A-Z]{3}\d+$/u)).annotations({
    description:
      "The listing's item ID as Mercado Livre shows it, such as MLB1234567890; for a catalog product card that names no single listing (several sellers), the catalog product ID, such as MLB79456482",
  }),
  title: Schema.NonEmptyTrimmedString.annotations({ description: "The product title as the result card shows it" }),
  price: Schema.Number.pipe(Schema.nonNegative()).annotations({
    description: "Current price in BRL (reais) as a number, such as 122.5 for R$ 122,50",
  }),
  previous_price: Schema.NullOr(Schema.Number.pipe(Schema.nonNegative())).annotations({
    description: "The previous (crossed-out) price in BRL as a number; null when the card shows none",
  }),
  discount_percent: Schema.NullOr(Schema.Int.pipe(Schema.between(0, 100))).annotations({
    description: "The discount the card shows, in percent (18 for \"18% OFF\"); null when it shows none",
  }),
  currency: Schema.Literal("BRL").annotations({ description: "ISO 4217 currency of the prices, always BRL on this site" }),
  free_shipping: Schema.Boolean.annotations({
    description: "True when the card's shipping line offers free shipping (grátis), such as \"Chegará grátis amanhã\"",
  }),
  shipping_label: Schema.NullOr(Schema.NonEmptyTrimmedString).annotations({
    description: "The card's shipping line as shown, such as \"Chegará grátis hoje\"; null when the card shows none",
  }),
  sponsored: Schema.Boolean.annotations({ description: "True when the card is an ad (Patrocinado)" }),
  url: Schema.String.pipe(Schema.pattern(/^https:\/\/[^?#\s]+$/u)).annotations({
    description:
      "The product page URL without tracking parameters. For sponsored cards, whose only link is an ad click-tracking redirect, this is the site's item link https://produto.mercadolivre.com.br/MLB-<id>, which opens the same product page",
  }),
  image_url: Schema.String.pipe(Schema.pattern(/^https:\/\/\S+$/u)).annotations({
    description: "URL of the card's main product image",
  }),
  rating: Schema.NullOr(Schema.Number.pipe(Schema.between(0, 5))).annotations({
    description: "Average customer rating out of 5 as the card shows it; null when the card shows none",
  }),
  seller: Schema.NullOr(Schema.NonEmptyTrimmedString).annotations({
    description: "The seller or official store line the card shows, such as \"JBL\"; null when the card shows none",
  }),
});

const SitePage = Schema.Struct({
  href: Schema.String,
  query: Schema.String,
  rows: Schema.Array(Product),
  more: Schema.Boolean,
  next: Schema.NullOr(Schema.String),
  totalResults: Schema.NullOr(Schema.Number),
});

const Failure = Schema.Struct({ failure: Schema.String });

// Page code, after waitCode with `site`, `onSite`, `itemOrigin` and `action` declared: waits for
// the results page's answer, then reads the first `count` results from the page's own search state,
// checking each against its rendered card's title, and reads the card's image, seller and shipping
// line from the card itself.
const readPageCode = (count) => `
const searchState = () => {
  const s = window._n?.ctx?.r?.appProps?.pageProps?.initialState;
  return s && Array.isArray(s.results) ? s : null;
};
const stateReady = async (wantRows) => {
  return await page.evaluate((want) => {
    const s = window._n?.ctx?.r?.appProps?.pageProps?.initialState;
    if (!s || !Array.isArray(s.results)) return false;
    const cards = document.querySelectorAll("li.ui-search-layout__item").length;
    return want ? s.results.length > 0 && cards > 0 : s.results.length === 0;
  }, wantRows).catch(() => false);
};
const shown = await waitForOutcome({
  empty: { check: () => stateReady(false) },
  results: { check: () => stateReady(true) },
}, { ...site, ...(action === undefined ? {} : { action }) });
if (!onSite(new URL(page.url()))) return { failure: "off-site page: " + new URL(page.url()).origin };
return await page.evaluate(({ count, itemOrigin, shown }) => {
  const s = window._n.ctx.r.appProps.pageProps.initialState;
  const clean = (t) => (t ?? "").replace(/\\s+/gu, " ").trim();
  const totalText = clean(s.sidebar?.components?.find((c) => c.type === "TOTAL_RESULTS")?.text);
  const exact = /^(\\d{1,3}(?:\\.\\d{3})*|\\d+) resultados?$/u.exec(totalText);
  const totalResults = exact ? Number(exact[1].replace(/\\./gu, "")) : null;
  const nextPage = s.pagination?.next_page;
  const next = nextPage?.show === true && typeof nextPage.url === "string" ? nextPage.url : null;
  // The query the results page answers: its search state, else its own search box, else (on
  // category landings such as vehicles, which echo no query) its heading.
  const box = document.querySelector('input[name="as_word"]');
  const heading = document.querySelector("main h1, h1.ui-search-breadcrumb__title");
  const query = clean(typeof s.query === "string" ? s.query : "") || clean(box?.value) || clean(heading?.textContent);
  const base = { href: location.href, query, next, totalResults };
  if (shown === "empty") return { ...base, rows: [], more: false };
  // Rendered result cards of the main grid, one per POLYCARD entry of the search state, in order;
  // other entries (carousels with their own heading) render no result card and are not results.
  const cards = [...document.querySelectorAll("li.ui-search-layout__item")];
  const visible = (el) => el !== null && el.checkVisibility();
  const rows = [];
  const all = s.results.filter((r) => r?.id === "POLYCARD" && r.polycard);
  if (all.length !== cards.length) return { failure: "the page shows " + cards.length + " result cards but its search data lists " + all.length };
  for (let i = 0; i < all.length && rows.length < count; i++) {
    const card = all[i].polycard;
    const meta = card.metadata ?? {};
    const comps = card.components ?? [];
    const comp = (type) => comps.find((c) => c.type === type)?.[type];
    const title = clean(comp("title")?.text);
    const li = cards[i];
    const domTitle = clean(li?.querySelector("h3 a, a.poly-component__title")?.textContent);
    if (!title || domTitle !== title) return { failure: "card " + (i + 1) + " does not match the page's search data" };
    const price = comp("price");
    const current = price?.current_price;
    if (typeof current?.value !== "number") return { failure: "no price for " + meta.id };
    if (current.currency !== "BRL") return { failure: "price not in BRL for " + meta.id + ": " + current.currency };
    const prev = (price.price_labels ?? []).flatMap((l) => l.values ?? []).find((v) => v.type === "price" && v.price?.previous === true)?.price;
    let discount = typeof price.discount_pct === "number" ? price.discount_pct : null;
    const pill = clean((price.discount_polylabel?.values ?? []).map((v) => v.pill?.text ?? v.label?.text ?? "").join(" "));
    const pillPct = /(\\d+)% OFF/u.exec(pill);
    if (discount === null && pillPct) discount = Number(pillPct[1]);
    const sponsored = Boolean(card.ads_promotions) || meta.is_pad === "true";
    let url;
    if (sponsored || !meta.url || /^click\\d*\\./u.test(meta.url)) {
      const digits = /^MLB(\\d+)$/u.exec(meta.id ?? "");
      if (!digits) return { failure: "no item id for sponsored card " + (i + 1) };
      url = itemOrigin + "/MLB-" + digits[1];
    } else {
      const u = new URL("https://" + meta.url.replace(/^https?:\\/\\//u, ""));
      url = u.origin + u.pathname;
    }
    const img = li.querySelector("img.poly-component__picture");
    const image = img?.getAttribute("src") ?? "";
    if (!/^https:\\/\\//u.test(image)) return { failure: "no image for " + meta.id };
    // The card's shipping line, rendered from its own template: each {key} replaced by that
    // value's text, icons left out.
    const render = (t) => {
      if (Array.isArray(t)) return t.map(render).join(" ");
      if (!t || typeof t.text !== "string") return "";
      return t.text.replace(/\\{([^}]+)\\}/gu, (_, key) => {
        const v = (t.values ?? []).find((x) => x.key === key);
        const inner = v && v[v.type];
        return inner && typeof inner.text === "string" ? inner.text : "";
      });
    };
    const shipping = clean(comps.filter((c) => /^shipping/u.test(c.type)).map((c) => render(c[c.type])).join(" ")) || null;
    const sellerEl = li.querySelector(".poly-component__seller");
    const seller = visible(sellerEl) ? clean(sellerEl.innerText) || null : null;
    const ratingText = (comp("review_compacted")?.values ?? []).find((v) => v.type === "label")?.label?.text;
    const rating = ratingText && /^\\d+(?:[.,]\\d+)?$/u.test(ratingText.trim()) ? Number(ratingText.trim().replace(",", ".")) : null;
    rows.push({
      item_id: meta.id || meta.product_id,
      title,
      price: current.value,
      previous_price: typeof prev?.value === "number" ? prev.value : null,
      discount_percent: discount,
      currency: "BRL",
      free_shipping: shipping !== null && /gr[aá]tis/iu.test(shipping),
      shipping_label: shipping,
      sponsored,
      url,
      image_url: image,
      rating,
      seller,
    });
  }
  return { ...base, rows, more: all.length > rows.length };
}, { count: ${count}, itemOrigin, shown });
`;

export default defineOperation(
  {
    name: "search_mercado_livre_products",
    input: Schema.Struct({
      query: Schema.NonEmptyString.pipe(Schema.pattern(/\S/u), Schema.maxLength(120)).annotations({
        description: "One search term, as you would type it into Mercado Livre's search box",
        examples: ["fone bluetooth"],
      }),
      ...listInputFields,
    }),
    output: Schema.Struct({
      applied_query: Schema.NonEmptyTrimmedString.annotations({
        description: "The search term the results page says it searched",
      }),
      query_corrected: Schema.Boolean.annotations({
        description: "True when the site searched a different term than the one sent, such as a corrected spelling",
      }),
      results: Schema.Array(Product).annotations({
        description: "Products in the site's order, sponsored ones in place",
      }),
      ...listOutputFields,
    }),
  },
  async ({ kernel, sessionId, siteOrigin, siteDomain, input, remainingMs, errors }) => {
    const list = startList(input, { mechanism: "pages" });
    if (siteOrigin === undefined)
      throw new errors.OperationFailure("No site origin for a live run", { dispatch: "not_sent" });
    const query = input.query.trim();
    const itemOrigin = `https://produto.${siteDomain ?? new URL(siteOrigin).hostname.replace(/^www\./u, "")}`;
    let appliedQuery = null;

    const run = async (steps, action, count) => {
      const timeoutSec = Math.min(90, Math.floor(remainingMs() / 1_000) - 1);
      if (timeoutSec < 1) throw new errors.OperationFailure("No time left to read the results");
      const answer = await kernel.browsers.playwright.execute(sessionId, {
        timeout_sec: timeoutSec,
        code: `
${waitCode}
const siteDomain = ${JSON.stringify(siteDomain ?? null)};
const siteOrigin = ${JSON.stringify(siteOrigin)};
const onSite = (u) => siteDomain === null ? u.origin === siteOrigin
  : u.protocol === "https:" && (u.hostname === siteDomain || u.hostname.endsWith("." + siteDomain));
const site = siteDomain === null ? {} : { siteDomain };
const itemOrigin = ${JSON.stringify(itemOrigin)};
${steps}
const action = ${action};
${readPageCode(count)}`,
      });
      if (!answer.success)
        throw new errors.OperationFailure(String(answer.error), { stderr: answer.stderr });
      const failed = Schema.decodeUnknownEither(Failure)(answer.result);
      if (failed._tag === "Right") throw new errors.OperationFailure(failed.right.failure);
      const decoded = Schema.decodeUnknownEither(SitePage)(answer.result);
      if (decoded._tag === "Left")
        throw new errors.OperationFailure(
          `A results page did not read as expected: ${JSON.stringify(ParseResult.ArrayFormatter.formatErrorSync(decoded.left).slice(0, 3)).slice(0, 1500)}`,
        );
      const sitePage = decoded.right;
      return { ...sitePage, hasNext: sitePage.next !== null };
    };

    const navigate = (url) => `
await page.goto(${JSON.stringify(url)}, { waitUntil: "domcontentloaded", timeout: waitLimits.navigation });
if (!onSite(new URL(page.url()))) return { failure: "off-site page: " + new URL(page.url()).origin };`;

    // The site's own search: its home page's search box, submitted with Enter.
    const search = (count) =>
      run(
        `${navigate(new URL("/", siteOrigin).href)}
const box = page.locator('input[name="as_word"]');
await box.waitFor({ state: "visible", timeout: waitLimits.navigation });
if ((await box.count()) !== 1) return { failure: "search box not found" };
// The cookie notice offers only accept or settings; accept is its one way out.
const acceptCookies = page.getByRole("button", { name: "Aceitar cookies", exact: true });
if ((await acceptCookies.count()) === 1 && (await acceptCookies.isVisible())) await acceptCookies.click({ timeout: waitLimits.action });
await box.fill(${JSON.stringify(query)}, { timeout: waitLimits.action });`,
        `() => box.press("Enter", { timeout: waitLimits.action })`,
        count,
      );
    const open = (href, count) => run(navigate(href), "undefined", count);
    const sameQuery = (sitePage) => sitePage.query !== "" && sameText(sitePage.query, query);
    const note = (sitePage) => {
      if (appliedQuery === null && sitePage.query !== "") appliedQuery = sitePage.query;
      return sitePage;
    };

    const result = await readList(list, {
      keyOf: (row) => row.item_id,
      promoted: (row) => row.sponsored,
      remainingMs,
      readOnMs: 8_000,
      open: async (position, count) => {
        if (position?.href !== undefined) {
          const linked = await open(position.href, count);
          if (sameQuery(linked)) return note(linked);
        }
        const target = position?.page ?? 1;
        let sitePage = await search(target === 1 ? count : 1);
        for (let at = 2; at <= target && sitePage.next !== null; at++)
          sitePage = await open(sitePage.next, at === target ? count : 1);
        return note(sitePage);
      },
      more: (_sitePage, count) => run("", "undefined", count),
      next: async (sitePage, count) => {
        if (sitePage.next === null) throw new errors.OperationFailure("The results page has no Próximo link");
        return note(await open(sitePage.next, count));
      },
    });
    if (appliedQuery === null)
      throw new errors.OperationFailure("The results page does not show the searched term");
    return {
      applied_query: appliedQuery,
      query_corrected: !sameText(appliedQuery, query),
      results: result.rows,
      ...result.output,
    };
  },
);