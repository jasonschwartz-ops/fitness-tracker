import express from "express";
import { initializeApp } from "firebase-admin/app";
import { getAuth } from "firebase-admin/auth";
import { getFirestore, FieldValue } from "firebase-admin/firestore";

initializeApp();
const auth = getAuth();
const db = getFirestore();

const app = express();
app.use(express.json({ limit: "5mb" })); // batch import needs headroom

// ---- CORS ----
const ALLOWED_ORIGINS = [
  "https://jasonschwartz-ops.github.io",
  "http://localhost:8000",
];
app.use((req, res, next) => {
  const origin = req.headers.origin;
  if (ALLOWED_ORIGINS.includes(origin)) {
    res.set("Access-Control-Allow-Origin", origin);
    res.set("Access-Control-Allow-Headers", "Authorization, Content-Type");
    res.set("Access-Control-Allow-Methods", "GET, POST, PUT, DELETE, OPTIONS");
  }
  if (req.method === "OPTIONS") return res.status(204).send("");
  next();
});

// ---- Health ----
app.get("/health", (req, res) => res.json({ ok: true }));

// ---- Auth ----
async function requireAuth(req, res, next) {
  const match = (req.headers.authorization || "").match(/^Bearer (.+)$/);
  if (!match) return res.status(401).json({ error: "Missing bearer token" });
  try {
    const decoded = await auth.verifyIdToken(match[1]);
    req.uid = decoded.uid;
    next();
  } catch {
    return res.status(401).json({ error: "Invalid or expired token" });
  }
}

const HOUSEHOLD_UIDS = [
  "l54KxiEeMnQ9kf4FuGamqN4KqXe2", // Jason
  "TohGuGoD0jT4EVeWEWHousYz1kp2", // Gretchen
  "fvecqmkaOrgOKYjKI9k22S2Uwq43", // Elle
];
function requireHousehold(req, res, next) {
  if (HOUSEHOLD_UIDS.length && !HOUSEHOLD_UIDS.includes(req.uid)) {
    return res.status(403).json({ error: "Not a household member" });
  }
  next();
}

// All /api and /shared routes require auth + household
app.use(["/api", "/shared"], requireAuth, requireHousehold);

// =====================================================================
// PER-USER CRUD  —  users/{uid}/{collection}
// =====================================================================
const USER_COLLECTIONS = new Set([
  "meals", "weighIns", "workouts", "yoga",
  "mobility", "customExercises", "goals",
]);

function userCol(req) {
  const c = req.params.collection;
  if (!USER_COLLECTIONS.has(c)) return null;
  return db.collection("users").doc(req.uid).collection(c);
}

// Strip fields clients must not set directly
function cleanBody(body) {
  const { id, createdAt, updatedAt, createdBy, ...rest } = body || {};
  return rest;
}

// LIST: GET /api/meals?limit=100&orderBy=ts&dir=desc
app.get("/api/:collection", async (req, res) => {
  const col = userCol(req);
  if (!col) return res.status(404).json({ error: "Unknown collection" });
  try {
    let q = col;
    const orderBy = req.query.orderBy?.toString();
    if (orderBy) q = q.orderBy(orderBy, req.query.dir === "asc" ? "asc" : "desc");
    const limit = Math.min(parseInt(req.query.limit) || 500, 1000);
    q = q.limit(limit);
    const snap = await q.get();
    res.json({ items: snap.docs.map((d) => ({ id: d.id, ...d.data() })) });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "List failed" });
  }
});

// CREATE: POST /api/meals   body = the document
app.post("/api/:collection", async (req, res) => {
  const col = userCol(req);
  if (!col) return res.status(404).json({ error: "Unknown collection" });
  try {
    const data = cleanBody(req.body);
    data.createdAt = FieldValue.serverTimestamp();
    data.updatedAt = FieldValue.serverTimestamp();
    const ref = await col.add(data);
    res.status(201).json({ id: ref.id });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "Create failed" });
  }
});

// BATCH CREATE (migration): POST /api/meals/batch  body = { items: [...] }
app.post("/api/:collection/batch", async (req, res) => {
  const col = userCol(req);
  if (!col) return res.status(404).json({ error: "Unknown collection" });
  const items = req.body?.items;
  if (!Array.isArray(items) || !items.length) {
    return res.status(400).json({ error: "Body must be { items: [...] }" });
  }
  try {
    const ids = [];
    // Firestore batches max 500 ops; chunk at 450
    for (let i = 0; i < items.length; i += 450) {
      const batch = db.batch();
      for (const item of items.slice(i, i + 450)) {
        const ref = col.doc();
        const data = cleanBody(item);
        data.createdAt = FieldValue.serverTimestamp();
        data.updatedAt = FieldValue.serverTimestamp();
        batch.set(ref, data);
        ids.push(ref.id);
      }
      await batch.commit();
    }
    res.status(201).json({ count: ids.length, ids });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "Batch create failed" });
  }
});

// UPDATE: PUT /api/meals/{id}   body = fields to merge
app.put("/api/:collection/:id", async (req, res) => {
  const col = userCol(req);
  if (!col) return res.status(404).json({ error: "Unknown collection" });
  try {
    const ref = col.doc(req.params.id);
    const existing = await ref.get();
    const data = cleanBody(req.body);
    data.updatedAt = FieldValue.serverTimestamp();
    if (!existing.exists) data.createdAt = FieldValue.serverTimestamp();
    await ref.set(data, { merge: true });
    res.json({ id: req.params.id });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "Update failed" });
  }
});

// DELETE: DELETE /api/meals/{id}
app.delete("/api/:collection/:id", async (req, res) => {
  const col = userCol(req);
  if (!col) return res.status(404).json({ error: "Unknown collection" });
  try {
    await col.doc(req.params.id).delete();
    res.json({ id: req.params.id, deleted: true });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "Delete failed" });
  }
});

// =====================================================================
// SHARED CRUD  —  top-level recipes / routes, createdBy enforced
// =====================================================================
const SHARED_COLLECTIONS = new Set(["recipes", "routes", "foods"]);

function sharedCol(req) {
  const c = req.params.collection;
  if (!SHARED_COLLECTIONS.has(c)) return null;
  return db.collection(c);
}

app.get("/shared/:collection", async (req, res) => {
  const col = sharedCol(req);
  if (!col) return res.status(404).json({ error: "Unknown collection" });
  try {
    const snap = await col.limit(1000).get();
    res.json({ items: snap.docs.map((d) => ({ id: d.id, ...d.data() })) });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "List failed" });
  }
});

app.post("/shared/:collection", async (req, res) => {
  const col = sharedCol(req);
  if (!col) return res.status(404).json({ error: "Unknown collection" });
  try {
    const data = cleanBody(req.body);
    data.createdBy = req.uid; // stamped server-side, unforgeable
    data.createdAt = FieldValue.serverTimestamp();
    data.updatedAt = FieldValue.serverTimestamp();
    const ref = await col.add(data);
    res.status(201).json({ id: ref.id });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "Create failed" });
  }
});

app.put("/shared/:collection/:id", async (req, res) => {
  const col = sharedCol(req);
  if (!col) return res.status(404).json({ error: "Unknown collection" });
  try {
    const ref = col.doc(req.params.id);
    const existing = await ref.get();
    const data = cleanBody(req.body); // createdBy stripped => immutable
    data.updatedAt = FieldValue.serverTimestamp();
    if (!existing.exists) {
      // PUT used as create (client-generated ID): stamp ownership
      data.createdBy = req.uid;
      data.createdAt = FieldValue.serverTimestamp();
    }
    await ref.set(data, { merge: true });
    res.json({ id: req.params.id });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "Update failed" });
  }
});

app.delete("/shared/:collection/:id", async (req, res) => {
  const col = sharedCol(req);
  if (!col) return res.status(404).json({ error: "Unknown collection" });
  try {
    const ref = col.doc(req.params.id);
    const snap = await ref.get();
    if (!snap.exists) return res.status(404).json({ error: "Not found" });
    if (snap.data().createdBy !== req.uid) {
      return res.status(403).json({ error: "Only the creator can delete" });
    }
    await ref.delete();
    res.json({ id: req.params.id, deleted: true });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: "Delete failed" });
  }
});

// =====================================================================
// NUTRITION  —  USDA FoodData Central
// =====================================================================
const USDA_KEY = process.env.USDA_API_KEY;
// 1008 = Energy (kcal), 2047/2048 = Atwater energy (newer Foundation data)
const NUTRIENT_IDS = {
  1008: "calories", 2047: "calories", 2048: "calories",
  1003: "protein", 1004: "fat", 1005: "carbs",
};

app.get("/nutrition/search", requireAuth, requireHousehold, async (req, res) => {
  const q = (req.query.q || "").toString().trim();
  if (!q) return res.status(400).json({ error: "Missing query param q" });
  if (!USDA_KEY) return res.status(500).json({ error: "USDA key not configured" });

  try {
    // Two parallel searches: SR Legacy is queried separately because it is
    // the dataset with household portions ("1 large egg" = 50g) and reliable
    // detail records — but USDA's combined relevance ranking often buries it
    // under Foundation entries whose detail endpoints 404 (known FDC bug).
    // Common-name aliases: expand queries to the terms USDA actually
    // indexes staples under (e.g. FNDDS files bacon as "Pork bacon").
    const ALIASES = {
      bacon: "pork bacon",
      burger: "ground beef",
      hamburger: "ground beef",
      soda: "soft drink",
      pop: "soft drink",
      oatmeal: "oats cereal cooked",
      "peanut butter": "peanut butter",
      pb: "peanut butter",
      mayo: "mayonnaise",
      "chicken breast": "chicken breast",
      steak: "beef steak",
      fries: "white potato french fries",
      chips: "potato chips",
      "protein shake": "protein powder whey",
      yogurt: "yogurt",
      oj: "orange juice",
    };
    const expandedQ = ALIASES[qLower0(q)] || q;
    function qLower0(s) { return s.toLowerCase().trim(); }

    // POST search: dataType goes as a JSON array, avoiding the GET
    // comma-list parsing that breaks on "Survey (FNDDS)" / "SR Legacy".
    const search = async (dataTypes, pageSize, label) => {
      const r = await fetch(
        `https://api.nal.usda.gov/fdc/v1/foods/search?api_key=${USDA_KEY}`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ query: expandedQ, dataType: dataTypes, pageSize }),
        }
      );
      if (!r.ok) {
        console.error(`USDA ${label} search failed: ${r.status} ${await r.text().catch(() => "")}`);
        return { foods: [] };
      }
      return r.json();
    };

    // Household foods library: foods the family saved themselves — searched
    // first because they're curated, exact, and cover restaurant items no
    // public database has. Small collection; filter in memory.
    const householdSearch = async () => {
      try {
        const snap = await db.collection("foods").limit(300).get();
        const needle = expandedQ.toLowerCase();
        const rawNeedle = q.toLowerCase();
        return snap.docs
          .map((d) => ({ id: d.id, ...d.data() }))
          .filter((f) => {
            const n = (f.name || "").toLowerCase();
            return n.includes(needle) || n.includes(rawNeedle);
          })
          .slice(0, 4);
      } catch (e) {
        console.error("household foods search failed:", e.message);
        return [];
      }
    };

    // Open Food Facts: crowd-sourced branded/packaged foods (no key needed).
    // Server-side, so the CORS/503 problems that killed it client-side don't apply.
    const offSearch = async () => {
      try {
        const url = new URL("https://world.openfoodfacts.org/cgi/search.pl");
        url.searchParams.set("search_terms", q);
        url.searchParams.set("search_simple", "1");
        url.searchParams.set("action", "process");
        url.searchParams.set("json", "1");
        url.searchParams.set("page_size", "10");
        url.searchParams.set("fields", "product_name,brands,nutriments,code");
        const r = await fetch(url, {
          signal: AbortSignal.timeout(4000),
          headers: { "User-Agent": "household-fitness-tracker/1.0" },
        });
        if (!r.ok) return [];
        const data = await r.json();
        return (data.products || [])
          .map((p) => {
            const n = p.nutriments || {};
            return {
              source: "off",
              description: (p.product_name || "").trim(),
              brand: (p.brands || "").split(",")[0].trim() || null,
              calories: n["energy-kcal_100g"] != null ? Math.round(n["energy-kcal_100g"]) : null,
              protein: n["proteins_100g"] != null ? Math.round(n["proteins_100g"] * 10) / 10 : null,
              fat: n["fat_100g"] != null ? Math.round(n["fat_100g"] * 10) / 10 : null,
              carbs: n["carbohydrates_100g"] != null ? Math.max(0, Math.round(n["carbohydrates_100g"] * 10) / 10) : null,
            };
          })
          .filter((p) => p.description && p.calories != null)
          .slice(0, 6);
      } catch (e) {
        return []; // OFF slow or down: degrade silently to USDA-only
      }
    };

    const [staplesData, otherData, household, offFoods] = await Promise.all([
      // Survey (FNDDS) = the dietary-recall dataset: consumer food names
      // with household portions. SR Legacy = classic staples with portions.
      search(["Survey (FNDDS)", "SR Legacy"], 30, "staples"),
      search(["Foundation", "Branded"], 10, "other"),
      householdSearch(),
      offSearch(),
    ]);
    if (!(staplesData.foods || []).length && !(otherData.foods || []).length) {
      return res.status(502).json({ error: "USDA search returned nothing" });
    }

    // Rank staples by (a) how early the query appears among the
    // comma-separated name tokens — so "Bacon, NFS" and "Pork bacon" beat
    // "Salad with bacon" — and (b) name brevity, so plain generic entries
    // ("Egg, NFS", "Egg, whole, raw") beat composed dishes ("Egg, Benedict").
    const qLower = expandedQ.toLowerCase();
    const score = (f) => {
      const desc = (f.description || "").toLowerCase();
      const tokens = desc.split(",").map((t) => t.trim());
      let idx = tokens.findIndex((t) => t.startsWith(qLower) || t.includes(" " + qLower));
      if (idx === -1) idx = 9;
      return idx * 100 + Math.min(desc.length, 99);
    };
    const staplesSorted = [...(staplesData.foods || [])]
      .map((f, i) => ({ f, i, s: score(f) }))
      .sort((a, b) => a.s - b.s || a.i - b.i)
      .map((x) => x.f);

    const otherSorted = [...(otherData.foods || [])].sort((a, b) => {
      const rank = (f) => (f.dataType === "Foundation" ? 0 : 1);
      return rank(a) - rank(b);
    });
    const seen = new Set();
    const ranked = [...staplesSorted, ...otherSorted]
      .filter((f) => (seen.has(f.fdcId) ? false : (seen.add(f.fdcId), true)))
      .slice(0, 12);

    const householdMapped = household.map((f) => ({
      source: "household",
      description: f.name,
      brand: "Household",
      calories: f.calories ?? null,
      protein: f.protein ?? null,
      fat: f.fat ?? null,
      carbs: f.carbs ?? null,
    }));

    const foods = ranked.map((f) => {
      const nutrients = {};
      for (const n of f.foodNutrients || []) {
        const key = NUTRIENT_IDS[n.nutrientId];
        // First match wins (1008 listed before Atwater in practice; any is fine)
        if (key && nutrients[key] === undefined) nutrients[key] = n.value;
      }
      // Clamp negative carbs-by-difference artifacts
      if (nutrients.carbs !== undefined && nutrients.carbs < 0) nutrients.carbs = 0;
      // Fallback: compute calories from macros if still missing
      if (nutrients.calories === undefined &&
          (nutrients.protein !== undefined || nutrients.fat !== undefined || nutrients.carbs !== undefined)) {
        nutrients.calories = Math.round(
          (nutrients.protein || 0) * 4 + (nutrients.carbs || 0) * 4 + (nutrients.fat || 0) * 9
        );
      }
      return {
        fdcId: f.fdcId,
        description: f.description,
        brand: f.brandOwner || null,
        servingSize: f.servingSize || null,
        servingSizeUnit: f.servingSizeUnit || null,
        ...nutrients,
      };
    });

    // Final order: household first, USDA next, OFF last; name-dedupe across sources
    const nameSeen = new Set();
    const merged = [...householdMapped, ...foods, ...offFoods].filter((f) => {
      const k = (f.description || "").toLowerCase() + "|" + (f.brand || "").toLowerCase();
      if (nameSeen.has(k)) return false;
      nameSeen.add(k);
      return true;
    }).slice(0, 15);

    res.json({ query: q, count: merged.length, foods: merged });
  } catch (e) {
    console.error("USDA lookup failed:", e);
    res.status(502).json({ error: "Nutrition lookup failed" });
  }
});

// GET /nutrition/food/:fdcId  ->  per-100g macros + household portions
app.get("/nutrition/food/:fdcId", requireAuth, requireHousehold, async (req, res) => {
  if (!USDA_KEY) return res.status(500).json({ error: "USDA key not configured" });
  const fdcId = req.params.fdcId.replace(/[^0-9]/g, "");
  if (!fdcId) return res.status(400).json({ error: "Bad fdcId" });

  try {
    const url = new URL(`https://api.nal.usda.gov/fdc/v1/food/${fdcId}`);
    url.searchParams.set("api_key", USDA_KEY);
    const r = await fetch(url);
    if (!r.ok) return res.status(502).json({ error: `USDA responded ${r.status}` });
    const f = await r.json();

    // Per-100g macros (detail endpoint nests ids under n.nutrient.id)
    const nutrients = {};
    for (const n of f.foodNutrients || []) {
      const key = NUTRIENT_IDS[n.nutrient?.id];
      const val = n.amount;
      if (key && val != null && nutrients[key] === undefined) nutrients[key] = val;
    }
    if (nutrients.carbs !== undefined && nutrients.carbs < 0) nutrients.carbs = 0;
    if (nutrients.calories === undefined &&
        (nutrients.protein !== undefined || nutrients.fat !== undefined || nutrients.carbs !== undefined)) {
      nutrients.calories = Math.round(
        (nutrients.protein || 0) * 4 + (nutrients.carbs || 0) * 4 + (nutrients.fat || 0) * 9
      );
    }

    // Household portions: "1 large" = 50g, "1 slice" = 8g, etc.
    const portions = [];
    for (const p of f.foodPortions || []) {
      if (!p.gramWeight) continue;
      let label = (p.portionDescription || "").trim();
      if (!label || /quantity not specified/i.test(label)) {
        const unit = p.measureUnit?.name && p.measureUnit.name !== "undetermined" ? p.measureUnit.name : "";
        label = [p.amount, unit, p.modifier].filter(Boolean).join(" ").trim();
      }
      if (!label) continue;
      // FNDDS sometimes leaks numeric modifier codes (e.g. "90000") or
      // "Quantity not specified" pseudo-portions — skip those.
      if (/^[0-9]+$/.test(label) || /not specified/i.test(label)) continue;
      portions.push({ label, grams: Math.round(p.gramWeight * 100) / 100 });
    }
    // Branded foods: single labeled serving instead of foodPortions
    if (!portions.length && f.householdServingFullText && f.servingSize &&
        /g/i.test(f.servingSizeUnit || "")) {
      portions.push({
        label: f.householdServingFullText.trim(),
        grams: Math.round(f.servingSize * 100) / 100,
      });
    }
    // De-dupe by label
    const seen = new Set();
    const uniquePortions = portions.filter((p) => {
      const k = p.label.toLowerCase();
      if (seen.has(k)) return false;
      seen.add(k);
      return true;
    }).slice(0, 12);

    res.json({
      fdcId: f.fdcId,
      description: f.description,
      brand: f.brandOwner || null,
      ...nutrients,               // per 100g
      portions: uniquePortions,   // [{ label, grams }]
    });
  } catch (e) {
    console.error("USDA detail failed:", e);
    res.status(502).json({ error: "Food detail lookup failed" });
  }
});

const port = process.env.PORT || 8080;
app.listen(port, () => console.log(`fitness-api listening on ${port}`));
