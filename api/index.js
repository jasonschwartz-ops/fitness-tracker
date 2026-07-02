import express from "express";
import { initializeApp } from "firebase-admin/app";
import { getAuth } from "firebase-admin/auth";
import { getFirestore } from "firebase-admin/firestore";

// On Cloud Run in the same GCP project, default credentials just work.
initializeApp();
const auth = getAuth();
const db = getFirestore(); // used by CRUD endpoints (coming next)

const app = express();
app.use(express.json());

// ---- CORS (PWA is on GitHub Pages; localhost for dev) ----
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

// ---- Health check (no auth) ----
app.get("/health", (req, res) => res.json({ ok: true }));

// ---- Auth middleware: verifies the Firebase ID token ----
async function requireAuth(req, res, next) {
  const header = req.headers.authorization || "";
  const match = header.match(/^Bearer (.+)$/);
  if (!match) return res.status(401).json({ error: "Missing bearer token" });
  try {
    const decoded = await auth.verifyIdToken(match[1]);
    req.uid = decoded.uid;
    req.userEmail = decoded.email;
    next();
  } catch (e) {
    return res.status(401).json({ error: "Invalid or expired token" });
  }
}

// ---- Household allowlist (defense-in-depth, mirrors Firestore rules) ----
// Populate after both UIDs are known; empty array = allow any authed user.
const HOUSEHOLD_UIDS = [
     "l54KxiEeMnQ9kf4FuGamqN4KqXe2", // Jason
     "TohGuGoD0jT4EVeWEWHousYz1kp2", // Gretchen
   ];
function requireHousehold(req, res, next) {
  if (HOUSEHOLD_UIDS.length && !HOUSEHOLD_UIDS.includes(req.uid)) {
    return res.status(403).json({ error: "Not a household member" });
  }
  next();
}

// ---- Nutrition search: USDA FoodData Central ----
// GET /nutrition/search?q=chicken+breast
const USDA_KEY = process.env.USDA_API_KEY;
const NUTRIENT_IDS = { 1008: "calories", 1003: "protein", 1004: "fat", 1005: "carbs" };

app.get("/nutrition/search", requireAuth, requireHousehold, async (req, res) => {
  const q = (req.query.q || "").toString().trim();
  if (!q) return res.status(400).json({ error: "Missing query param q" });
  if (!USDA_KEY) return res.status(500).json({ error: "USDA key not configured" });

  try {
    const url = new URL("https://api.nal.usda.gov/fdc/v1/foods/search");
    url.searchParams.set("api_key", USDA_KEY);
    url.searchParams.set("query", q);
    url.searchParams.set("pageSize", "10");
    url.searchParams.set("dataType", "Foundation,SR Legacy,Branded");

    const r = await fetch(url);
    if (!r.ok) {
      return res.status(502).json({ error: `USDA responded ${r.status}` });
    }
    const data = await r.json();

    const foods = (data.foods || []).map((f) => {
      const nutrients = {};
      for (const n of f.foodNutrients || []) {
        const key = NUTRIENT_IDS[n.nutrientId];
        if (key) nutrients[key] = n.value;
      }
      return {
        fdcId: f.fdcId,
        description: f.description,
        brand: f.brandOwner || null,
        servingSize: f.servingSize || null,
        servingSizeUnit: f.servingSizeUnit || null,
        // Nutrients are per 100g for Foundation/SR Legacy,
        // per serving basis varies for Branded — client shows as-is for v1
        ...nutrients,
      };
    });

    res.json({ query: q, count: foods.length, foods });
  } catch (e) {
    console.error("USDA lookup failed:", e);
    res.status(502).json({ error: "Nutrition lookup failed" });
  }
});

// ---- CRUD endpoints land here next (meals, weighIns, workouts, ...) ----

const port = process.env.PORT || 8080;
app.listen(port, () => console.log(`fitness-api listening on ${port}`));