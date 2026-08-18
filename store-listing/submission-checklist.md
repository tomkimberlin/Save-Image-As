# Store Submission Checklist

## Shared

- [ ] Merge the store-readiness pull request to `main`.
- [ ] Confirm `manifest.json` and `manifest.firefox.json` use the same version.
- [ ] Test PNG, JPG, and WebP conversion from the packaged builds.
- [ ] Confirm the privacy-policy URL is publicly accessible after merge.
- [ ] Use the listing copy and permission answers in this directory.
- [ ] Use a monitored support email in each publisher account.

## Chrome Web Store

- [ ] Register the developer account, pay the one-time fee, and enable 2-Step Verification.
- [ ] Upload the Chromium ZIP with `manifest.json` at the archive root.
- [ ] Upload `assets/icon-128-store.png` as the store icon if the dashboard requests it separately.
- [ ] Upload `assets/promo-small-440x280.png`.
- [ ] Upload the 1280×800 screenshots.
- [ ] Select public visibility and the desired regions.
- [ ] Complete the privacy declarations using `privacy-and-permissions.md`.
- [ ] Add the homepage, support, and privacy URLs from `listing-copy.md`.
- [ ] Paste `reviewer-notes.md` where reviewer guidance is available.
- [ ] Submit for review.

## Microsoft Edge Add-ons

- [ ] Register and verify an individual Microsoft Edge developer account in Partner Center.
- [ ] Upload the same Chromium ZIP.
- [ ] Select public visibility and all desired markets.
- [ ] Select the Tools category or closest equivalent.
- [ ] Upload `assets/logo-300.png`, the promotional tile, and screenshots.
- [ ] Complete the privacy declarations using `privacy-and-permissions.md`.
- [ ] Add the homepage, support, and privacy URLs.
- [ ] Add the seven search terms from `listing-copy.md`.
- [ ] Paste the reviewer notes and submit for certification.

## Firefox Add-ons

- [ ] Sign in to the AMO Developer Hub with a Mozilla account.
- [ ] Choose **On this site** for a public AMO listing.
- [ ] Upload the Firefox ZIP produced from `dist/firefox`.
- [ ] Select desktop Firefox as the supported platform.
- [ ] State that no separate source package is required because shipped JavaScript is readable and unminified.
- [ ] Add the summary, detailed description, categories, support email, support URL, license, and privacy-policy URL.
- [ ] Paste the reviewer notes and submit the version.
