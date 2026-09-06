import { expect, test } from '@playwright/test'

test('opens the receipt for the activated order', async ({ page }) => {
  await page.goto('/')

  const card = page.locator('article').filter({ hasText: 'Ceramic tools' })

  await card.getByRole('button', { name: 'View receipt' }).click()
  await expect(page).toHaveURL(/\/receipt\?access_key=access-fast-105&order=order-105/)
  await expect(page.getByRole('heading', { name: 'Ceramic tools' })).toBeVisible()
})
