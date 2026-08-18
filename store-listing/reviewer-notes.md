# Reviewer Notes

Save Image As requires no account, login, payment, subscription, external service, or special test credentials.

## Primary Test

1. Open a normal HTTPS webpage containing a raster image.
2. Right-click the image.
3. Open **Save image as** and select PNG, JPG, or WebP.
4. Confirm that the browser downloads a converted file in the chosen format.
5. Open the extension popup and select **Open settings**.
6. Change JPG or WebP quality, or toggle the Save As dialog, then repeat the conversion.

## Expected Behavior

- PNG and WebP preserve transparency when supported by the source.
- JPG fills transparent pixels with white.
- Browser-internal pages such as `chrome://` and `edge://` are intentionally excluded because extensions cannot access them.
- Some sites can prevent conversion through browser security or canvas restrictions; the extension reports the failure through its temporary toolbar badge.
- Animated sources are exported as a static frame.

## Privacy and Network Behavior

All conversion logic is included in the package. The extension has no developer-operated backend, analytics, remote code, advertising, or tracking. Network requests are limited to retrieving the image explicitly selected by the user from its existing source URL.
