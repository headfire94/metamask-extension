const fs = require('fs')
const path = require('path')
const mkdirp = require('mkdirp')
const pify = require('pify')
const assert = require('assert')

const {
  delay,
  getExtensionIdPuppeteer,
  getExtensionIdChrome,
  getExtensionIdFirefox,
  buildPuppeteerDriver,
  buildChromeWebDriver,
  buildFirefoxWebdriver,
  installWebExt,
} = require('./func')
const { until } = require('selenium-webdriver')
const fetchMockResponses = require('./fetch-mocks.json')

const tinyDelayMs = 200
const regularDelayMs = tinyDelayMs * 2
const largeDelayMs = regularDelayMs * 2

module.exports = {
  assertElementNotPresent,
  checkBrowserForConsoleErrors,
  closeAllWindowHandlesExcept,
  findElement,
  findElements,
  openNewPage,
  switchToWindowWithTitle,
  switchToWindowWithUrlThatMatches,
  verboseReportOnFailure,
  waitUntilXWindowHandles,
  setupFetchMocking,
  prepareExtensionForTesting,
  tinyDelayMs,
  regularDelayMs,
  largeDelayMs,
}


async function prepareExtensionForTesting ({ responsive } = {}) {
  let driver, extensionId
  const targetBrowser = process.env.BROWSER

  switch (targetBrowser) {
    case 'chrome':
      const extPath = path.resolve('dist/chrome')
      driver = await buildChromeWebDriver(extPath)
      extensionId = await getExtensionIdPuppeteer(driver)
      break
    default: {
      throw new Error(`prepareExtensionForTesting - unable to prepare extension for unknown browser "${targetBrowser}"`)
    }
  }
  switch (targetBrowser) {
    case 'chrome':
      const pages = await driver.pages()
      await pages[0].close()
      await pages[1].close()
      return { driver, extensionId }
    default:
      throw new Error('Select chrome')
  }
}

async function setupFetchMocking (driver) {
  // define fetchMocking script, to be evaluated in the browser
  function fetchMocking (fetchMockResponses) {
    window.origFetch = window.fetch.bind(window)
    window.fetch = async (...args) => {
      const url = args[0]
      if (url === 'https://ethgasstation.info/json/ethgasAPI.json') {
        return { json: async () => clone(fetchMockResponses.ethGasBasic) }
      } else if (url === 'https://ethgasstation.info/json/predictTable.json') {
        return { json: async () => clone(fetchMockResponses.ethGasPredictTable) }
      } else if (url.match(/chromeextensionmm/)) {
        return { json: async () => clone(fetchMockResponses.metametrics) }
      } else if (url === 'https://dev.blockscale.net/api/gasexpress.json') {
        return { json: async () => clone(fetchMockResponses.gasExpress) }
      }
      return window.origFetch(...args)
    }
    if (window.chrome && window.chrome.webRequest) {
      window.chrome.webRequest.onBeforeRequest.addListener(cancelInfuraRequest, {urls: ['https://*.infura.io/*']}, ['blocking'])
    }
    function cancelInfuraRequest (requestDetails) {
      console.log(`fetchMocking - Canceling request: "${requestDetails.url}"`)
      return { cancel: true }
    }
    function clone (obj) {
      return JSON.parse(JSON.stringify(obj))
    }
  }
  // fetchMockResponses are parsed last minute to ensure that objects are uniquely instantiated
  const fetchMockResponsesJson = JSON.stringify(fetchMockResponses)
  // eval the fetchMocking script in the browser
  await driver.executeScript(`(${fetchMocking})(${fetchMockResponsesJson})`)
}

async function checkBrowserForConsoleErrors (driver) {
  const ignoredLogTypes = ['WARNING']
  const ignoredErrorMessages = [
    // React throws error warnings on "dataset", but still sets the data-* properties correctly
    'Warning: Unknown prop `dataset` on ',
    // Third-party Favicon 404s show up as errors
    'favicon.ico - Failed to load resource: the server responded with a status of 404 (Not Found)',
    // React Development build - known issue blocked by test build sys
    'Warning: It looks like you\'re using a minified copy of the development build of React.',
    // Redux Development build - known issue blocked by test build sys
    'This means that you are running a slower development build of Redux.',
  ]
  const browserLogs = await driver.manage().logs().get('browser')
  const errorEntries = browserLogs.filter(entry => !ignoredLogTypes.includes(entry.level.toString()))
  const errorObjects = errorEntries.map(entry => entry.toJSON())
  return errorObjects.filter(entry => !ignoredErrorMessages.some(message => entry.message.includes(message)))
}

async function verboseReportOnFailure (driver, test) {
  let screenshot

  const artifactDir = `./test-artifacts/${test.title}`
  const filepathBase = `${artifactDir}/test-failure`
  await pify(mkdirp)(artifactDir)

  switch (process.env.BROWSER) {
    case 'chrome':
      screenshot = await driver.screenshot({ path: `${filepathBase}-screenshot.png`, fullPage: true })
      await pify(fs.writeFile)(`${filepathBase}-screenshot.png`, screenshot, { encoding: 'base64' })
      // const htmlSource = await driver.getPageSource()
      // await pify(fs.writeFile)(`${filepathBase}-dom.html`, htmlSource)
      // artifactDir = `./test-artifacts/${test.title}`
      // const filepathBase = `${artifactDir}/test-failure`
      break
    default:
      break
  }
  // if (process.env.SELENIUM_BROWSER === 'chrome') {
  //   artifactDir = `./test-artifacts/chrome/${test.title}`
  // } else if (process.env.SELENIUM_BROWSER === 'firefox') {
  //   artifactDir = `./test-artifacts/firefox/${test.title}`
  // }
  // const filepathBase = `${artifactDir}/test-failure`
  // await pify(mkdirp)(artifactDir)
  // const screenshot = await driver.takeScreenshot()
  // await pify(fs.writeFile)(`${filepathBase}-screenshot.png`, screenshot, { encoding: 'base64' })
  // const htmlSource = await driver.getPageSource()
  // await pify(fs.writeFile)(`${filepathBase}-dom.html`, htmlSource)
}

async function findElement (driver, by, timeout = 10000) {
  return driver.wait(until.elementLocated(by), timeout)
}

async function findElements (driver, by, timeout = 10000) {
  return driver.wait(until.elementsLocated(by), timeout)
}

async function openNewPage (driver, url) {
  await driver.executeScript('window.open()')
  await delay(1000)

  const handles = await driver.getAllWindowHandles()
  const lastHandle = handles[handles.length - 1]
  await driver.switchTo().window(lastHandle)

  await driver.get(url)
  await delay(1000)
}

async function waitUntilXWindowHandles (driver, x, delayStep = 1000, timeout = 5000) {
  let timeElapsed = 0
  async function _pollWindowHandles () {
    const windowHandles = await driver.getAllWindowHandles()
    if (windowHandles.length === x) {
      return
    }
    await delay(delayStep)
    timeElapsed += delayStep
    if (timeElapsed > timeout) {
      throw new Error('waitUntilXWindowHandles timed out polling window handles')
    } else {
      await _pollWindowHandles()
    }
  }
  return await _pollWindowHandles()
}

async function switchToWindowWithTitle (driver, title, windowHandles) {
  if (!windowHandles) {
    windowHandles = await driver.getAllWindowHandles()
  } else if (windowHandles.length === 0) {
    throw new Error('No window with title: ' + title)
  }
  const firstHandle = windowHandles[0]
  await driver.switchTo().window(firstHandle)
  const handleTitle = await driver.getTitle()

  if (handleTitle === title) {
    return firstHandle
  } else {
    return await switchToWindowWithTitle(driver, title, windowHandles.slice(1))
  }
}

/**
 * Closes all windows except those in the given list of exceptions
 * @param {object} driver the WebDriver instance
 * @param {string|Array<string>} exceptions the list of window handle exceptions
 * @param {Array?} windowHandles the full list of window handles
 * @returns {Promise<void>}
 */
async function closeAllWindowHandlesExcept (driver, exceptions, windowHandles) {
  exceptions = typeof exceptions === 'string' ? [ exceptions ] : exceptions
  windowHandles = windowHandles || await driver.getAllWindowHandles()
  const lastWindowHandle = windowHandles.pop()
  if (!exceptions.includes(lastWindowHandle)) {
    await driver.switchTo().window(lastWindowHandle)
    await delay(1000)
    await driver.close()
    await delay(1000)
  }
  return windowHandles.length && await closeAllWindowHandlesExcept(driver, exceptions, windowHandles)
}

async function assertElementNotPresent (webdriver, driver, by) {
  let dataTab
  try {
    dataTab = await findElement(driver, by, 4000)
  } catch (err) {
    assert(err instanceof webdriver.error.NoSuchElementError || err instanceof webdriver.error.TimeoutError)
  }
  assert.ok(!dataTab, 'Found element that should not be present')
}

async function switchToWindowWithUrlThatMatches (driver, regexp, windowHandles) {
  if (!windowHandles) {
    windowHandles = await driver.getAllWindowHandles()
  } else if (windowHandles.length === 0) {
    throw new Error('No window that matches: ' + regexp)
  }
  const firstHandle = windowHandles[0]
  await driver.switchTo().window(firstHandle)
  const windowUrl = await driver.getCurrentUrl()
  if (windowUrl.match(regexp)) {
    return firstHandle
  } else {
    return await switchToWindowWithUrlThatMatches(driver, regexp, windowHandles.slice(1))
  }
}
