import { chromium } from 'playwright-core'

const browser = await chromium.connectOverCDP('http://127.0.0.1:9356')
const pages = browser.contexts().flatMap((context) => context.pages())
const result = []
for (const [index, page] of pages.entries()) {
  result.push({ index, url: page.url(), title: await page.title() })
}
console.log(JSON.stringify(result, null, 2))
process.exit(0)
