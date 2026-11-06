import { Transcript } from './transcript.js'

const CHECKOUT_DIFF = `diff --git a/src/checkout/payment.ts b/src/checkout/payment.ts
@@ -41,9 +41,15 @@ export async function capture(order: Order): Promise<Receipt> {
-  const charge = await gateway.charge(order.total, order.card)
-  if (charge.status !== 'succeeded') {
-    throw new PaymentError(charge.declineCode)
-  }
+  const charge = await withRetry(() => gateway.charge(order.total, order.card), {
+    attempts: 3,
+    retryOn: (error) => error instanceof GatewayTimeout,
+  })
+  if (charge.status === 'requires_action') {
+    return { state: 'pending', next: charge.nextAction }
+  }
+  if (charge.status !== 'succeeded') {
+    throw new PaymentError(charge.declineCode)
+  }
   return receiptOf(order, charge)`

const CHECKOUT_SUMMARY_DIFF = `-  const charge = await gateway.charge(order.total, order.card)
+  const charge = await withRetry(() => gateway.charge(order.total, order.card), {
+    attempts: 3,
+    retryOn: (error) => error instanceof GatewayTimeout,
+  })
+  if (charge.status === 'requires_action') {
+    return { state: 'pending', next: charge.nextAction }
+  }`

/** Retries card captures; mid-turn, with a linked PR, a diff and green tests. */
export function checkoutTranscript(): Transcript {
  return new Transcript('checkout')
    .prompt('Card captures fail when the gateway times out. Retry them, keep 3-D Secure working, and open a PR.')
    .say('I will start with the capture path and the gateway client.')
    .tool('Read', { file_path: 'src/checkout/payment.ts' }, 'export async function capture(order: Order) {...}')
    .tool('Grep', { pattern: 'GatewayTimeout', path: 'src' }, 'src/gateway/errors.ts\nsrc/gateway/client.ts')
    .tool(
      'Edit',
      { file_path: 'src/checkout/payment.ts', old_string: 'gateway.charge(', new_string: 'withRetry(' },
      'The file src/checkout/payment.ts has been updated.',
    )
    .bash('git diff src/checkout/payment.ts', CHECKOUT_DIFF, 'Show the change')
    .bash(
      'pnpm vitest run src/checkout',
      ' \u2713 src/checkout/payment.test.ts (14 tests) 212ms\n \u2713 src/checkout/3ds.test.ts (6 tests) 98ms\n\n Test Files  2 passed (2)\n      Tests  20 passed (20)',
      'Run the checkout tests',
    )
    .bash(
      'gh pr create --title "fix(checkout): retry card captures on gateway timeouts"',
      'https://github.com/acme/storefront/pull/482',
      'Open the pull request',
    )
    .say(
      `Captures now retry up to three times on a gateway timeout, and a \`requires_action\` charge returns a pending receipt, so 3-D Secure still works.\n\n\`\`\`diff\n${CHECKOUT_SUMMARY_DIFF}\n\`\`\`\n\nAll 20 checkout tests pass. I opened **#482** and will follow its CI and reviews.`,
    )
    .done(9, 1.12)
    .prompt('The review asks for a test of the third attempt failing. Add it.')
    .say('Adding a test where all three attempts time out.')
    .tool(
      'Edit',
      { file_path: 'src/checkout/payment.test.ts', old_string: 'describe(', new_string: 'describe(' },
      'The file src/checkout/payment.test.ts has been updated.',
    )
    .bash('pnpm vitest run src/checkout/payment.test.ts', null, 'Run the payment tests')
}

const CLIENTS = 'toolu_orders_clients'

/** Paginates the orders endpoint, with a todo list and a background subagent at work. */
export function ordersTranscript(): Transcript {
  return new Transcript('orders')
    .prompt('GET /v2/orders returns every order at once. Add cursor pagination without breaking v1 clients.')
    .todos([
      ['Read the orders handler and its callers', 'completed'],
      ['Add a cursor to the orders query', 'completed'],
      ['Check every v1 client still parses the response', 'in_progress'],
      ['Document the new parameters in the OpenAPI spec', 'pending'],
    ])
    .tool('Read', { file_path: 'src/routes/orders.ts' }, "router.get('/v2/orders', async (req, res) => {...})")
    .tool(
      'Edit',
      { file_path: 'src/routes/orders.ts', old_string: 'findMany()', new_string: 'findMany({ cursor, take })' },
      'The file src/routes/orders.ts has been updated.',
    )
    .bash(
      'pnpm test -- orders',
      'PASS  test/orders.test.ts\n  orders pagination\n    \u2713 returns the first page with a next cursor\n    \u2713 returns an empty page past the end\n    \u2713 rejects a malformed cursor with 400\n\nTests: 3 passed, 3 total',
      'Run the orders tests',
    )
    .say('The cursor works. A subagent checks the v1 clients while I write the spec.')
    .subagent(CLIENTS, 'Check v1 clients parse paged orders', 7)
    .reported(CLIENTS, 7, 'All four v1 clients ignore unknown fields, so `next_cursor` breaks none of them.')
    .say('The v1 clients are safe. Writing the OpenAPI parameters now.')
    .tool('Edit', { file_path: 'openapi/orders.yaml', old_string: 'parameters: []', new_string: 'parameters:' }, null)
}

export const INFRA_COMMAND = 'terraform apply -target=module.postgres -var-file=staging.tfvars'

/** Upgrades Postgres on staging and waits on the user to allow the apply. */
export function infraTranscript(): Transcript {
  return new Transcript('infra')
    .prompt('Upgrade the staging database to Postgres 17. Plan first and show me the plan.')
    .bash('terraform -chdir=envs/staging init -upgrade', 'Terraform has been successfully initialized!', 'Init')
    .tool(
      'Edit',
      {
        file_path: 'modules/postgres/main.tf',
        old_string: 'engine_version = "16.4"',
        new_string: 'engine_version = "17.2"',
      },
      'The file modules/postgres/main.tf has been updated.',
    )
    .bash(
      'terraform plan -target=module.postgres -var-file=staging.tfvars',
      '  # module.postgres.aws_db_instance.main will be updated in-place\n  ~ resource "aws_db_instance" "main" {\n      ~ engine_version = "16.4" -> "17.2"\n        id             = "acme-staging"\n    }\n\nPlan: 0 to add, 1 to change, 0 to destroy.',
      'Plan the upgrade',
    )
    .say(
      'The plan changes one resource in place: `engine_version` goes from 16.4 to 17.2, with no replacement. A snapshot from 06:00 today covers a rollback.\n\nApplying now.',
    )
    .tool('Bash', { command: INFRA_COMMAND, description: 'Apply the upgrade' }, null)
}

const CART_QUESTION =
  'I found why the cart test flakes: the price badge renders before the currency loads, so the assertion races it.\n\nTwo fixes work:\n\n1. Wait for the currency in the test. Small, but hides the flash users see.\n2. Render the badge only once the currency is known. Fixes the flash too, and touches 3 components.\n\nWhich do you want?'

/** Found a flaky test's cause and asks the user which fix to take. */
export function cartTranscript(): Transcript {
  return new Transcript('cart')
    .prompt('cart.spec.ts fails about one run in ten on CI. Find out why.')
    .bash(
      'pnpm playwright test cart.spec.ts --repeat-each=20',
      '  18 passed\n  2 failed\n    cart.spec.ts:41 shows the total in the shop currency\n      Expected: "\u20ac42.00"\n      Received: "42.00"',
      'Repeat the cart test 20 times',
    )
    .tool('Grep', { pattern: 'useCurrency', path: 'src/cart' }, 'src/cart/PriceBadge.tsx\nsrc/cart/Total.tsx')
    .tool('Read', { file_path: 'src/cart/PriceBadge.tsx' }, 'export function PriceBadge({ amount }) {...}')
    .say(CART_QUESTION)
    .done(6, 0.41)
}

/** Writes a migration guide into the docs folder the Files panel shows. */
export function guideTranscript(): Transcript {
  return new Transcript('guide')
    .prompt('Write a migration guide from API v1 to v2 for our partners, and a one-page PDF summary.')
    .tool('Read', { file_path: 'openapi/v2.yaml' }, 'openapi: 3.1.0 ...')
    .tool('Write', { file_path: 'docs/migration-v2.md', content: '# Migrating to API v2' }, 'File created.')
    .bash('pandoc docs/migration-v2.md -o docs/migration-v2.pdf', '', 'Render the PDF summary')
    .say('The guide is in `docs/migration-v2.md`, with the PDF summary beside it.')
    .done(5, 0.38)
}
