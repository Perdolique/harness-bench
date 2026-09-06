import { expect, test, type Page } from '@playwright/test'

async function expectReceiptUrl(
  page: Page,
  expected: { readonly accessKey: string; readonly orderId: string }
): Promise<void> {
  await expect.poll(() => {
    const url = new URL(page.url())

    return {
      accessKey: url.searchParams.get('access_key'),
      orderId: url.searchParams.get('order'),
      pathname: url.pathname
    }
  }).toEqual({
    accessKey: expected.accessKey,
    orderId: expected.orderId,
    pathname: '/receipt'
  })
}

test('opens the receipt from the dedicated action component', async ({ page }) => {
  await page.goto('/')

  const card = page.locator('article').filter({ hasText: 'Studio lighting kit' })

  await card.getByRole('link', { name: 'View receipt' }).click()

  await expectReceiptUrl(page, {
    accessKey: 'access-slow-104',
    orderId: 'order-104'
  })

  await expect(page.getByRole('heading', { name: 'Studio lighting kit' })).toBeVisible()
})
