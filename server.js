const express = require("express");
const axios = require("axios");
const Jimp = require("jimp");
const FormData = require("form-data");
const NodeCache = require("node-cache");

const app = express();
const cache = new NodeCache({ stdTTL: 3600 });

app.use(express.json());
app.use(express.text());

// ─── Job queue ────────────────────────────────────────────────────────────────
// jobs: { [username]: { status: "pending"|"processing"|"done"|"error", result?, error? } }
const jobs = {};
let isProcessing = false;
const queue = []; // ordered list of usernames waiting to be processed

function enqueue(username) {
  const key = username.toLowerCase();

  // If already cached, nothing to do
  if (cache.get(key)) return;

  // If already queued or processing, nothing to do
  if (jobs[key] && jobs[key].status !== "error") return;

  // Add to job registry and queue
  jobs[key] = { status: "pending" };
  queue.push(key);

  // Kick off processing if not already running
  processNext();
}

async function processNext() {
  if (isProcessing) return;
  if (queue.length === 0) return;

  isProcessing = true;
  const username = queue.shift();
  const key = username.toLowerCase();

  // Skip if it got cached while waiting (e.g. duplicate request resolved already)
  if (cache.get(key)) {
    jobs[key] = { status: "done", result: cache.get(key) };
    isProcessing = false;
    processNext();
    return;
  }

  jobs[key].status = "processing";
  console.log(`[queue] processing ${username}`);

  try {
    const result = await generateCharacterParts(username);
    jobs[key] = { status: "done", result };
  } catch (err) {
    console.error(`[queue] error for ${username}: ${err.message}`);
    jobs[key] = { status: "error", error: err.message };
  }

  isProcessing = false;
  processNext();
}

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

const BODY_FACES = {
  // ── Head ──────────────────────────────────────────────────────────────────
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
    faceScale: { top: [1,1], bottom: [1,1], right: [1,1], front: [1,1], left: [1,1], back: [1,1] },
  },

  // ── Torso top (top 8 rows of torso) ──────────────────────────────────────
  torso_top: {
    base: {
      top:    [20, 16, 8, 4],
      bottom: null,
      right:  [16, 20, 4, 8],
      front:  [20, 20, 8, 8],
      left:   [28, 20, 4, 8],
      back:   [32, 20, 8, 8],
    },
    overlay: {
      top:    [20, 32, 8, 4],
      bottom: null,
      right:  [16, 36, 4, 8],
      front:  [20, 36, 8, 8],
      left:   [28, 36, 4, 8],
      back:   [32, 36, 8, 8],
    },
    faceScale: { top: [1,2], bottom: [1,1], right: [2,1], front: [1,1], left: [2,1], back: [1,1] },
  },

  // ── Torso bottom (bottom 4 rows of torso) ────────────────────────────────
  torso_bot: {
    base: {
      top:    null,
      bottom: [28, 16, 8, 4],
      right:  [16, 28, 4, 4],
      front:  [20, 28, 8, 4],
      left:   [28, 28, 4, 4],
      back:   [32, 28, 8, 4],
    },
    overlay: {
      top:    null,
      bottom: [28, 32, 8, 4],
      right:  [16, 44, 4, 4],
      front:  [20, 44, 8, 4],
      left:   [28, 44, 4, 4],
      back:   [32, 44, 8, 4],
    },
    faceScale: { top: [1,1], bottom: [1,2], right: [2,2], front: [1,2], left: [2,2], back: [1,2] },
  },

  // ── Right Arm top (top 8 rows) ────────────────────────────────────────────
  rarm_top: {
    base: {
      top:    [44, 16, 4, 4],
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
    faceScale: { top: [2,2], bottom: [1,1], right: [2,1], front: [2,1], left: [2,1], back: [2,1] },
  },

  // ── Right Arm bottom (bottom 4 rows) ─────────────────────────────────────
  rarm_bot: {
    base: {
      top:    null,
      bottom: [48, 16, 4, 4],
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

const SCALE = {
  head:      [1, 1, 1],
  torso_top: [1, 1, 2],
  torso_bot: [1, 2, 2],
  rarm_top:  [2, 1, 2],
  rarm_bot:  [2, 2, 2],
  larm_top:  [2, 1, 2],
  larm_bot:  [2, 2, 2],
  rleg_top:  [2, 1, 2],
  rleg_bot:  [2, 2, 2],
  lleg_top:  [2, 1, 2],
  lleg_bot:  [2, 2, 2],
};

const OFFSETS = {
  head:      [0,      1.8,   0],
  torso_top: [0,      1.3,   0],
  torso_bot: [0,      0.8,   0],
  rarm_top:  [0.375,  1.3,   0],
  rarm_bot:  [0.375,  0.8,   0],
  larm_top:  [-0.375, 1.3,   0],
  larm_bot:  [-0.375, 0.8,   0],
  rleg_top:  [0.125,  0.55,  0],
  rleg_bot:  [0.125,  0.05,  0],
  lleg_top:  [-0.125, 0.55,  0],
  lleg_bot:  [-0.125, 0.05,  0],
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

  const slimFaceColumns = [
    [43, 20, 12], [47, 20, 12], [51, 20, 12], [55, 20, 12],
    [43, 16, 4],  [47, 16, 4],
    [43, 36, 12], [47, 36, 12], [51, 36, 12], [55, 36, 12],
    [43, 32, 4],  [47, 32, 4],
    [35, 52, 12], [39, 52, 12], [43, 52, 12], [47, 52, 12],
    [35, 48, 4],  [39, 48, 4],
    [51, 52, 12], [55, 52, 12], [59, 52, 12], [63, 52, 12],
    [51, 48, 4],  [55, 48, 4],
  ];

  for (const [x, y, h] of slimFaceColumns) {
    for (let row = y; row < y + h; row++) {
      const edgeColor = padded.getPixelColor(x - 1, row);
      padded.setPixelColor(edgeColor, x, row);
    }
  }

  return padded;
}

// ─── Face extraction helpers ──────────────────────────────────────────────────

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
  const output = new Jimp(64, 64, 0x00000000);

  for (const faceName of faceNames) {
    const baseCoords = partDef.base[faceName];
    const overlayCoords = partDef.overlay[faceName];
    const [sx, sy] = partDef.faceScale[faceName];

    let baseFace = cropFace(skin, baseCoords);
    if (!baseFace) {
      baseFace = new Jimp(8, 8, 0x00000000);
    } else {
      baseFace = scaleFace(baseFace, sx, sy);
    }
    const [bpx, bpy] = HEAD_FACE_POSITIONS.base[faceName];
    output.composite(baseFace, bpx, bpy);

    let overlayFace = cropFace(skin, overlayCoords);
    if (overlayFace) {
      overlayFace = scaleFace(overlayFace, sx, sy);
      const [opx, opy] = HEAD_FACE_POSITIONS.overlay[faceName];
      output.composite(overlayFace, opx, opy);
    }
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

// ─── Core generation (unchanged from your version) ───────────────────────────

async function generateCharacterParts(username) {
  const key = username.toLowerCase();
  const cached = cache.get(key);
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
      scaleZ: SCALE[partName][2],
      offsetX: OFFSETS[partName][0],
      offsetY: OFFSETS[partName][1],
      offsetZ: OFFSETS[partName][2],
    };

    console.log(`[done] ${partName}`);
    await new Promise((r) => setTimeout(r, 3500));
  }

  cache.set(key, result);
  return result;
}

// ─── Routes ───────────────────────────────────────────────────────────────────

function parseBody(req) {
  return typeof req.body === "string" ? JSON.parse(req.body) : req.body;
}

// POST /skin — enqueues the job and returns immediately with a job status
app.post("/skin", (req, res) => {
  let username;
  try {
    username = parseBody(req).username;
  } catch (e) {
    return res.status(400).json({ error: "Invalid request body" });
  }
  if (!username || typeof username !== "string") {
    return res.status(400).json({ error: "Missing username" });
  }

  const key = username.trim().toLowerCase();

  // If already cached, return result immediately
  const cached = cache.get(key);
  if (cached) {
    return res.json({ status: "done", result: cached });
  }

  // Enqueue and return pending status
  enqueue(username.trim());
  const job = jobs[key];

  // If it finished synchronously (shouldn't happen but just in case)
  if (job.status === "done") {
    return res.json({ status: "done", result: job.result });
  }

  res.json({ status: job.status }); // "pending" or "processing"
});

// GET /status/:username — poll this to check if a job is done
app.get("/status/:username", (req, res) => {
  const key = req.params.username.toLowerCase();

  // Check cache first
  const cached = cache.get(key);
  if (cached) {
    return res.json({ status: "done", result: cached });
  }

  const job = jobs[key];
  if (!job) {
    return res.json({ status: "not_found" });
  }

  if (job.status === "done") {
    return res.json({ status: "done", result: job.result });
  }

  if (job.status === "error") {
    return res.json({ status: "error", error: job.error });
  }

  // pending or processing — tell DiamondFire to keep polling
  res.json({ status: job.status });
});

// POST /clear
app.post("/clear", (req, res) => {
  let username;
  try {
    username = parseBody(req).username;
  } catch (e) {
    return res.status(400).json({ error: "Invalid request body" });
  }
  if (!username) return res.status(400).json({ error: "Missing username" });
  const key = username.toLowerCase();
  cache.del(key);
  delete jobs[key];
  res.json({ cleared: username });
});

// Health check
app.get("/", (req, res) => res.json({ status: "ok" }));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Skin server running on port ${PORT}`));