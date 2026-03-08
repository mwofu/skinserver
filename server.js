const express = require("express");
const axios = require("axios");
const Jimp = require("jimp");
const FormData = require("form-data");
const NodeCache = require("node-cache");

const app = express();
const cache = new NodeCache({ stdTTL: 3600 }); // cache results for 1 hour

app.use(express.json());
app.use(express.text());

// ─── Skin layout constants ────────────────────────────────────────────────────
// Each entry: { base: [x,y,w,h], overlay: [x,y,w,h] }
// All coordinates are on the 64x64 skin texture
const PARTS = {
  head:      { base: [8,  8,  8, 8],  overlay: [40, 8,  8, 8]  },
  torso_top: { base: [20, 20, 8, 8],  overlay: [20, 36, 8, 8]  }, // top 8 rows of torso
  torso_bot: { base: [20, 28, 8, 4],  overlay: [20, 44, 8, 4]  }, // bottom 4 rows of torso
  rarm_top:  { base: [44, 20, 4, 8],  overlay: [44, 36, 4, 8]  }, // top 8 rows of right arm
  rarm_bot:  { base: [44, 28, 4, 4],  overlay: [44, 44, 4, 4]  }, // bottom 4 rows of right arm
  larm_top:  { base: [36, 52, 4, 8],  overlay: [52, 52, 4, 8]  }, // top 8 rows of left arm
  larm_bot:  { base: [36, 60, 4, 4],  overlay: [52, 60, 4, 4]  }, // bottom 4 rows of left arm
  rleg_top:  { base: [4,  20, 4, 8],  overlay: [4,  36, 4, 8]  }, // top 8 rows of right leg
  rleg_bot:  { base: [4,  28, 4, 4],  overlay: [4,  44, 4, 4]  }, // bottom 4 rows of right leg
  lleg_top:  { base: [20, 52, 4, 8],  overlay: [4,  52, 4, 8]  }, // top 8 rows of left leg
  lleg_bot:  { base: [20, 60, 4, 4],  overlay: [4,  60, 4, 4]  }, // bottom 4 rows of left leg
};

// Scale factors to reach 8x8 for each part
// Format: [scaleX, scaleY]
const SCALE = {
  head:      [1, 1], // already 8x8
  torso_top: [1, 1], // already 8x8
  torso_bot: [1, 2], // 8x4 → 8x8 (double height)
  rarm_top:  [2, 1], // 4x8 → 8x8 (double width)
  rarm_bot:  [2, 2], // 4x4 → 8x8 (double both)
  larm_top:  [2, 1],
  larm_bot:  [2, 2],
  rleg_top:  [2, 1],
  rleg_bot:  [2, 2],
  lleg_top:  [2, 1],
  lleg_bot:  [2, 2],
};

// ─── Mojang API helpers ───────────────────────────────────────────────────────

async function getUUID(username) {
  const res = await axios.get(
    `https://api.mojang.com/users/profiles/minecraft/${username}`
  );
  return { uuid: res.data.id, name: res.data.name };
}

async function getSkinUrl(uuid) {
  const res = await axios.get(
    `https://sessionserver.mojang.com/session/minecraft/profile/${uuid}`
  );
  const properties = res.data.properties;
  const textureProp = properties.find((p) => p.name === "textures");
  if (!textureProp) throw new Error("No texture property found");

  const decoded = JSON.parse(Buffer.from(textureProp.value, "base64").toString("utf8"));
  const skinUrl = decoded.textures.SKIN.url;
  const isSlim = decoded.textures.SKIN.metadata?.model === "slim";
  return { skinUrl, isSlim };
}

async function downloadSkin(url) {
  return await Jimp.read(url);
}

// ─── Skin processing ──────────────────────────────────────────────────────────

/**
 * If the skin is slim (3px arms), pad the arm regions to 4px wide.
 * Adds a column of black pixels on the right edge of each arm region.
 */
function normalizeSlimArms(skin) {
  const padded = skin.clone();

  // Arm regions that need padding for slim skins
  const slimArmRegions = [
    // [x, y, w, h] — these are 3px wide in slim skins
    { base: [44, 20, 3, 12], overlay: [44, 36, 3, 12] }, // right arm
    { base: [36, 52, 3, 12], overlay: [52, 52, 3, 12] }, // left arm
  ];

  for (const region of slimArmRegions) {
    for (const [rx, ry, rw, rh] of [region.base, region.overlay]) {
      // Fill column at x = rx+3 (the 4th pixel) with black for all rows
      for (let y = ry; y < ry + rh; y++) {
        padded.setPixelColor(0x000000ff, rx + 3, y);
      }
    }
  }

  return padded;
}

/**
 * Extract one body part from the skin, composite its overlay on top,
 * then scale it up to 8x8.
 */
async function extractPart(skin, partName) {
  const part = PARTS[partName];
  const [bx, by, bw, bh] = part.base;
  const [ox, oy, ow, oh] = part.overlay;
  const [sx, sy] = SCALE[partName];

  // Crop base layer
  const base = skin.clone().crop(bx, by, bw, bh);

  // Crop overlay layer
  const overlay = skin.clone().crop(ox, oy, ow, oh);

  // Composite overlay onto base
  base.composite(overlay, 0, 0, {
    mode: Jimp.BLEND_SOURCE_OVER,
    opacitySource: 1,
    opacityDest: 1,
  });

  // Scale up to 8x8
  base.resize(bw * sx, bh * sy, Jimp.RESIZE_NEAREST_NEIGHBOR);

  // Now place onto a full 64x64 transparent skin template
  // The face area is at (8,8) on the skin — we put our part texture there
  const skinTemplate = new Jimp(64, 64, 0x00000000);
  skinTemplate.composite(base, 8, 8);

  return skinTemplate;
}

// ─── Mineskin API ─────────────────────────────────────────────────────────────

/**
 * Upload a skin image buffer to Mineskin and return the texture value string.
 * Mineskin free tier has rate limits — we cache aggressively to avoid hitting them.
 */
async function uploadToMineskin(imageBuffer, partName) {
  const form = new FormData();
  form.append("file", imageBuffer, {
    filename: `${partName}.png`,
    contentType: "image/png",
  });
  form.append("visibility", "1"); // unlisted

  const res = await axios.post("https://api.mineskin.org/generate/upload", form, {
    headers: {
      ...form.getHeaders(),
      "User-Agent": "DiamondFireSkinServer/1.0",
    },
    timeout: 30000,
  });

  if (!res.data?.data?.texture?.value) {
    throw new Error(`Mineskin upload failed for ${partName}: ${JSON.stringify(res.data)}`);
  }

  return res.data.data.texture.value;
}

// ─── Main generation function ─────────────────────────────────────────────────

async function generateCharacterParts(username) {
  // 1. Check cache
  const cached = cache.get(username.toLowerCase());
  if (cached) {
    console.log(`[cache hit] ${username}`);
    return cached;
  }

  console.log(`[generating] ${username}`);

  // 2. Get UUID and skin URL
  const { uuid, name } = await getUUID(username);
  const { skinUrl, isSlim } = await getSkinUrl(uuid);

  console.log(`[skin] ${name} | UUID: ${uuid} | slim: ${isSlim} | url: ${skinUrl}`);

  // 3. Download skin
  let skin = await downloadSkin(skinUrl);

  // 4. Normalize slim arms if needed
  if (isSlim) {
    console.log(`[slim] padding arm regions to 4px`);
    skin = normalizeSlimArms(skin);
  }

  // 5. Extract and upload each part
  const partNames = Object.keys(PARTS);
  const result = {
    username: name,
    uuid,
    isSlim,
    parts: {},
  };

  for (const partName of partNames) {
    console.log(`[processing] ${partName}`);

    const partImage = await extractPart(skin, partName);
    const buffer = await partImage.getBufferAsync(Jimp.MIME_PNG);

    console.log(`[uploading] ${partName} to Mineskin...`);
    const textureValue = await uploadToMineskin(buffer, partName);

    result.parts[partName] = {
      textureValue,
      // Include scale info so DiamondFire knows how to reconstruct
      scaleX: SCALE[partName][0],
      scaleY: SCALE[partName][1],
    };

    console.log(`[done] ${partName}`);

    // Small delay between Mineskin uploads to respect rate limits
    await new Promise((r) => setTimeout(r, 1500));
  }

  // 6. Store in cache
  cache.set(username.toLowerCase(), result);

  return result;
}

// ─── Routes ───────────────────────────────────────────────────────────────────

// Main endpoint — called by DiamondFire's Get Web Response block
// POST /skin with body: {"username": "Notch"}
app.post("/skin", async (req, res) => {
  let username;
try {
  const parsed = typeof req.body === "string" ? JSON.parse(req.body) : req.body;
  username = parsed.username;
} catch (e) {
  return res.status(400).json({ error: "Invalid request body" });
}

  if (!username || typeof username !== "string") {
    return res.status(400).json({ error: "Missing username in request body" });
  }

  try {
    const result = await generateCharacterParts(username.trim());
    res.json(result);
  } catch (err) {
    console.error(`[error] ${err.message}`);
    res.status(500).json({ error: err.message });
  }
});

// Cache clear endpoint (useful when a player updates their skin)
// POST /clear with body: {"username": "Notch"}
app.post("/clear", (req, res) => {
  const { username } = req.body;
  if (!username) return res.status(400).json({ error: "Missing username" });
  cache.del(username.toLowerCase());
  res.json({ cleared: username });
});

// Health check
app.get("/", (req, res) => res.json({ status: "ok" }));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Skin server running on port ${PORT}`));
