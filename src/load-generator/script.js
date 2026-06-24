// Copyright The OpenTelemetry Authors
// SPDX-License-Identifier: Apache-2.0

import http from 'k6/http'
import { sleep } from 'k6'
import { browser } from 'k6/browser'
import { Tracer } from 'k6/x/otel'

const BASE_URL = __ENV.LOCUST_HOST || 'http://frontend-proxy:8080'
const FLAGD_HOST = __ENV.FLAGD_HOST || 'flagd'
const FLAGD_OFREP_PORT = __ENV.FLAGD_OFREP_PORT || '8016'

export const options = {
    scenarios: {
        load: {
            executor: 'constant-vus',
            exec: 'httpScenario',
            vus: parseInt(__ENV.LOCUST_USERS || '10'),
            duration: __ENV.K6_DURATION || '999h',
        },
        browser: {
            executor: 'constant-vus',
            exec: 'browserScenario',
            vus: 1,
            duration: __ENV.K6_DURATION || '999h',
            options: {
                browser: {
                    type: 'chromium',
                    headless: true,
                    // --no-sandbox and --disable-dev-shm-usage are required when
                    // running Chromium inside a Docker container as root.
                    args: [
                        '--no-sandbox',
                        '--disable-dev-shm-usage',
                        '--disable-gpu',
                        '--disable-setuid-sandbox',
                        '--disable-software-rasterizer',
                    ],
                },
            },
        },
    },
}

const products = [
    '0PUK6V6EV0', '1YMWWN1N4O', '2ZYFJ3GM2N', '66VCHSJNUP', '6E92ZMYYFZ',
    '9SIQT8TOJO', 'L9ECAV7KIM', 'LS4PSXUNUM', 'OLJCESPC7Z', 'HQTGWGPNH4',
]

const categories = ['binoculars', 'telescopes', 'accessories', 'assembly', 'travel', 'books', null]

const people = JSON.parse(open('./people.json'))

const tracer = new Tracer()

// ---- helpers ----------------------------------------------------------------

function randomChoice(arr) {
    return arr[Math.floor(Math.random() * arr.length)]
}

function uuid4() {
    return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, c => {
        const r = (Math.random() * 16) | 0
        return (c === 'x' ? r : (r & 0x3) | 0x8).toString(16)
    })
}

function getFlagdValue(flagName) {
    const res = http.post(
        `http://${FLAGD_HOST}:${FLAGD_OFREP_PORT}/ofrep/v1/evaluate/flags/${flagName}`,
        JSON.stringify({}),
        { headers: { 'Content-Type': 'application/json' }, tags: { flagd: 'true' } }
    )
    if (res.status === 200) {
        return JSON.parse(res.body).value || 0
    }
    return 0
}

// Merges OTel headers (baggage + traceparent) with any extra headers provided.
function otelHeaders(traceParent, extra) {
    return Object.assign(
        {
            baggage: `synthetic_request=true,session.id=${sessionId}`,
            traceparent: traceParent,
        },
        extra
    )
}

// ---- per-VU session state ---------------------------------------------------

let sessionId = null

function onStart() {
    sessionId = uuid4()
    const span = tracer.startSpan('user_session_start')
    http.get(`${BASE_URL}/`, { headers: otelHeaders(span.traceParent()) })
    span.end()
}

// ---- tasks ------------------------------------------------------------------

function index() {
    const span = tracer.startSpan('user_index')
    http.get(`${BASE_URL}/`, { headers: otelHeaders(span.traceParent()) })
    span.end()
}

function browseProduct() {
    const product = randomChoice(products)
    const span = tracer.startSpan('user_browse_product', { 'product.id': product })
    http.get(`${BASE_URL}/api/products/${product}`, { headers: otelHeaders(span.traceParent()) })
    span.end()
}

function getRecommendations() {
    const product = randomChoice(products)
    const span = tracer.startSpan('user_get_recommendations', { 'product.id': product })
    http.get(
        `${BASE_URL}/api/recommendations?productIds=${product}`,
        { headers: otelHeaders(span.traceParent()) }
    )
    span.end()
}

function getProductReviews() {
    const product = randomChoice(products)
    const span = tracer.startSpan('user_get_product_reviews', { 'product.id': product })
    http.get(`${BASE_URL}/api/product-reviews/${product}`, { headers: otelHeaders(span.traceParent()) })
    span.end()
}

function askProductAiAssistant() {
    const product = randomChoice(products)
    const question = 'Can you summarize the product reviews?'
    const span = tracer.startSpan('user_ask_product_ai_assistant', { 'product.id': product, question })
    http.post(
        `${BASE_URL}/api/product-ask-ai-assistant/${product}`,
        JSON.stringify({ question }),
        { headers: otelHeaders(span.traceParent(), { 'Content-Type': 'application/json' }) }
    )
    span.end()
}

function getAds() {
    const category = randomChoice(categories)
    const span = tracer.startSpan('user_get_ads', { category: String(category) })
    const url = category !== null
        ? `${BASE_URL}/api/data/?contextKeys=${category}`
        : `${BASE_URL}/api/data/`
    http.get(url, { headers: otelHeaders(span.traceParent()) })
    span.end()
}

function viewCart() {
    const span = tracer.startSpan('user_view_cart')
    http.get(`${BASE_URL}/api/cart`, { headers: otelHeaders(span.traceParent()) })
    span.end()
}

function addToCart() {
    const user = uuid4()
    const product = randomChoice(products)
    const quantity = randomChoice([1, 2, 3, 4, 5, 10])
    const span = tracer.startSpan('user_add_to_cart', { 'user.id': user, 'product.id': product, quantity })
    const h = otelHeaders(span.traceParent())
    http.get(`${BASE_URL}/api/products/${product}`, { headers: h })
    http.post(
        `${BASE_URL}/api/cart`,
        JSON.stringify({ item: { productId: product, quantity }, userId: user }),
        { headers: otelHeaders(span.traceParent(), { 'Content-Type': 'application/json' }) }
    )
    span.end()
}

// checkout and checkoutMulti inline the cart-addition logic so all HTTP calls
// share the same parent span, matching how Locust nests add_to_cart inside
// the checkout context.

function checkout() {
    const user = uuid4()
    const span = tracer.startSpan('user_checkout_single', { 'user.id': user })
    const h = otelHeaders(span.traceParent())
    const json = { 'Content-Type': 'application/json' }

    const product = randomChoice(products)
    const quantity = randomChoice([1, 2, 3, 4, 5, 10])
    http.get(`${BASE_URL}/api/products/${product}`, { headers: h })
    http.post(
        `${BASE_URL}/api/cart`,
        JSON.stringify({ item: { productId: product, quantity }, userId: user }),
        { headers: otelHeaders(span.traceParent(), json) }
    )
    http.post(
        `${BASE_URL}/api/checkout`,
        JSON.stringify(Object.assign({}, randomChoice(people), { userId: user })),
        { headers: otelHeaders(span.traceParent(), json) }
    )
    span.end()
}

function checkoutMulti() {
    const user = uuid4()
    const itemCount = randomChoice([2, 3, 4])
    const span = tracer.startSpan('user_checkout_multi', { 'user.id': user, 'item.count': itemCount })
    const h = otelHeaders(span.traceParent())
    const json = { 'Content-Type': 'application/json' }

    for (let i = 0; i < itemCount; i++) {
        const product = randomChoice(products)
        const quantity = randomChoice([1, 2, 3, 4, 5, 10])
        http.get(`${BASE_URL}/api/products/${product}`, { headers: h })
        http.post(
            `${BASE_URL}/api/cart`,
            JSON.stringify({ item: { productId: product, quantity }, userId: user }),
            { headers: otelHeaders(span.traceParent(), json) }
        )
    }
    http.post(
        `${BASE_URL}/api/checkout`,
        JSON.stringify(Object.assign({}, randomChoice(people), { userId: user })),
        { headers: otelHeaders(span.traceParent(), json) }
    )
    span.end()
}

function floodHome() {
    const floodCount = getFlagdValue('loadGeneratorFloodHomepage')
    if (floodCount <= 0) return

    const span = tracer.startSpan('user_flood_home', { 'flood.count': floodCount })
    const h = otelHeaders(span.traceParent())
    for (let i = 0; i < floodCount; i++) {
        http.get(`${BASE_URL}/`, { headers: h })
    }
    span.end()
}

// ---- weighted task selection ------------------------------------------------
// Mirrors Locust @task weights: index(1) browse(10) recs(3) reviews(2)
// ai(1) ads(3) cart(3) add(2) checkout(1) checkout_multi(1) flood(5) = 32

const weightedTasks = [
    { cumWeight:  1, task: index },
    { cumWeight: 11, task: browseProduct },
    { cumWeight: 14, task: getRecommendations },
    { cumWeight: 16, task: getProductReviews },
    { cumWeight: 17, task: askProductAiAssistant },
    { cumWeight: 20, task: getAds },
    { cumWeight: 23, task: viewCart },
    { cumWeight: 25, task: addToCart },
    { cumWeight: 26, task: checkout },
    { cumWeight: 27, task: checkoutMulti },
    { cumWeight: 32, task: floodHome },
]

function selectTask() {
    const r = Math.random() * 32
    for (const { cumWeight, task } of weightedTasks) {
        if (r < cumWeight) return task
    }
    return floodHome
}

// ---- HTTP entrypoint --------------------------------------------------------

export function httpScenario() {
    if (sessionId === null) {
        onStart()
    }

    selectTask()()

    sleep(Math.random() * 9 + 1)  // mirrors Locust between(1, 10)
}

// ---- browser tasks ----------------------------------------------------------

async function changeCurrency(page) {
    await page.goto(`${BASE_URL}/cart`, { waitUntil: 'domcontentloaded' })
    await page.selectOption('[name="currency_code"]', 'CHF')
    await page.waitForTimeout(2000)
}

async function addProductToCartBrowser(page) {
    await page.goto(`${BASE_URL}/`, { waitUntil: 'domcontentloaded' })
    await page.waitForSelector('p:has-text("Roof Binoculars")', { timeout: 15000 })
    await page.click('p:has-text("Roof Binoculars")')
    await page.waitForLoadState('domcontentloaded')
    await page.click('button:has-text("Add To Cart")')
    await page.waitForLoadState('domcontentloaded')
    await page.waitForTimeout(2000)
}

// ---- browser entrypoint -----------------------------------------------------

export async function browserScenario() {
    const page = await browser.newPage()
    try {
        // Mirror the Locust add_baggage_header route interceptor
        await page.setExtraHTTPHeaders({ baggage: 'synthetic_request=true' })

        // Two tasks with equal weight, matching Locust's default @task weight of 1
        if (Math.random() < 0.5) {
            await changeCurrency(page)
        } else {
            await addProductToCartBrowser(page)
        }
    } catch (e) {
        console.error(`browser task error: ${e}`)
    } finally {
        await page.close()
    }

    sleep(Math.random() * 9 + 1)
}
