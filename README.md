# DiamondFire Skin Server

Converts any Minecraft player's skin into 11 separate texture values — one per body part — so you can reconstruct their character in DiamondFire using player heads.

---

## How it works

1. Takes a username from DiamondFire via a POST request
2. Calls the Mojang API to get their UUID and skin texture URL
3. Downloads the 64x64 skin PNG
4. If the skin uses slim (3px) arms, pads them to 4px with black pixels
5. Slices the skin into 11 body parts, compositing the outer layer onto each
6. Scales each part up to 8x8 (nearest-neighbour, no blurring)
7. Uploads each to Mineskin.org to get a Minecraft texture value
8. Returns all 11 texture values as JSON, cached for 1 hour

---

## Body parts & reconstruction guide

| Key         | Original size | Scale applied | In-game head size to use     |
|-------------|--------------|---------------|------------------------------|
| `head`      | 8x8          | 1x1           | normal (100%)                |
| `torso_top` | 8x8          | 1x1           | normal (100%)                |
| `torso_bot` | 8x4 → 8x8   | 1x2 (Y only)  | half height (50% Y)          |
| `rarm_top`  | 4x8 → 8x8   | 2x1 (X only)  | half width (50% X)           |
| `rarm_bot`  | 4x4 → 8x8   | 2x2           | half size (50% X, 50% Y)     |
| `larm_top`  | 4x8 → 8x8   | 2x1 (X only)  | half width (50% X)           |
| `larm_bot`  | 4x4 → 8x8   | 2x2           | half size (50% X, 50% Y)     |
| `rleg_top`  | 4x8 → 8x8   | 2x1 (X only)  | half width (50% X)           |
| `rleg_bot`  | 4x4 → 8x8   | 2x2           | half size (50% X, 50% Y)     |
| `lleg_top`  | 4x8 → 8x8   | 2x1 (X only)  | half width (50% X)           |
| `lleg_bot`  | 4x4 → 8x8   | 2x2           | half size (50% X, 50% Y)     |

The `scaleX` and `scaleY` values are also included in the JSON response if you want to use them programmatically.

---

## Setup

### 1. Install dependencies
```bash
npm install
```

### 2. Run locally
```bash
npm start
```
Server runs on port 3000 by default.

### 3. Deploy (recommended: Railway or Render)
- Push this folder to a GitHub repo
- Connect the repo to [Railway](https://railway.app) or [Render](https://render.com)
- Both have free tiers that work fine for this
- They'll auto-detect Node and run `npm start`
- You'll get a public HTTPS URL to use in DiamondFire

---

## API

### `POST /skin`
Request body:
```json
{ "username": "Notch" }
```

Response:
```json
{
  "username": "Notch",
  "uuid": "069a79f4...",
  "isSlim": false,
  "parts": {
    "head":      { "textureValue": "eyJ0...", "scaleX": 1, "scaleY": 1 },
    "torso_top": { "textureValue": "eyJ0...", "scaleX": 1, "scaleY": 1 },
    "torso_bot": { "textureValue": "eyJ0...", "scaleX": 1, "scaleY": 2 },
    "rarm_top":  { "textureValue": "eyJ0...", "scaleX": 2, "scaleY": 1 },
    "rarm_bot":  { "textureValue": "eyJ0...", "scaleX": 2, "scaleY": 2 },
    "larm_top":  { "textureValue": "eyJ0...", "scaleX": 2, "scaleY": 1 },
    "larm_bot":  { "textureValue": "eyJ0...", "scaleX": 2, "scaleY": 2 },
    "rleg_top":  { "textureValue": "eyJ0...", "scaleX": 2, "scaleY": 1 },
    "rleg_bot":  { "textureValue": "eyJ0...", "scaleX": 2, "scaleY": 2 },
    "lleg_top":  { "textureValue": "eyJ0...", "scaleX": 2, "scaleY": 1 },
    "lleg_bot":  { "textureValue": "eyJ0...", "scaleX": 2, "scaleY": 2 }
  }
}
```

### `POST /clear`
Clears the cache for a username (use when a player changes their skin).
```json
{ "username": "Notch" }
```

### `GET /`
Health check. Returns `{"status": "ok"}`.

---

## Using in DiamondFire

In your DiamondFire plot, use the **Get Web Response** block:
- **URL**: `https://your-server-url.railway.app/skin`
- **Content body**: `{"username": "%default"}` (or however you pass the player name)

The response will be a dictionary. Access texture values like:
```
response["json"]["parts"]["head"]["textureValue"]
response["json"]["parts"]["rarm_top"]["textureValue"]
```
etc.

Use these texture values with the **Get Player Head** block (or equivalent) to get the actual head items, then place/resize them to reconstruct the character.

---

## Notes

- **Caching**: Results are cached for 1 hour per username. The first request for a player takes ~20-30 seconds (11 Mineskin uploads with delays). Subsequent requests return instantly.
- **Slim arms**: If a player uses the slim skin model, their arm regions will have a 1px black column on the edge. This is intentional to keep reconstruction logic uniform.
- **Rate limits**: Mineskin's free tier allows roughly 1 upload every 1.5 seconds. The server has a built-in 1.5s delay between uploads to stay within limits.
- **Mineskin API key**: For faster generation, you can register at [mineskin.org](https://mineskin.org) and add your API key as an `Authorization` header in the upload request in `server.js`.
