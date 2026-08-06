from pathlib import Path
from PIL import Image

ROOT = Path(__file__).resolve().parents[1]
SOURCE = ROOT / "app" / "assets" / "icon-atlas.png"
OUTPUT = ROOT / "app" / "assets" / "icons"
NAMES = [
    "image", "video", "audio", "folder",
    "play", "history", "settings", "lock",
    "trash", "drag", "sparkle", "slot",
]

atlas = Image.open(SOURCE).convert("RGBA")
cell_width = atlas.width // 4
cell_height = atlas.height // 3
OUTPUT.mkdir(parents=True, exist_ok=True)

for index, name in enumerate(NAMES):
    column = index % 4
    row = index // 4
    cell = atlas.crop((
        column * cell_width,
        row * cell_height,
        (column + 1) * cell_width,
        (row + 1) * cell_height,
    ))
    alpha_box = cell.getchannel("A").getbbox()
    if alpha_box is None:
        raise RuntimeError(f"Icon cell is empty: {name}")
    left, top, right, bottom = alpha_box
    padding = 8
    cell = cell.crop((
        max(0, left - padding),
        max(0, top - padding),
        min(cell.width, right + padding),
        min(cell.height, bottom + padding),
    ))
    scale = min(288 / cell.width, 288 / cell.height)
    resized = cell.resize((max(1, round(cell.width * scale)), max(1, round(cell.height * scale))), Image.Resampling.LANCZOS)
    canvas = Image.new("RGBA", (320, 320), (0, 0, 0, 0))
    canvas.alpha_composite(resized, ((320 - resized.width) // 2, (320 - resized.height) // 2))
    canvas.save(OUTPUT / f"{name}.png", optimize=True)

print(f"Wrote {len(NAMES)} icons to {OUTPUT}")
