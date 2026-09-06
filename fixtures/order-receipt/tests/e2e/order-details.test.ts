import { expect, test } from '@playwright/test'

test('opens details for the selected available order and records a public path', async ({ page }) => {
  await page.goto('/')

  const card = page.locator('article').filter({ hasText: 'Ceramic tools' })

  await card.getByRole('button', { name: 'View details' }).click()
  await expect(page).toHaveURL(/\/details\?access_key=access-fast-105&order=order-105/)
  await expect(page.getByRole('heading', { name: 'Ceramic tools' })).toBeVisible()

  const events = await page.evaluate(() => window.__analyticsEvents)

  expect(events).toEqual([
    {
      action: 'view_details',
      event: 'order_action',
      orderId: 'order-105',
      path: '/details'
    }
  ])
})

test('shows actions only for available orders with access keys', async ({ page }) => {
  await page.goto('/')
  await expect(page.getByRole('button', { name: 'View details' })).toHaveCount(2)

  await expect(
    page.locator('article').filter({ hasText: 'Archive print' }).getByRole('button')
  ).toHaveCount(0)

  await expect(
    page.locator('article').filter({ hasText: 'Kitchen collection' }).getByRole('button')
  ).toHaveCount(0)
})
