import { readFile, rm, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'

const workspace = process.env.CALIBRATION_WORKSPACE ?? '/app'
const control = process.argv[2]

async function replaceExact(path, search, replacement) {
  const absolutePath = resolve(workspace, path)
  const source = await readFile(absolutePath, 'utf8')

  if (!source.includes(search)) {
    throw new Error(`Control ${control} could not find its target in ${path}`)
  }

  await writeFile(absolutePath, source.replace(search, replacement))
}

switch (control) {
  case 'wrong-order':
    await replaceExact(
      'src/pages/OrderHistoryPage.vue',
      `    query: {
      access_key: order.accessKey,
      order: order.id
    }`,
      `    query: {
      access_key: 'access-slow-104',
      order: 'order-104'
    }`
    )

    break

  case 'missing-navigation-key':
    await replaceExact(
      'src/pages/OrderHistoryPage.vue',
      `    query: {
      access_key: order.accessKey,
      order: order.id
    }`,
      `    query: {
      order: order.id
    }`
    )

    break

  case 'ineligible-action':
    await replaceExact(
      'src/components/OrderCard.vue',
      '() => props.order.status === \'available\' && props.order.accessKey !== null',
      '() => true'
    )

    break

  case 'stale-selection':
    await replaceExact(
      'src/stores/orders.ts',
      `    if (currentVersion !== selectionVersion) {
      return false
    }
`,
      ''
    )

    break

  case 'missing-analytics':
    await replaceExact(
      'src/pages/OrderHistoryPage.vue',
      '  trackOrderAction({',
      '  false && trackOrderAction({'
    )

    break

  case 'duplicate-analytics':
    await replaceExact(
      'src/pages/OrderHistoryPage.vue',
      `  trackOrderAction({
    action: destination === '/details' ? 'view_details' : 'view_receipt',
    event: 'order_action',
    orderId: order.id,
    path: destination
  })`,
      `  trackOrderAction({
    action: destination === '/details' ? 'view_details' : 'view_receipt',
    event: 'order_action',
    orderId: order.id,
    path: destination
  })
  trackOrderAction({
    action: destination === '/details' ? 'view_details' : 'view_receipt',
    event: 'order_action',
    orderId: order.id,
    path: destination
  })`
    )

    break

  case 'access-key-in-analytics':
    await replaceExact(
      'src/pages/OrderHistoryPage.vue',
      'path: destination',
      'path: `${destination}?access_key=${order.accessKey}` as \'/receipt\''
    )

    break

  case 'hardcoded-copy':
    await replaceExact(
      'src/components/OrderCard.vue',
      '{{ t(\'order.viewReceipt\') }}',
      'View receipt'
    )

    await replaceExact('src/locales/en.ts', ',\n    viewReceipt: \'View receipt\'', '')

    break

  case 'keyboard-inaccessible':
    await replaceExact(
      'src/components/OrderCard.vue',
      `<button type="button" @click="viewReceipt">
        {{ t('order.viewReceipt') }}
      </button>`,
      `<div @click="viewReceipt">
        {{ t('order.viewReceipt') }}
      </div>`
    )

    break

  case 'candidate-tests-deleted':
    await rm(resolve(workspace, 'src/components/OrderCard.receipt.test.ts'))
    await rm(resolve(workspace, 'tests/e2e/order-receipt.test.ts'))

    break

  case 'candidate-unit-trivial':
    await writeFile(
      resolve(workspace, 'src/components/OrderCard.receipt.test.ts'),
      `import { expect, test } from 'vitest'\n\ntest('unrelated truth', () => {\n  expect(true).toBe(true)\n})\n`
    )

    break

  case 'regression-disabled':
    await rm(resolve(workspace, 'src/components/OrderCard.test.ts'))

    break

  case 'dependency-churn': {
    const path = resolve(workspace, 'package.json')
    const manifest = JSON.parse(await readFile(path, 'utf8'))

    manifest.dependencies['left-pad'] = '1.3.0'

    await writeFile(path, `${JSON.stringify(manifest, null, 2)}\n`)

    break
  }

  default:
    throw new Error(`Unknown negative control: ${control}`)
}
