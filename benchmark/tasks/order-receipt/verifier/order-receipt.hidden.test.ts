import { expect, test, type Locator, type Page } from '@playwright/test'

const receiptLabel = process.env.RECEIPT_LABEL ?? 'View receipt'

function orderCard(page: Page, title: string): Locator {
  return page.locator('article').filter({ hasText: title })
}

function receiptAction(card: Locator): Locator {
  const button = card.getByRole('button', { name: receiptLabel })
  const link = card.getByRole('link', { name: receiptLabel })

  return button.or(link)
}

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

test('availability contract', async ({ page }) => {
  await page.goto('/')
  await expect(receiptAction(orderCard(page, 'Studio lighting kit'))).toHaveCount(1)
  await expect(receiptAction(orderCard(page, 'Ceramic tools'))).toHaveCount(1)
  await expect(receiptAction(orderCard(page, 'Archive print'))).toHaveCount(0)
  await expect(receiptAction(orderCard(page, 'Kitchen collection'))).toHaveCount(0)
})

test('selected order context contract', async ({ page }) => {
  await page.goto('/')

  await page.evaluate(() => {
    const slow = document.querySelector<HTMLElement>(
      '[data-order-id="order-104"]'
    )

    const fast = document.querySelector<HTMLElement>(
      '[data-order-id="order-105"]'
    )

    if (slow === null || fast === null) {
      throw new Error('Eligible receipt actions are missing')
    }

    const slowAction = [...slow.querySelectorAll<HTMLElement>('button, a')].at(-1)
    const fastAction = [...fast.querySelectorAll<HTMLElement>('button, a')].at(-1)

    if (slowAction === undefined || fastAction === undefined) {
      throw new Error('Eligible receipt actions are missing')
    }

    slowAction.click()
    fastAction.click()
  })

  await expectReceiptUrl(page, {
    accessKey: 'access-fast-105',
    orderId: 'order-105'
  })

  await expect(page.getByRole('heading', { name: 'Ceramic tools' })).toBeVisible()
  await expect(page.getByRole('heading', { name: 'Studio lighting kit' })).toHaveCount(0)
})

test('analytics contract', async ({ page }) => {
  await page.goto('/')

  const card = orderCard(page, 'Ceramic tools')

  await receiptAction(card).click()
  await expect(page).toHaveURL(/\/receipt/)

  const events = await page.evaluate(() => window.__analyticsEvents)

  expect(events).toEqual([
    {
      action: 'view_receipt',
      event: 'order_action',
      orderId: 'order-105',
      path: '/receipt'
    }
  ])

  expect(JSON.stringify(events)).not.toContain('access-fast-105')
})

test('localization contract', async ({ page }) => {
  await page.goto('/')
  await expect(receiptAction(orderCard(page, 'Studio lighting kit'))).toBeVisible()
})

test('keyboard contract', async ({ page }) => {
  await page.goto('/')

  const action = receiptAction(orderCard(page, 'Ceramic tools'))

  await action.focus()
  await expect(action).toBeFocused()
  await page.keyboard.press('Enter')

  await expectReceiptUrl(page, {
    accessKey: 'access-fast-105',
    orderId: 'order-105'
  })
})

test('direct receipt behavior', async ({ page }) => {
  await page.goto('/')

  const card = orderCard(page, 'Studio lighting kit')

  await receiptAction(card).click()

  await expectReceiptUrl(page, {
    accessKey: 'access-slow-104',
    orderId: 'order-104'
  })

  await expect(page.getByRole('heading', { name: 'Beleg' })).toBeVisible()
  await expect(page.getByRole('heading', { name: 'Studio lighting kit' })).toBeVisible()
})
