# Save Image As

A Chrome extension that lets you right-click any image and save a converted copy as PNG, JPG, or WebP.

## Suggested Repo Name

`save-image-as`

## Suggested Repo Description

Chrome extension for saving web images as PNG, JPG, or WebP from the right-click menu.

## Why This Exists

Browsers let you save images, but they usually do not let you quickly change formats at save time. This extension adds that missing step directly to the image context menu so you can export a converted copy without opening an editor first.

## Features

- Adds a `Save image as` submenu to Chrome's right-click image menu
- Converts images to `PNG`, `JPG`, or `WebP`
- Preserves transparency for PNG and WebP where supported
- Fills transparent regions with white when exporting to JPG
- Includes adjustable JPG and WebP quality settings
- Supports a fallback path for page-scoped images such as some `blob:` URLs
- Uses Manifest V3 and Chrome best practices for permissions and downloads

## Supported Formats

### Included

- `PNG`: best for lossless output, screenshots, graphics, and transparent images
- `JPG`: best for photos and smaller general-purpose files
- `WebP`: best for modern web-focused compression and often smaller downloads

### Not Included By Default

- `GIF`: exporting would usually flatten animated images into a single frame
- `BMP`: large files with little practical benefit for browser workflows
- `TIFF`: not a common browser export target and encoder support is less predictable
- `AVIF`: promising, but browser-based encoding support is still less consistent for a reliable default experience

## How It Works

The extension uses a Manifest V3 service worker to handle context menu actions and downloads. For standard image URLs it fetches the source, decodes it, renders it to an offscreen canvas, converts it to the selected format, and downloads the result. For page-scoped sources such as `blob:` URLs, it falls back to page-context conversion when possible.

## Project Structure

- [manifest.json](C:/Users/takimberlin/Desktop/save%20image%20as/manifest.json): extension manifest and permissions
- [service-worker.js](C:/Users/takimberlin/Desktop/save%20image%20as/service-worker.js): context menu, conversion, fallback, and download logic
- [options.html](C:/Users/takimberlin/Desktop/save%20image%20as/options.html): settings page UI
- [options.js](C:/Users/takimberlin/Desktop/save%20image%20as/options.js): settings persistence and form behavior
- [popup.html](C:/Users/takimberlin/Desktop/save%20image%20as/popup.html): lightweight popup UI

## Installation

1. Open Chrome and go to `chrome://extensions`.
2. Turn on **Developer mode**.
3. Click **Load unpacked**.
4. Select this project folder:
   `C:\Users\takimberlin\Desktop\save image as`

## Usage

1. Open a page with an image.
2. Right-click the image.
3. Choose `Save image as`.
4. Select `PNG`, `JPG`, or `WebP`.
5. Save the converted file.

## Settings

The extension includes an options page where you can:

- Set JPG quality
- Set WebP quality
- Choose whether Chrome should show the Save As dialog before download

## Testing

### Basic Manual Test

1. Load the unpacked extension.
2. Visit a page with a normal image file.
3. Right-click the image and export it as each supported format.
4. Open the downloaded files and confirm they render correctly.

### Recommended Test Cases

1. Convert a transparent PNG to JPG and confirm transparent areas become white.
2. Convert a JPG photo to PNG and confirm the image dimensions stay the same.
3. Convert a large image to WebP and compare file size with PNG and JPG outputs.
4. Lower JPG and WebP quality in settings and confirm file size changes.
5. Test with images from different sites to exercise cross-origin cases.
6. Test on a page that uses `blob:` image URLs and confirm the fallback path works.

## Privacy

This extension does not require a backend service. Image conversion happens in the browser, and user settings are stored with Chrome storage.

## Limitations

- The extension is intended for images available through the browser image context menu
- Some sites may block access to images in ways that prevent reliable conversion
- Page-generated or rapidly changing image elements can be harder to capture
- Animated images are treated as static single-frame exports

## Development Notes

- Built with Manifest V3
- Uses `createImageBitmap` and `OffscreenCanvas` for the main conversion path
- Uses `chrome.downloads` for file saving
- Uses `chrome.storage.sync` for settings

## License

Choose the license you want for the repo before publishing, for example `MIT`.
