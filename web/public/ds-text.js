// The game's fonts on a canvas (exported by tools/export_starter_assets.py): a sheet of glyphs and
// their metrics { cellWidth, cellHeight, chars: { ch: [index, left, width, advance] } }. A font is
// { m: metrics, image, tints: {} }; a line of text is a list of [text, tint] runs.

// The font sheet stores each glyph pixel's colour index in its red channel: recolour it once per tint.
function tintSheet(font, tint) {
  const key = JSON.stringify(tint);
  if (font.tints[key]) return font.tints[key];
  const c = document.createElement("canvas");
  c.width = font.image.width;
  c.height = font.image.height;
  const g = c.getContext("2d");
  g.drawImage(font.image, 0, 0);
  const data = g.getImageData(0, 0, c.width, c.height);
  for (let i = 0; i < data.data.length; i += 4) {
    const rgb = tint[data.data[i]];
    if (data.data[i + 3] && rgb) [data.data[i], data.data[i + 1], data.data[i + 2]] = rgb;
    else data.data[i + 3] = 0;
  }
  g.putImageData(data, 0, 0);
  return (font.tints[key] = c);
}

export const textWidth = (font, text) =>
  [...text].reduce((w, ch) => w + (font.m.chars[ch]?.[3] ?? font.m.chars[" "][3]), 0);

// Draws one line made of [text, tint] runs with its top at y: centred on x, or starting at x.
export function drawText(ctx, font, runs, x, y, align = "center") {
  let cx = align === "center" ? Math.round(x - runs.reduce((w, [t]) => w + textWidth(font, t), 0) / 2) : Math.round(x);
  const { cellWidth: cw, cellHeight: ch } = font.m;
  for (const [text, tint] of runs) {
    const sheet = tintSheet(font, tint);
    for (const c of text) {
      const glyph = font.m.chars[c] ?? font.m.chars[" "];
      const [index, left, , advance] = glyph;
      ctx.drawImage(sheet, index * cw, 0, cw, ch, cx + left, y, cw, ch);
      cx += advance;
    }
  }
}
