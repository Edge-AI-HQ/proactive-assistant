"""Wrap README screenshots in a macOS window / iPhone frame with transparent corners.

    python3 .github/assets/frame_screenshots.py <web.png 1440x900@2x> <ios.png 402x874@3x> <out_dir>

Needs Playwright (Python) and Google Chrome. Writes framed-web.png and
framed-ios.png; compress them with
    pngquant --quality=85-98 --speed 1 --force --output <png> <png>
and save as screenshot-desktop.png / screenshot-ios.png next to this script.
"""
import asyncio
import base64
import sys
from pathlib import Path

from playwright.async_api import async_playwright

WEB, IOS, OUT = Path(sys.argv[1]), Path(sys.argv[2]), Path(sys.argv[3])
uri = lambda p: "data:image/png;base64," + base64.b64encode(p.read_bytes()).decode()
FONT = "-apple-system, BlinkMacSystemFont, 'SF Pro Text', 'Segoe UI', Helvetica, Arial, sans-serif"

MAC = f"""<html><body style="margin:0;background:transparent">
<div id="shot" style="padding:72px;display:inline-block">
  <div style="width:1440px;border-radius:14px;overflow:hidden;background:#fff;
              box-shadow:0 18px 40px rgba(40,20,70,.22),0 0 0 .5px rgba(0,0,0,.22)">
    <div style="position:relative;height:34px;background:linear-gradient(#f7f6f9,#eceaf0);
                border-bottom:1px solid rgba(0,0,0,.08);font:600 13px {FONT};color:#55535e;
                display:flex;align-items:center;justify-content:center">
      <div style="position:absolute;left:16px;top:11px;display:flex;gap:8px">
        <span style="width:12px;height:12px;border-radius:50%;background:#ff5f57;box-shadow:inset 0 0 0 .5px #e0443e"></span>
        <span style="width:12px;height:12px;border-radius:50%;background:#febc2e;box-shadow:inset 0 0 0 .5px #dea123"></span>
        <span style="width:12px;height:12px;border-radius:50%;background:#28c840;box-shadow:inset 0 0 0 .5px #1aab29"></span>
      </div>
      PIN AI
    </div>
    <img src="{uri(WEB)}" style="display:block;width:1440px;height:900px">
  </div>
</div></body></html>"""

BTN = "position:absolute;width:4px;border-radius:2px;background:linear-gradient(90deg,#2b2c33,#17181d)"
PHONE = f"""<html><body style="margin:0;background:transparent">
<div id="shot" style="padding:64px;display:inline-block">
  <div style="position:relative;width:402px;height:874px;padding:13px;border-radius:69px;
              background:linear-gradient(145deg,#2f3037,#0e0f13 40%,#1b1c22);
              box-shadow:0 16px 36px rgba(40,20,70,.26),inset 0 0 0 1.5px #3a3b43,inset 0 0 0 4px #0b0b0e">
    <span style="{BTN};left:-4px;top:150px;height:30px"></span>
    <span style="{BTN};left:-4px;top:205px;height:58px"></span>
    <span style="{BTN};left:-4px;top:275px;height:58px"></span>
    <span style="{BTN};right:-4px;top:230px;height:92px;transform:scaleX(-1)"></span>
    <div style="width:402px;height:874px;border-radius:56px;overflow:hidden;background:#000">
      <img src="{uri(IOS)}" style="display:block;width:402px;height:874px">
    </div>
  </div>
</div></body></html>"""


async def render(p, html, path, scale):
    browser = await p.chromium.launch(channel="chrome", headless=True)
    page = await browser.new_page(device_scale_factor=scale, viewport={"width": 1700, "height": 1200})
    await page.set_content(html)
    await page.locator("#shot").screenshot(path=str(path), omit_background=True)
    await browser.close()
    print("saved", path)


async def main():
    async with async_playwright() as p:
        await render(p, MAC, OUT / "framed-web.png", 1)
        await render(p, PHONE, OUT / "framed-ios.png", 1.25)


asyncio.run(main())
