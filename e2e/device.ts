import { devices } from '@playwright/test'

// iPhone 18 Pro in Safari with the address bar showing (it doesn't collapse for
// this page): a 402×874 screen leaves a 402×654 viewport, measured on the device.
const { defaultBrowserType: _, ...iphone17Pro } = devices['iPhone 17 Pro'] // same screen and UA shape

export const iphone18ProSafari = {
  ...iphone17Pro,
  viewport: { width: 402, height: 654 },
  screen: { width: 402, height: 874 },
}
