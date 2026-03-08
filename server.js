const express = require("express");
const axios = require("axios");
const Jimp = require("jimp");
const FormData = require("form-data");
const NodeCache = require("node-cache");

const app = express();
const cache = new NodeCache({ stdTTL: 3600 });

app.use(express.json());
app.use(express.text());

// ─── Minecraft skin face coordinates ─────────────────────────────────────────
// A Minecraft skin is 64x64. Each body part has 6 faces on it.
// Coordinates: [x, y, w, h] on the original skin texture.
//
// Head faces on the OUTPUT head skin texture (64x64):
//   Top:    (8,0)   8x8
//   Bottom: (16,0)  8x8  (actually at x=16 on the UV map)
//   Right:  (0,8)   8x8
//   Front:  (8,8)   8x8
//   Left:   (16,8)  8x8
//   Back:   (24,8)  8x8
//
// Outer layer faces on the OUTPUT head skin texture:
//   Top:    (40,0)  8x8
//   Bottom: (48,0)  8x8
//   Right:  (32,8)  8x8
//   Front:  (40,8)  8x8
//   Left:   (48,8)  8x8
//   Back:   (56,8)  8x8

// Body part face definitions on the SOURCE skin.
// For parts that are split top/bottom, we slice the faces vertically.
// Format: { front, back, right, left, top, bottom }
// Each face: [x, y, w, h] on the 64x64 skin

const BODY_FACES = {
  // ── Head ──────────────────────────────────────────────────────────────────
  // Head is 8x8x8. Already maps perfectly to a head skin.
  head: {
    base: {
      top:    [8,  0,  8, 8],
      bottom: [16, 0,  8, 8],
      right:  [0,  8,  8, 8],
      front:  [8,  8,  8, 8],
      left:   [16, 8,  8, 8],
      back:   [24, 8,  8, 8],
    },
    overlay: {
      top:    [40, 0,  8, 8],
      bottom: [48, 0,  8, 8],
      right:  [32, 8,  8, 8],
      front:  [40, 8,  8, 8],
      left:   [48, 8,  8, 8],
      back:   [56, 8,  8, 8],
    },
    // No scaling needed — head faces are already 8x8
    faceScale: { top: [1,1], bottom: [1,1], right: [1,1], front: [1,1], left: [1,1], back: [1,1] },
  },

  // ── Torso top (top 8 rows of torso) ──────────────────────────────────────
  // Torso front/back are 8 wide, sides are 4 wide, top is 8x4
  // We take the top 8 rows of the 12-row torso
  torso_top: {
    base: {
      top:    [20, 16, 8, 4],  // torso top face (full, not split)
      bottom: null,             // middle of torso — use front texture as filler
      right:  [16, 20, 4, 8],  // right side, top 8 rows
      front:  [20, 20, 8, 8],  // front face, top 8 rows
      left:   [28, 20, 4, 8],  // left side, top 8 rows
      back:   [32, 20, 8, 8],  // back face, top 8 rows
    },
    overlay: {
      top:    [20, 32, 8, 4],
      bottom: null,
      right:  [16, 36, 4, 8],
      front:  [20, 36, 8, 8],
      left:   [28, 36, 4, 8],
      back:   [32, 36, 8, 8],
    },
    // Sides are 4 wide → scale to 8 wide. Top is 8x4 → scale to 8x8.
    faceScale: { top: [1,2], bottom: [1,1], right: [2,1], front: [1,1], left: [2,1], back: [1,1] },
  },

  // ── Torso bottom (bottom 4 rows of torso) ────────────────────────────────
  torso_bot: {
    base: {
      top:    null,             // middle of torso — use front as filler
      bottom: [28, 16, 8, 4],  // torso bottom face
      right:  [16, 28, 4, 4],  // right side, bottom 4 rows
      front:  [20, 28, 8, 4],  // front face, bottom 4 rows
      left:   [28, 28, 4, 4],  // left side, bottom 4 rows
      back:   [32, 28, 8, 4],  // back face, bottom 4 rows
    },
    overlay: {
      top:    null,
      bottom: [28, 32, 8, 4],
      right:  [16, 44, 4, 4],
      front:  [20, 44, 8, 4],
      left:   [28, 44, 4, 4],
      back:   [32, 44, 8, 4],
    },
    // Sides 4→8 wide, front/back 8x4→8x8, bottom 8x4→8x8
    faceScale: { top: [1,1], bottom: [1,2], right: [2,2], front: [1,2], left: [2,2], back: [1,2] },
  },

  // ── Right Arm top (top 8 rows) ────────────────────────────────────────────
  // Arm is 4x12x4. Faces: front/back 4x12, sides 4x12, top/bottom 4x4
  rarm_top: {
    base: {
      top:    [44, 16, 4, 4],  // arm top face
      bottom: null,
      right:  [40, 20, 4, 8],
      front:  [44, 20, 4, 8],
      left:   [48, 20, 4, 8],
      back:   [52, 20, 4, 8],
    },
    overlay: {
      top:    [44, 32, 4, 4],
      bottom: null,
      right:  [40, 36, 4, 8],
      front:  [44, 36, 4, 8],
      left:   [48, 36, 4, 8],
      back:   [52, 36, 4, 8],
    },
    // All faces are 4 wide → scale x2. Top is 4x4 → scale 2x2.
    faceScale: { top: [2,2], bottom: [1,1], right: [2,1], front: [2,1], left: [2,1], back: [2,1] },
  },

  // ── Right Arm bottom (bottom 4 rows) ─────────────────────────────────────
  rarm_bot: {
    base: {
      top:    null,
      bottom: [48, 16, 4, 4],  // arm bottom face
      right:  [40, 28, 4, 4],
      front:  [44, 28, 4, 4],
      left:   [48, 28, 4, 4],
      back:   [52, 28, 4, 4],
    },
    overlay: {
      top:    null,
      bottom: [48, 32, 4, 4],
      right:  [40, 44, 4, 4],
      front:  [44, 44, 4, 4],
      left:   [48, 44, 4, 4],
      back:   [52, 44, 4, 4],
    },
    faceScale: { top: [1,1], bottom: [2,2], right: [2,2], front: [2,2], left: [2,2], back: [2,2] },
  },

  // ── Left Arm top ──────────────────────────────────────────────────────────
  larm_top: {
    base: {
      top:    [36, 48, 4, 4],
      bottom: null,
      right:  [32, 52, 4, 8],
      front:  [36, 52, 4, 8],
      left:   [40, 52, 4, 8],
      back:   [44, 52, 4, 8],
    },
    overlay: {
      top:    [52, 48, 4, 4],
      bottom: null,
      right:  [48, 52, 4, 8],
      front:  [52, 52, 4, 8],
      left:   [56, 52, 4, 8],
      back:   [60, 52, 4, 8],
    },
    faceScale: { top: [2,2], bottom: [1,1], right: [2,1], front: [2,1], left: [2,1], back: [2,1] },
  },

  // ── Left Arm bottom ───────────────────────────────────────────────────────
  larm_bot: {
    base: {
      top:    null,
      bottom: [40, 48, 4, 4],
      right:  [32, 60, 4, 4],
      front:  [36, 60, 4, 4],
      left:   [40, 60, 4, 4],
      back:   [44, 60, 4, 4],
    },
    overlay: {
      top:    null,
      bottom: [56, 48, 4, 4],
      right:  [48, 60, 4, 4],
      front:  [52, 60, 4, 4],
      left:   [56, 60, 4, 4],
      back:   [60, 60, 4, 4],
    },
    faceScale: { top: [1,1], bottom: [2,2], right: [2,2], front: [2,2], left: [2,2], back: [2,2] },
  },

  // ── Right Leg top ─────────────────────────────────────────────────────────
  rleg_top: {
    base: {
      top:    [4,  16, 4, 4],
      bottom: null,
      right:  [0,  20, 4, 8],
      front:  [4,  20, 4, 8],
      left:   [8,  20, 4, 8],
      back:   [12, 20, 4, 8],
    },
    overlay: {
      top:    [4,  32, 4, 4],
      bottom: null,
      right:  [0,  36, 4, 8],
      front:  [4,  36, 4, 8],
      left:   [8,  36, 4, 8],
      back:   [12, 36, 4, 8],
    },
    faceScale: { top: [2,2], bottom: [1,1], right: [2,1], front: [2,1], left: [2,1], back: [2,1] },
  },

  // ── Right Leg bottom ──────────────────────────────────────────────────────
  rleg_bot: {
    base: {
      top:    null,
      bottom: [8,  16, 4, 4],
      right:  [0,  28, 4, 4],
      front:  [4,  28, 4, 4],
      left:   [8,  28, 4, 4],
      back:   [12, 28, 4, 4],
    },
    overlay: {
      top:    null,
      bottom: [8,  32, 4, 4],
      right:  [0,  44, 4, 4],
      front:  [4,  44, 4, 4],
      left:   [8,  44, 4, 4],
      back:   [12, 44, 4, 4],
    },
    faceScale: { top: [1,1], bottom: [2,2], right: [2,2], front: [2,2], left: [2,2], back: [2,2] },
  },

  // ── Left Leg top ──────────────────────────────────────────────────────────
  lleg_top: {
    base: {
      top:    [20, 48, 4, 4],
      bottom: null,
      right:  [16, 52, 4, 8],
      front:  [20, 52, 4, 8],
      left:   [24, 52, 4, 8],
      back:   [28, 52, 4, 8],
    },
    overlay: {
      top:    [4,  48, 4, 4],
      bottom: null,
      right:  [0,  52, 4, 8],
      front:  [4,  52, 4, 8],
      left:   [8,  52, 4, 8],
      back:   [12, 52, 4, 8],
    },
    faceScale: { top: [2,2], bottom: [1,1], right: [2,1], front: [2,1], left: [2,1], back: [2,1] },
  },

  // ── Left Leg bottom ───────────────────────────────────────────────────────
  lleg_bot: {
    base: {
      top:    null,
      bottom: [24, 48, 4, 4],
      right:  [16, 60, 4, 4],
      front:  [20, 60, 4, 4],
      left:   [24, 60, 4, 4],
      back:   [28, 60, 4, 4],
    },
    overlay: {
      top:    null,
      bottom: [8,  48, 4, 4],
      right:  [0,  60, 4, 4],
      front:  [4,  60, 4, 4],
      left:   [8,  60, 4, 4],
      back:   [12, 60, 4, 4],
    },
    faceScale: { top: [1,1], bottom: [2,2], right: [2,2], front: [2,2], left: [2,2], back: [2,2] },
  },
};

// Where each face goes on the OUTPUT 64x64 head skin texture
const HEAD_FACE_POSITIONS = {
  base: {
    top:    [8,  0],
    bottom: [16, 0],
    right:  [0,  8],
    front:  [8,  8],
    left:   [16, 8],
    back:   [24, 8],
  },
  overlay: {
    top:    [40, 0],
    bottom: [48, 0],
    right:  [32, 8],
    front:  [40, 8],
    left:   [48, 8],
    back:   [56, 8],
  },
};

// Scale info for DiamondFire reconstruction (how much to shrink the head in-game)
const SCALE = {
  head:      [1, 1],
  torso_top: [1, 1],
  torso_bot: [1, 2],
  rarm_top:  [2, 1],
  rarm_bot:  [2, 2],
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

// ─── Slim arm normalisation ───────────────────────────────────────────────────

function normalizeSlimArms(skin) {
  const padded = skin.clone();

  // Slim arms are 3px wide. Pad to 4px by adding a black column on the right.
  // We need to pad all face columns for both base and overlay layers.
  // Right arm base: x=40..55, y=16..32 (top/faces/bottom block)
  // Left arm base:  x=32..47, y=48..64
  // Right arm overlay: x=40..55, y=32..48
  // Left arm overlay:  x=48..63, y=48..64

  const regionsToShift = [
    // [startX of 3px region, startY, height of region, which column to insert after]
    // Right arm base faces: columns 40,44,48,52 are starts of 3px faces
    { faces: [[40,20,3,12],[44,20,3,12],[48,20,3,12],[52,20,3,12]], topY: 16, topH: 4, botY: 32, botH: 4 },
    // Right arm overlay faces
    { faces: [[40,36,3,12],[44,36,3,12],[48,36,3,12],[52,36,3,12]], topY: 32, topH: 4, botY: 44, botH: 4 },
    // Left arm base faces
    { faces: [[32,52,3,12],[36,52,3,12],[40,52,3,12],[44,52,3,12]], topY: 48, topH: 4, botY: 60, botH: 4 },
    // Left arm overlay faces
    { faces: [[48,52,3,12],[52,52,3,12],[56,52,3,12],[60,52,3,12]], topY: 48, topH: 4, botY: 60, botH: 4 },
  ];

  // Simpler approach: just fill the 4th pixel column of each 3px face with black
  const slimFaceColumns = [
    // right arm base
    [43, 20, 12], [47, 20, 12], [51, 20, 12], [55, 20, 12],
    [43, 16, 4],  [47, 16, 4],  // top/bottom of right arm base
    // right arm overlay
    [43, 36, 12], [47, 36, 12], [51, 36, 12], [55, 36, 12],
    [43, 32, 4],  [47, 32, 4],
    // left arm base
    [35, 52, 12], [39, 52, 12], [43, 52, 12], [47, 52, 12],
    [35, 48, 4],  [39, 48, 4],
    // left arm overlay
    [51, 52, 12], [55, 52, 12], [59, 52, 12], [63, 52, 12],
    [51, 48, 4],  [55, 48, 4],
  ];

  for (const [x, y, h] of slimFaceColumns) {
    for (let row = y; row < y + h; row++) {
      padded.setPixelColor(0x000000ff, x, row);
    }
  }

  return padded;
}

// ─── Face extraction helper ───────────────────────────────────────────────────

function cropFace(skin, coords) {
  if (!coords) return null;
  const [x, y, w, h] = coords;
  return skin.clone().crop(x, y, w, h);
}

function scaleFace(face, scaleX, scaleY) {
  if (!face) return null;
  const w = face.bitmap.width;
  const h = face.bitmap.height;
  return face.resize(w * scaleX, h * scaleY, Jimp.RESIZE_NEAREST_NEIGHBOR);
}

function compositeFace(base, overlay) {
  if (!base && !overlay) return null;
  if (!base) return overlay;
  if (!overlay) return base;
  return base.composite(overlay, 0, 0, {
    mode: Jimp.BLEND_SOURCE_OVER,
    opacitySource: 1,
    opacityDest: 1,
  });
}

// ─── Main part extractor ──────────────────────────────────────────────────────

async function extractPart(skin, partName) {
  const partDef = BODY_FACES[partName];
  const faceNames = ["top", "bottom", "right", "front", "left", "back"];

  // Build the output 64x64 head skin
  const output = new Jimp(64, 64, 0x00000000);

  for (const faceName of faceNames) {
    const baseCoords = partDef.base[faceName];
    const overlayCoords = partDef.overlay[faceName];
    const [sx, sy] = partDef.faceScale[faceName];

    // Get base face
    let baseFace = cropFace(skin, baseCoords);
    if (!baseFace) {
      // Use a blank face if this face doesn't exist (e.g. cut faces in split parts)
      baseFace = new Jimp(8, 8, 0x00000000);
    } else {
      baseFace = scaleFace(baseFace, sx, sy);
    }

    // Get overlay face
    let overlayFace = cropFace(skin, overlayCoords);
    if (overlayFace) {
      overlayFace = scaleFace(overlayFace, sx, sy);
    }

    // Composite overlay onto base
    const combined = compositeFace(baseFace, overlayFace);

    // Place onto output at the correct head skin position (base layer)
    const [bpx, bpy] = HEAD_FACE_POSITIONS.base[faceName];
    output.composite(combined, bpx, bpy);

    // Also place onto overlay layer position (copy of same — outer layer already baked in)
    const [opx, opy] = HEAD_FACE_POSITIONS.overlay[faceName];
    output.composite(combined, opx, opy);
  }

  return output;
}

// ─── Mineskin upload ──────────────────────────────────────────────────────────

async function uploadToMineskin(imageBuffer, partName) {
  const form = new FormData();
  form.append("file", imageBuffer, {
    filename: `${partName}.png`,
    contentType: "image/png",
  });

  try {
    const res = await axios.post("https://api.mineskin.org/v2/generate", form, {
      headers: {
        ...form.getHeaders(),
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
        "Authorization": `Bearer ${process.env.MINESKIN_API_KEY}`,
      },
      timeout: 30000,
    });

    if (!res.data?.skin?.texture?.data?.value) {
      throw new Error(`Mineskin upload failed for ${partName}: ${JSON.stringify(res.data)}`);
    }

    return res.data.skin.texture.data.value;
  } catch (err) {
    console.log(`Mineskin error body:`, JSON.stringify(err.response?.data));
    throw err;
  }
}

// ─── Main generation ──────────────────────────────────────────────────────────

async function generateCharacterParts(username) {
  const cached = cache.get(username.toLowerCase());
  if (cached) {
    console.log(`[cache hit] ${username}`);
    return cached;
  }

  console.log(`[generating] ${username}`);

  const { uuid, name } = await getUUID(username);
  const { skinUrl, isSlim } = await getSkinUrl(uuid);

  console.log(`[skin] ${name} | UUID: ${uuid} | slim: ${isSlim} | url: ${skinUrl}`);

  let skin = await downloadSkin(skinUrl);

  if (isSlim) {
    console.log(`[slim] padding arm regions to 4px`);
    skin = normalizeSlimArms(skin);
  }

  const partNames = Object.keys(BODY_FACES);
  const result = { username: name, uuid, isSlim, parts: {} };

  for (const partName of partNames) {
    console.log(`[processing] ${partName}`);

    const partImage = await extractPart(skin, partName);
    const buffer = await partImage.getBufferAsync(Jimp.MIME_PNG);

    console.log(`[uploading] ${partName} to Mineskin...`);
    const textureValue = await uploadToMineskin(buffer, partName);

    result.parts[partName] = {
      textureValue,
      scaleX: SCALE[partName][0],
      scaleY: SCALE[partName][1],
    };

    console.log(`[done] ${partName}`);

    await new Promise((r) => setTimeout(r, 3500));
  }

  cache.set(username.toLowerCase(), result);
  return result;
}

// ─── Routes ───────────────────────────────────────────────────────────────────

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

app.post("/clear", (req, res) => {
  let username;
  try {
    const parsed = typeof req.body === "string" ? JSON.parse(req.body) : req.body;
    username = parsed.username;
  } catch (e) {
    return res.status(400).json({ error: "Invalid request body" });
  }
  if (!username) return res.status(400).json({ error: "Missing username" });
  cache.del(username.toLowerCase());
  res.json({ cleared: username });
});

app.get("/", (req, res) => res.json({ status: "ok" }));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Skin server running on port ${PORT}`));