"""Generate the README banner (light + dark SVG) from the PIN AI logo.

    python3 .github/assets/make_banner.py apps/web/src/assets/pin-ai-logo.svg .github/assets

Then export the 2x PNGs that README.md references (fonts render consistently
across platforms in PNG, unlike text inside an SVG <img>):

    for t in light dark; do
      "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" --headless=new \
        --hide-scrollbars --force-device-scale-factor=2 --window-size=1280,400 \
        --default-background-color=00000000 \
        --screenshot=.github/assets/banner-$t.png "file://$PWD/.github/assets/banner-$t.svg"
    done
    # then: pngquant --quality=95-100 --speed 1 --force --output <png> <png>  (lower quality bands the glow)
"""
import re
import sys
from pathlib import Path

LOGO = Path(sys.argv[1]).read_text()
OUT = Path(sys.argv[2])
PATH_D = re.search(r' d="([^"]+)"', LOGO).group(1)
FONT = "Inter, -apple-system, 'SF Pro Display', 'Segoe UI', Helvetica, Arial, sans-serif"

THEMES = {
    "light": dict(bg="#F2F4F8", fg="#1D2133", muted="#6B7385", glow_a=0.30, glow_b=0.22,
                  card="#FFFFFF", card_op=0.78, card_stroke="#FFFFFF", stroke_op=0.9,
                  pill_stroke="#D9DEE8", shadow="#7A4D8C", shadow_op=0.12),
    "dark": dict(bg="#11131F", fg="#F4F5FA", muted="#9AA1B5", glow_a=0.45, glow_b=0.30,
                 card="#FFFFFF", card_op=0.07, card_stroke="#FFFFFF", stroke_op=0.14,
                 pill_stroke="#2C3045", shadow="#000000", shadow_op=0.45),
}

CARDS = [  # (dot color, title, detail)
    ("#4FC97A", "Your 6:40 PM flight is delayed 45 min", "Leave 30 min later?  ·  Calendar + Gmail"),
    ("#E8A33A", "3 emails need a reply today", "Drafts ready for review  ·  Gmail"),
    ("#D35CE8", "You slept 5h 10m last night", "Move tomorrow's 7 AM run?  ·  Health"),
]
PILLS = ["Proactive cards", "Lifelong memory", "Agent with tools"]


def banner(t):
    s = []
    s.append(f'<svg xmlns="http://www.w3.org/2000/svg" width="1280" height="400" viewBox="0 0 1280 400" font-family="{FONT}">')
    s.append(f'''<defs>
  <linearGradient id="brand" x1="0" y1="0" x2="1" y2="1">
    <stop offset="0" stop-color="hsl(292 78% 63%)"/><stop offset="1" stop-color="hsl(330 80% 65%)"/>
  </linearGradient>
  <radialGradient id="glowA" cx="0.5" cy="0.5" r="0.5">
    <stop offset="0" stop-color="hsl(292 78% 63%)" stop-opacity="{t['glow_a']}"/><stop offset="1" stop-color="hsl(292 78% 63%)" stop-opacity="0"/>
  </radialGradient>
  <radialGradient id="glowB" cx="0.5" cy="0.5" r="0.5">
    <stop offset="0" stop-color="hsl(330 80% 65%)" stop-opacity="{t['glow_b']}"/><stop offset="1" stop-color="hsl(330 80% 65%)" stop-opacity="0"/>
  </radialGradient>
  <clipPath id="frame"><rect width="1280" height="400" rx="24"/></clipPath>
  <filter id="shadow" x="-20%" y="-30%" width="140%" height="180%">
    <feDropShadow dx="0" dy="10" stdDeviation="14" flood-color="{t['shadow']}" flood-opacity="{t['shadow_op']}"/>
  </filter>
</defs>''')
    s.append('<g clip-path="url(#frame)">')
    s.append(f'<rect width="1280" height="400" fill="{t["bg"]}"/>')
    s.append('<ellipse cx="1010" cy="120" rx="420" ry="260" fill="url(#glowA)"/>')
    s.append('<ellipse cx="170" cy="380" rx="360" ry="220" fill="url(#glowB)"/>')
    # logo mark: original viewBox 162..862 (700 units) -> 168 px
    k = 168 / 700
    s.append(f'<g transform="translate(88 116) scale({k:.6f}) translate(-162 -162)"><path fill-rule="evenodd" clip-rule="evenodd" d="{PATH_D}" fill="url(#brand)"/></g>')
    s.append(f'<text x="296" y="190" font-size="80" font-weight="800" letter-spacing="-2" fill="{t["fg"]}">PIN AI</text>')
    s.append(f'<text x="300" y="236" font-size="25" font-weight="500" fill="{t["muted"]}">The proactive personal AI that acts before you ask.</text>')
    x = 300
    for p in PILLS:
        w = 18 + len(p) * 8.6
        s.append(f'<rect x="{x}" y="262" width="{w:.0f}" height="32" rx="16" fill="none" stroke="{t["pill_stroke"]}" stroke-width="1.5"/>')
        s.append(f'<text x="{x + w / 2:.0f}" y="283" font-size="14" font-weight="600" text-anchor="middle" fill="{t["muted"]}">{p}</text>')
        x += w + 10
    # proactive cards, slightly fanned
    for i, (dot, title, detail) in enumerate(CARDS):
        cx, cy, rot = 872 + i * 16, 66 + i * 92, (-1.6, 0.6, -0.9)[i]
        s.append(f'<g transform="rotate({rot} {cx + 180} {cy + 38})" filter="url(#shadow)">')
        s.append(f'<rect x="{cx}" y="{cy}" width="360" height="76" rx="18" fill="{t["card"]}" fill-opacity="{t["card_op"]}" stroke="{t["card_stroke"]}" stroke-opacity="{t["stroke_op"]}"/>')
        s.append(f'<circle cx="{cx + 28}" cy="{cy + 38}" r="7" fill="{dot}"/>')
        s.append(f'<text x="{cx + 48}" y="{cy + 33}" font-size="16" font-weight="700" fill="{t["fg"]}">{title}</text>')
        s.append(f'<text x="{cx + 48}" y="{cy + 55}" font-size="13" font-weight="500" fill="{t["muted"]}">{detail}</text>')
        s.append('</g>')
    s.append('</g></svg>')
    return "\n".join(s)


for name, t in THEMES.items():
    (OUT / f"banner-{name}.svg").write_text(banner(t))
    print("wrote", OUT / f"banner-{name}.svg")
